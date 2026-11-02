import { defineDoc } from "@earendil-works/pi-durable";

export type SandboxBinding = { key: string | null; id: string | null; cwd: string };

export const SandboxDoc = defineDoc<SandboxBinding>({
  kind: "pistack.sandbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ key: null, id: null, cwd: "" }),
});
