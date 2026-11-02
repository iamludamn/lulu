import type { DurableHost, ObjectStub } from "../host/types.js";

const MAX_NAME_CHARACTERS = 60;
const REGISTRY_NAME = "registry";

export interface BotRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface RegistryStub extends ObjectStub {
  list(): Promise<BotRecord[]>;
  get(id: string): Promise<BotRecord | undefined>;
  add(record: BotRecord): Promise<void>;
  rename(id: string, name: string): Promise<BotRecord | undefined>;
  remove(id: string): Promise<void>;
}

export function parseBotName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name === "" || Array.from(name).length > MAX_NAME_CHARACTERS ? undefined : name;
}

export function botStore(host: Pick<DurableHost, "objects">) {
  const registry = () => host.objects.REGISTRY.getByName(REGISTRY_NAME);
  return {
    list: (): Promise<BotRecord[]> => registry().list(),
    get: (id: string): Promise<BotRecord | undefined> => registry().get(id),
    add: (record: BotRecord): Promise<void> => registry().add(record),
    rename: (id: string, name: string): Promise<BotRecord | undefined> => registry().rename(id, name),
    remove: (id: string): Promise<void> => registry().remove(id),
  };
}
