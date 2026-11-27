import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";
import { workerCommand } from "./e2e.worker";

const adminToken = "lulu-e2e-local-only";

export default {
  tests: ["tests/**/*.e2e.ts", "!tests/bugbash/**", "!tests/ios/**"],
  targets: [{
    name: "web",
    engine: web(),
    app: {
      url: "http://127.0.0.1:0",
      command: workerCommand("{port}", adminToken, ".e2e/logs/worker.log"),
    },
  }],
  secrets: { "local-admin": adminToken },
  retries: 0,
  reporters: ["list", "junit"],
} satisfies E2EConfig;
