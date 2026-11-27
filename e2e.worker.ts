import { delimiter, resolve } from "node:path";

export function workerCommand(port: string, adminToken: string, log: string) {
  return {
    executable: "sh",
    args: ["scripts/start-e2e-worker.sh", port],
    env: {
      PATH: [resolve("node_modules/.bin"), process.env.PATH].join(delimiter),
      LULU_E2E_ADMIN_TOKEN: adminToken,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    log,
  };
}
