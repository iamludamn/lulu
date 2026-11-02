import type { DurableHost } from "../host/types.js";
import type { BotRecord } from "./bots.js";

const BOT_PREFIX = "bot:";
const MIGRATED_KEY = "migrated";

const botKey = (id: string): string => `${BOT_PREFIX}${id}`;

export class RegistryObject {
  readonly #host: DurableHost;

  constructor(host: DurableHost) {
    this.#host = host;
  }

  async boot(): Promise<void> {
    await this.#migrate();
  }

  async list(): Promise<BotRecord[]> {
    const listed = await this.#host.storage.list<BotRecord>({ prefix: BOT_PREFIX });
    return [...listed.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Promise<BotRecord | undefined> {
    return this.#host.storage.get<BotRecord>(botKey(id));
  }

  async add(record: BotRecord): Promise<void> {
    await this.#host.storage.put({ [botKey(record.id)]: record });
  }

  async rename(id: string, name: string): Promise<BotRecord | undefined> {
    const record = await this.get(id);
    if (record === undefined) return undefined;
    const updated: BotRecord = { ...record, name };
    await this.#host.storage.put({ [botKey(id)]: updated });
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.#host.storage.delete(botKey(id));
  }

  async #migrate(): Promise<void> {
    if ((await this.#host.storage.get(MIGRATED_KEY)) === true) return;
    for (const key of await this.#host.kv.list(BOT_PREFIX)) {
      const value = await this.#host.kv.get(key);
      if (value !== null) await this.#host.storage.put({ [key]: JSON.parse(value) as BotRecord });
    }
    await this.#host.storage.put({ [MIGRATED_KEY]: true });
  }
}
