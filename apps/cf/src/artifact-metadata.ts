import type { ArtifactMetadataStore, ArtifactUpload, ArtifactVersion, DiscardedArtifact, UploadReservation } from "@lulu/core/artifact/metadata.js";

type UploadRow = Omit<ArtifactUpload, "committed"> & { committed: 0 | 1 };
type Binding = string | number | null;

const versionFields = "v.version, v.object_key AS key, v.size, v.content_type AS contentType";
const uploadFields = `id AS uploadId, name, version, object_key AS key, size, content_type AS contentType,
  committed, staged_key AS staged, base_version AS baseVersion`;
const migrated = "SELECT 1 FROM artifact_bots WHERE bot = ?1";
const liveHead = "latest_version > 0 AND deleted_at IS NULL";

function uploadFrom(row: UploadRow | null | undefined): ArtifactUpload | undefined {
  return row == null ? undefined : { ...row, committed: row.committed === 1 };
}

export class D1ArtifactMetadata implements ArtifactMetadataStore {
  readonly #db: D1Database;
  readonly #bot: string;
  readonly #legacy: () => Promise<Record<string, unknown>>;
  #ready: Promise<void> | undefined;

  constructor(db: D1Database, bot: string, legacy: () => Promise<Record<string, unknown>>) {
    this.#db = db;
    this.#bot = bot;
    this.#legacy = legacy;
  }

  #sql(query: string, ...bindings: Binding[]): D1PreparedStatement {
    return this.#db.prepare(query).bind(this.#bot, ...bindings);
  }

  #ensure(check = true): Promise<void> {
    return this.#ready ??= this.#initialize(check);
  }

  async #initialize(check: boolean): Promise<void> {
    if (check && await this.#sql(migrated).first() !== null) return;
    await importArtifactMetadata(this.#db, this.#bot, await this.#legacy());
  }

  async #read<T>(statement: D1PreparedStatement): Promise<T[]> {
    if (this.#ready === undefined) {
      const [marker, found] = await this.#db.batch<T>([this.#sql(migrated), statement]);
      if (marker.results.length > 0) {
        this.#ready ??= Promise.resolve();
        return found.results;
      }
      await this.#ensure(false);
    } else {
      await this.#ready;
    }
    return (await statement.all<T>()).results;
  }

  list(prefix: string, limit: number): Promise<(ArtifactVersion & { name: string })[]> {
    const glob = prefix.replace(/[[*?\]]/g, (char) => `[${char}]`) + "*";
    return this.#read(this.#sql(`SELECT h.name, ${versionFields}
      FROM artifact_heads h JOIN artifact_versions v
      ON (v.bot, v.name, v.version) = (h.bot, h.name, h.latest_version)
      WHERE h.bot = ?1 AND h.name GLOB ?2 AND ${liveHead}
      ORDER BY h.name LIMIT ?3`, glob, limit));
  }

  async versions(name: string): Promise<{ latest: number; entries: ArtifactVersion[] } | undefined> {
    const rows = await this.#read<ArtifactVersion & { latest: number }>(this.#sql(
      `SELECT h.latest_version AS latest, ${versionFields}
      FROM artifact_heads h JOIN artifact_versions v ON (v.bot, v.name) = (h.bot, h.name)
      WHERE h.bot = ?1 AND h.name = ?2 AND ${liveHead} ORDER BY v.version`, name,
    ));
    if (rows.length === 0) return;
    return { latest: rows[0].latest, entries: rows };
  }

  async version(name: string, version?: number): Promise<ArtifactVersion | undefined> {
    const rows = await this.#read<ArtifactVersion>(this.#sql(`SELECT ${versionFields}
      FROM artifact_versions v JOIN artifact_heads h ON (h.bot, h.name) = (v.bot, v.name)
      WHERE v.bot = ?1 AND v.name = ?2 AND v.version = coalesce(?3, h.latest_version)
        AND (?3 IS NOT NULL OR h.deleted_at IS NULL)`, name, version ?? null));
    return rows[0];
  }

  async request(id: string): Promise<ArtifactUpload | undefined> {
    const rows = await this.#read<UploadRow>(this.#sql(
      `SELECT ${uploadFields} FROM artifact_uploads WHERE bot = ?1 AND request_id = ?2`, id,
    ));
    return uploadFrom(rows[0]);
  }

  async upload(id: string): Promise<ArtifactUpload | undefined> {
    const rows = await this.#read<UploadRow>(this.#sql(
      `SELECT ${uploadFields} FROM artifact_uploads WHERE bot = ?1 AND id = ?2`, id,
    ));
    return uploadFrom(rows[0]);
  }

  async reserve(reservation: UploadReservation): Promise<ArtifactUpload> {
    await this.#ensure();
    const { name, size, contentType, quota } = reservation;
    const id = crypto.randomUUID();
    const requestId = reservation.requestId ?? null;
    const base = reservation.baseVersion ?? null;
    const staged = reservation.staged ? `uploads/${this.#bot}/${id}` : null;
    const [, found] = await this.#db.batch<UploadRow>([
      this.#sql(`INSERT INTO artifact_uploads
        (bot, id, name, version, object_key, size, content_type, staged_key, base_version, request_id)
        SELECT b.bot, ?2, ?3, coalesce(h.next_version, 1), ?4 || coalesce(h.next_version, 1), ?5, ?6, ?7, ?8, ?9
        FROM artifact_bots b LEFT JOIN artifact_heads h ON h.bot = b.bot AND h.name = ?3
        WHERE b.bot = ?1 AND b.used_bytes + ?5 <= ?10 AND (?8 IS NULL OR ?8 = h.latest_version)
        ON CONFLICT (bot, request_id) DO NOTHING`,
      id, name, `bots/${this.#bot}/${name}/v`, size, contentType, staged, base, requestId, quota),
      this.#sql(`SELECT ${uploadFields} FROM artifact_uploads WHERE bot = ?1 AND (id = ?2 OR request_id = ?3)`, id, requestId),
    ]);
    const upload = uploadFrom(found.results[0]);
    if (upload !== undefined) return upload;
    if (base !== null && base !== await this.#sql(
      "SELECT latest_version FROM artifact_heads WHERE bot = ?1 AND name = ?2", name,
    ).first<number>("latest_version")) throw new Error("artifact changed during edit; read it again");
    throw new Error("bot artifact quota exceeded");
  }

  async commit(upload: ArtifactUpload, size: number, quota: number): Promise<ArtifactVersion | undefined> {
    await this.#ensure();
    const { uploadId, key, staged } = upload;
    const [, , , , found] = await this.#db.batch<ArtifactVersion & { committed: 0 | 1 }>([
      this.#sql(`DELETE FROM artifact_uploads WHERE bot = ?1 AND id = ?2
        AND EXISTS (SELECT 1 FROM artifact_pending WHERE bot = ?1 AND id = ?2 AND NOT eligible)`, uploadId),
      this.#sql(`UPDATE artifact_uploads SET committed = 1, size = ?3
        WHERE bot = ?1 AND id = ?2 AND EXISTS (
          SELECT 1 FROM artifact_pending WHERE bot = ?1 AND id = ?2 AND eligible AND used_bytes - size + ?3 <= ?4
        )`, uploadId, size, quota),
      this.#sql(`INSERT OR REPLACE INTO artifact_garbage (bot, object_key)
        SELECT ?1, ?3 WHERE NOT EXISTS (SELECT 1 FROM artifact_uploads WHERE bot = ?1 AND id = ?2)`, uploadId, key),
      this.#sql(`INSERT OR REPLACE INTO artifact_garbage (bot, object_key)
        SELECT ?1, ?3 WHERE ?3 IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM artifact_uploads WHERE bot = ?1 AND id = ?2 AND committed = 0
        )`, uploadId, staged),
      this.#sql(`SELECT u.committed, ${versionFields} FROM artifact_uploads u
        LEFT JOIN artifact_versions v ON (v.bot, v.name, v.version) = (u.bot, u.name, u.version)
        WHERE u.bot = ?1 AND u.id = ?2`, uploadId),
    ]);
    const row = found.results[0];
    if (row?.committed === 0) throw new Error("bot artifact quota exceeded");
    return row?.key == null ? undefined : row;
  }

  async delete(name: string): Promise<boolean> {
    await this.#ensure();
    const head = `SELECT 1 FROM artifact_heads WHERE bot = ?1 AND name = ?2 AND ${liveHead}`;
    const [found] = await this.#db.batch([
      this.#sql(`SELECT 1 FROM artifact_heads WHERE bot = ?1 AND name = ?2 AND (latest_version > 0 OR deleted_at IS NOT NULL)`, name),
      this.#sql(`DELETE FROM artifact_versions WHERE bot = ?1 AND name = ?2 AND EXISTS (${head})`, name),
      this.#sql(`DELETE FROM artifact_uploads WHERE bot = ?1 AND name = ?2 AND committed = 0 AND EXISTS (${head})`, name),
      this.#sql(`UPDATE artifact_heads SET latest_version = 0, minimum_version = next_version, deleted_at = ?3
        WHERE bot = ?1 AND name = ?2 AND ${liveHead}`, name, Date.now()),
    ]);
    return found.results.length > 0;
  }

  discarded(limit: number): Promise<DiscardedArtifact[]> {
    return this.#read(this.#sql(
      "SELECT object_key AS key, token FROM artifact_garbage WHERE bot = ?1 ORDER BY object_key LIMIT ?2", limit,
    ));
  }

  async forgetDiscarded(entries: DiscardedArtifact[]): Promise<void> {
    await this.#ensure();
    await this.#sql(`DELETE FROM artifact_garbage WHERE bot = ?1 AND (object_key, token) IN (
      SELECT value ->> '$.key', value ->> '$.token' FROM json_each(?2)
    )`, JSON.stringify(entries)).run();
  }
}

type LegacyHead = { next: number; latest: number; minimumVersion?: number; deletedAt: number | null };
type LegacyVersion = ArtifactVersion & { createdAt: number };
type LegacyUpload = Omit<ArtifactUpload, "staged" | "baseVersion"> & { staged?: string; baseVersion?: number };

function appendImport<T>(
  db: D1Database, statements: D1PreparedStatement[], bot: string, token: string,
  table: string, columns: string, fields: string[], rows: T[],
): void {
  const values = fields.map((field) => `value ->> '$.${field}'`).join(", ");
  const query = `INSERT INTO ${table} (bot, ${columns})
    SELECT ?1, ${values} FROM json_each(?3)
    WHERE EXISTS (SELECT 1 FROM artifact_bots WHERE bot = ?1 AND import_token = ?2)`;
  for (let start = 0; start < rows.length; start += 200) {
    statements.push(db.prepare(query).bind(bot, token, JSON.stringify(rows.slice(start, start + 200))));
  }
}

async function importArtifactMetadata(db: D1Database, bot: string, source: Record<string, unknown>): Promise<void> {
  const token = crypto.randomUUID();
  const statements = [db.prepare(
    "INSERT INTO artifact_bots (bot, import_token) VALUES (?, ?) ON CONFLICT (bot) DO NOTHING",
  ).bind(bot, token)];
  const heads: (LegacyHead & { name: string; minimumVersion: number })[] = [];
  const versions: (LegacyVersion & { name: string })[] = [];
  const uploads: (LegacyUpload & { requestId?: string })[] = [];
  const discarded: { key: string }[] = [];
  const requests = new Map<unknown, string>();
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("req:")) requests.set(value, key.slice(4));
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("head:")) {
      const head = value as LegacyHead;
      heads.push({ ...head, name: key.slice(5), minimumVersion: head.minimumVersion ?? (head.deletedAt === null ? 1 : head.next) });
    } else if (key.startsWith("ver:")) {
      const version = value as LegacyVersion;
      versions.push({ ...version, name: key.slice(4, key.lastIndexOf(":")) });
    } else if (key.startsWith("upload:")) {
      const upload = value as LegacyUpload;
      uploads.push({ ...upload, requestId: requests.get(upload.uploadId) });
    } else if (key.startsWith("discard:")) {
      discarded.push({ key: value as string });
    }
  }
  appendImport(db, statements, bot, token, "artifact_heads", "name, next_version, latest_version, minimum_version, deleted_at",
    ["name", "next", "latest", "minimumVersion", "deletedAt"], heads);
  appendImport(db, statements, bot, token, "artifact_versions", "name, version, object_key, size, content_type, created_at",
    ["name", "version", "key", "size", "contentType", "createdAt"], versions);
  appendImport(db, statements, bot, token, "artifact_uploads",
    "id, name, version, object_key, size, content_type, staged_key, base_version, request_id, committed",
    ["uploadId", "name", "version", "key", "size", "contentType", "staged", "baseVersion", "requestId", "committed"], uploads);
  appendImport(db, statements, bot, token, "artifact_garbage", "object_key", ["key"], discarded);

  await db.batch(statements);
}
