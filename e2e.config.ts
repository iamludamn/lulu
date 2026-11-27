import { delimiter, resolve } from "node:path";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const adminToken = "lulu-e2e-local-only";

export default {
  tests: ["tests/**/*.e2e.ts", "!tests/bugbash/**"],
  targets: [{
    name: "web",
    engine: web(),
    app: {
      url: "http://127.0.0.1:0",
      command: {
        executable: "sh",
        args: ["scripts/start-e2e-worker.sh", "{port}"],
        env: {
          PATH: [resolve("node_modules/.bin"), process.env.PATH].join(delimiter),
          LULU_E2E_ADMIN_TOKEN: adminToken,
          WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        },
        log: ".e2e/logs/worker.log",
      },
    },
  }],
  secrets: { "local-admin": adminToken },
  retries: 0,
  reporters: ["list", "junit"],
} satisfies E2EConfig;
