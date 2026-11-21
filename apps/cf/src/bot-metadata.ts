import type { BotData, BotDataRead } from "@lulu/core/conversation/bot-data.js";
import type { ScheduledJob } from "@lulu/core/cron/schedule.js";
import type { STORED_DOC_KINDS } from "@lulu/core/durable-names.js";
import type { Refresh } from "@lulu/core/space/doc.js";

type Keys = Pick<typeof STORED_DOC_KINDS, "panel" | "cronJobs" | "spaceRefresh">;
type Row = { document_key: string; data: string; position: number | null };

function batches(rows: readonly unknown[][]): string[] {
  const result: string[] = [];
  const encoder = new TextEncoder();
  let parts: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const part = JSON.stringify(row);
    const size = encoder.encode(part).length + 1;
    // Leave room below D1's 2 MB bound value limit for the JSON array.
    if (parts.length > 0 && bytes + size > 1_900_000) {
      result.push("[" + parts.join(",") + "]");
      parts = [];
      bytes = 0;
    }
    parts.push(part);
    bytes += size;
  }
  if (parts.length > 0) result.push("[" + parts.join(",") + "]");
  return result;
}

export class D1BotMetadata {
  readonly #db: D1Database;
  readonly #bot: string;
  readonly #keys: Keys;

  constructor(db: D1Database, bot: string, keys: Keys) {
    this.#db = db;
    this.#bot = bot;
    this.#keys = keys;
  }

  async read(filter?: BotDataRead): Promise<BotData | undefined> {
    const { panel, cronJobs, spaceRefresh } = this.#keys;
    const marker = "SELECT '' AS document_key, '' AS data, NULL AS position FROM bot_metadata WHERE bot = ?1";
    const docs = "SELECT document_key, data, NULL AS position FROM bot_documents WHERE bot = ?1";
    const jobs = "SELECT ?2 AS document_key, data, position FROM bot_schedules WHERE bot = ?1";
    let statement: D1PreparedStatement;
    if (filter === undefined) {
      statement = this.#db.prepare(`${marker} UNION ALL ${docs} UNION ALL ${jobs} ORDER BY position`).bind(this.#bot, cronJobs);
    } else if ("space" in filter) {
      statement = this.#db.prepare(`${marker} UNION ALL ${docs} AND document_key IN (?2, ?3)`)
        .bind(this.#bot, panel, spaceRefresh + ":" + filter.space);
    } else {
      statement = this.#db.prepare(`
        ${marker}
        UNION ALL ${docs} AND document_key = ?3
        UNION ALL ${docs} AND space_due_at <= ?4
        UNION ALL ${jobs} AND state = 'active' AND next_run_at <= ?4
        ORDER BY position
      `).bind(this.#bot, cronJobs, panel, filter.cronAt);
    }
    const { results } = await statement.all<Row>();
    if (results.length === 0) return;
    const documents: BotData["documents"] = {};
    const schedule: ScheduledJob[] = [];
    for (const row of results) {
      if (row.document_key === "") continue;
      if (row.position === null) documents[row.document_key] = JSON.parse(row.data) as BotData["documents"][string];
      else schedule.push(JSON.parse(row.data) as ScheduledJob);
    }
    if (documents[cronJobs] !== undefined || schedule.length > 0) {
      documents[cronJobs] = { ...documents[cronJobs], jobs: schedule };
    }
    return { documents };
  }

  async write(data: BotData, changed?: readonly string[], fromLegacy = false): Promise<void> {
    const { cronJobs, spaceRefresh } = this.#keys;
    const token = crypto.randomUUID();
    const bind = (query: string, ...params: string[]) => this.#db.prepare(query).bind(this.#bot, token, ...params);
    const owner = "EXISTS (SELECT 1 FROM bot_metadata WHERE bot = ?1 AND publish_token = ?2)";
    const keys = changed ?? Object.keys(data.documents);
    const statements: D1PreparedStatement[] = [
      bind(`INSERT INTO bot_metadata (bot, publish_token) VALUES (?1, ?2)
        ON CONFLICT (bot) DO ${fromLegacy ? "NOTHING" : "UPDATE SET publish_token = excluded.publish_token"}`),
    ];
    const docs: unknown[][] = [];
    const removed: string[] = [];
    const schedule = (data.documents[cronJobs]?.jobs ?? []) as ScheduledJob[];
    for (const key of keys) {
      const document = data.documents[key];
      if (document === undefined) {
        removed.push(key);
      } else if (key === cronJobs) {
        const { jobs: _jobs, ...rest } = document;
        docs.push([key, rest, null]);
      } else {
        const entry = key.startsWith(spaceRefresh + ":") ? document.entry as Refresh | undefined : undefined;
        const dueAt = entry?.enabled && entry.mode.kind === "scheduled" && !entry.immediatePull ? entry.nextAt : null;
        docs.push([key, document, dueAt]);
      }
    }

    if (changed === undefined) {
      statements.push(bind(`DELETE FROM bot_documents WHERE bot = ?1 AND ${owner}
        AND document_key NOT IN (SELECT value FROM json_each(?3))`, JSON.stringify(keys)));
    } else if (removed.length > 0) {
      statements.push(bind(`DELETE FROM bot_documents WHERE bot = ?1 AND ${owner}
        AND document_key IN (SELECT value FROM json_each(?3))`, JSON.stringify(removed)));
    }
    for (const payload of batches(docs)) {
      statements.push(bind(`INSERT INTO bot_documents (bot, document_key, data, space_due_at)
        SELECT ?1, value ->> 0, value -> 1, value ->> 2 FROM json_each(?3) WHERE ${owner}
        ON CONFLICT (bot, document_key) DO UPDATE SET data = excluded.data, space_due_at = excluded.space_due_at
        WHERE data <> excluded.data OR space_due_at IS NOT excluded.space_due_at`, payload));
    }
    if (changed === undefined || keys.includes(cronJobs)) {
      statements.push(bind(`DELETE FROM bot_schedules WHERE bot = ?1 AND ${owner}
        AND id NOT IN (SELECT value FROM json_each(?3))`, JSON.stringify(schedule.map(({ id }) => id))));
      for (const payload of batches(schedule.map((job, position) => [job.id, position, job.state, job.nextRunAt, job]))) {
        statements.push(bind(`INSERT INTO bot_schedules (bot, id, position, state, next_run_at, data)
          SELECT ?1, value ->> 0, value ->> 1, value ->> 2, value ->> 3, value -> 4 FROM json_each(?3) WHERE ${owner}
          ON CONFLICT (bot, id) DO UPDATE SET position = excluded.position, state = excluded.state,
            next_run_at = excluded.next_run_at, data = excluded.data
          WHERE position <> excluded.position OR state <> excluded.state
            OR next_run_at IS NOT excluded.next_run_at OR data <> excluded.data`, payload));
      }
    }
    await this.#db.batch(statements);
  }
}
