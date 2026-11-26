import type { E2EConfig } from "e2e";

export default {
  targets: [{ name: "ios", platform: "ios" }],
  workers: 1,
  trace: "on",
} satisfies E2EConfig;
