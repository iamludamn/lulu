import type { NoteContent, NoteCursor, NoteMutation, NoteRef, NoteRevision, NotesStore } from "@lulu/core/host/types.js";

type Row = { id: string; revision: number; updated_at: number; content: string };
const decode = (row: Row): NoteRevision => ({
  ...JSON.parse(row.content) as NoteContent,
  id: row.id, revision: row.revision, updatedAt: row.updated_at,
});

export class D1Notes implements NotesStore {
  readonly #db: D1Database;
  readonly #bot: string;

  constructor(db: D1Database, bot: string) {
    this.#db = db;
    this.#bot = bot;
  }

  async list(cursor?: NoteCursor) {
    const [notes, pins] = await this.#db.batch([
      this.#db.prepare(`SELECT id, revision, updated_at, content FROM note_revisions AS current
        WHERE bot = ?1 AND revision = (SELECT max(revision) FROM note_revisions WHERE bot = ?1 AND id = current.id)
          AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND id > ?3))
        ORDER BY updated_at DESC, id LIMIT 51`).bind(this.#bot, cursor?.updatedAt ?? null, cursor?.id ?? ""),
      this.#db.prepare("SELECT card_key FROM note_gallery_pins WHERE bot = ?1").bind(this.#bot),
    ]);
    const items = (notes.results as Row[]).slice(0, 50).map(decode);
    const last = notes.results.length > 50 ? items.at(-1) : undefined;
    return {
      notes: items,
      pinned: (pins.results as { card_key: string }[]).map((row) => row.card_key),
      ...(last && { next: { id: last.id, updatedAt: last.updatedAt } }),
    };
  }

  async read({ id, revision }: NoteRef) {
    const row = await this.#db.prepare("SELECT * FROM note_revisions WHERE bot = ? AND id = ? AND revision = ?")
      .bind(this.#bot, id.toLowerCase(), revision).first<Row>();
    return row ? decode(row) : undefined;
  }

  async write({ id, baseRevision, requestId, content }: NoteMutation) {
    id = id.toLowerCase();
    requestId = requestId.toLowerCase();
    const serialized = JSON.stringify({
      title: content.title,
      blocks: content.blocks.map(({ kind, id, ...data }) => {
        const blockId = id.toLowerCase();
        if (kind === "file" && "ref" in data) return { id: blockId, kind, ref: data.ref };
        if (kind === "check" && "done" in data) return { id: blockId, kind, text: data.text, done: data.done };
        return { id: blockId, kind, text: "text" in data ? data.text : "" };
      }),
      source: content.source,
    });
    const [, result] = await this.#db.batch<Row>([
      this.#db.prepare(`INSERT INTO note_revisions (bot, id, revision, request_id, updated_at, content)
        SELECT ?1, ?2, ?3 + 1, ?4, ?5, ?6
        WHERE ?3 = coalesce((SELECT max(revision) FROM note_revisions WHERE bot = ?1 AND id = ?2), 0)
        ON CONFLICT (bot, request_id) DO NOTHING`).bind(this.#bot, id, baseRevision, requestId, Date.now(), serialized),
      this.#db.prepare("SELECT * FROM note_revisions WHERE bot = ? AND request_id = ?").bind(this.#bot, requestId),
    ]);
    const row = result.results[0];
    return row?.id === id && row.revision === baseRevision + 1 && row.content === serialized ? decode(row) : undefined;
  }

  async pin(key: string, pinned: boolean) {
    await this.#db.prepare(pinned
      ? "INSERT OR IGNORE INTO note_gallery_pins (bot, card_key) VALUES (?, ?)"
      : "DELETE FROM note_gallery_pins WHERE bot = ? AND card_key = ?").bind(this.#bot, key).run();
  }
}
