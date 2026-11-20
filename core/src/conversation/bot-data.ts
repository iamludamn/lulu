import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { DocumentId, Harness, JsonObject, Storage, StorageWrite, Tx } from "@earendil-works/pi-durable";
import { CronJobsDoc } from "../cron/doc.js";
import { projectScheduleOverview } from "../cron/overview.js";
import { STORED_DOC_KINDS as kinds } from "../durable-names.js";
import type { DurableStorage } from "../host/types.js";
import { EMPTY_PANEL, type PanelState } from "../protocol/panel.js";
import type { AssetItem } from "../protocol/send.js";
import { AssetsDoc } from "../send/doc.js";
import { SpaceRefreshDoc, SpaceRefreshIndex, spaceStatus, type Refresh } from "../space/doc.js";
import { PanelDoc } from "../panel/doc.js";

const scope = { kind: "session" } as const;
const managed = [kinds.panel, kinds.assets, kinds.cronJobs, kinds.spaceRefreshIndex, kinds.spaceRefresh];
type Documents = Record<string, JsonObject>;
export type BotData = { documents: Documents };
export type StartupData = { panel: PanelState; assets: AssetItem[] };

export interface BotDataStore {
  readonly key: string;
  read(): Promise<BotData | undefined>;
  readStartup(): Promise<StartupData | undefined>;
  save(data: BotData): Promise<void>;
}

export const savedPanel = ({ documents }: BotData): PanelState | undefined => documents[kinds.panel] as PanelState | undefined;
export const savedJobs = ({ documents }: BotData) => (documents[kinds.cronJobs] as ReturnType<typeof CronJobsDoc.definition.initial> | undefined)?.jobs ?? [];
export const savedSpace = ({ documents }: BotData, id: string): Refresh | undefined =>
  (documents[kinds.spaceRefresh + ":" + id] as ReturnType<typeof SpaceRefreshDoc.definition.initial> | undefined)?.entry;

export function startupData(data: BotData): StartupData {
  const panel = savedPanel(data) ?? EMPTY_PANEL;
  const { documents } = data;
  const assets = documents[kinds.assets] as { items: AssetItem[] } | undefined;
  const spaceUpdates = Object.fromEntries(panel.order.flatMap((id) => {
    const entry = savedSpace(data, id);
    return entry === undefined ? [] : [[id, spaceStatus(entry)]];
  }));
  return { panel: { ...projectScheduleOverview(panel, savedJobs(data)), spaceUpdates }, assets: assets?.items ?? [] };
}

/** Keep Pi Durable's transaction semantics for the live copies. Acknowledge a changed app document only
 * after the independent copy is written, and close the crash window with a small pending marker. */
export class BotDataPersistence {
  readonly storage: Storage;
  readonly #marker: string;
  readonly #ids = new Set<DocumentId>();
  #enabled = false;

  constructor(private readonly sqlite: Storage, private readonly native: DurableStorage, private readonly external: BotDataStore) {
    this.#marker = "bot-data:" + external.key;
    this.storage = new Proxy(sqlite, {
      get: (target, key) => {
        if (key === "commit") return this.#commit.bind(this);
        const property: unknown = Reflect.get(target, key);
        return typeof property === "function" ? property.bind(target) : property;
      },
    });
  }

  async start(harness: Pick<Harness, "commit">): Promise<void> {
    const marker = await this.native.get<string>(this.#marker);
    if (marker === undefined) {
      const saved = await this.external.read();
      if (saved === undefined) await this.external.save({ documents: await this.#readLocal(true) });
      else {
        await harness.commit((tx) => restore(tx, saved.documents), context);
        await this.#readLocal(false);
        await this.external.save(saved);
      }
      await this.native.put({ [this.#marker]: "ready" });
    } else if (marker === "pending") {
      await this.#publish();
    } else {
      await this.#readLocal(false);
    }
    this.#enabled = true;
  }

  async #readLocal(values: boolean): Promise<Documents> {
    const documents: Documents = {};
    this.#ids.clear();
    for (const kind of managed) {
      let cursor;
      do {
        const page = await this.sqlite.scanDocuments({ scope, kind, at: "current" }, 100, cursor, context);
        for (const record of page.items) {
          this.#ids.add(record.id);
          if (values) {
            const stored = await this.sqlite.document(record.id, "current", context);
            if (stored !== undefined) documents[record.key === undefined ? kind : kind + ":" + record.key] = stored.value;
          }
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    return documents;
  }

  async #publish(): Promise<void> {
    await this.external.save({ documents: await this.#readLocal(true) });
    await this.native.put({ [this.#marker]: "ready" });
  }

  #managed(write: StorageWrite): boolean {
    switch (write.type) {
      case "document.create":
      case "document.copy":
        return write.record.scope.kind === "session" && managed.some((kind) => kind === write.record.kind);
      case "document.change":
      case "document.retire":
        return this.#ids.has(write.id);
      default:
        return false;
    }
  }

  async #commit(...[batches, receive, ctx]: Parameters<Storage["commit"]>): ReturnType<Storage["commit"]> {
    if (!this.#enabled || !batches.some((batch) => batch.some((write) => this.#managed(write)))) {
      return this.sqlite.commit(batches, receive, ctx);
    }
    await this.native.put({ [this.#marker]: "pending" });
    const receipts: Parameters<typeof receive>[] = [];
    const result = await this.sqlite.commit(batches, (...receipt) => receipts.push(receipt), ctx);
    await this.#publish();
    for (const receipt of receipts) receive(...receipt);
    return result;
  }
}

async function restore(tx: Tx, documents: Documents): Promise<void> {
  if (documents[kinds.panel]) replace(await tx.doc(PanelDoc), documents[kinds.panel]);
  if (documents[kinds.assets]) replace(await tx.doc(AssetsDoc), documents[kinds.assets]);
  if (documents[kinds.cronJobs]) replace(await tx.doc(CronJobsDoc), documents[kinds.cronJobs]);
  if (documents[kinds.spaceRefreshIndex]) replace(await tx.doc(SpaceRefreshIndex), documents[kinds.spaceRefreshIndex]);
  const prefix = kinds.spaceRefresh + ":";
  for (const [key, value] of Object.entries(documents)) {
    if (key.startsWith(prefix)) replace(await tx.doc(SpaceRefreshDoc, key.slice(prefix.length), null), value);
  }
}

function replace(target: JsonObject, source: JsonObject): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  Object.assign(target, source);
}
