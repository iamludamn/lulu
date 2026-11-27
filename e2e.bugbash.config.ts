import type { E2EConfig } from "e2e";
import base from "./e2e.config";

export default {
  ...base,
  tests: ["tests/mcp-access.e2e.ts", "tests/bugbash/**/*.e2e.ts"],
  output: ".e2e/bugbash/repro",
  workers: 1,
} satisfies E2EConfig;
