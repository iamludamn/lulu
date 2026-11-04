import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";

export type SandboxBinding = { key: string | null; owner: ConversationId | null; id: string | null; cwd: string; epoch: number };

export const SandboxDoc = defineDoc<SandboxBinding>({
  kind: "pistack.sandbox",
  version: 2,
  migrate: (value) => ({ owner: null, epoch: 0, ...value }) as unknown as SandboxBinding,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ key: null, owner: null, id: null, cwd: "", epoch: 0 }),
});
