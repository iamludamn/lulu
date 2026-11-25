import { deepSeek } from "@ai-sdk/deepseek";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const token = "lulu-e2e-test-admin";
const model = process.env.LULU_E2E_MODEL;

export default {
  tests: model ? "tests/e2e/*.e2e.ts" : ["tests/e2e/*.e2e.ts", "!tests/e2e/*.agent.e2e.ts"],
  targets: [{
    engine: web(),
    app: {
      url: "http://127.0.0.1:0",
      command: {
        executable: "bash",
        args: ["tests/e2e/serve.sh", "{port}"],
        env: { MCP_ADMIN_TOKEN: token, WRANGLER_SEND_METRICS: "false" },
        startupTimeout: 90_000,
      },
    },
  }],
  secrets: { mcpAdminToken: () => token },
  ...(model ? {
    agents: {
      default: {
        model: deepSeek(model),
        maxModelCalls: 5,
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      },
    },
  } : {}),
} satisfies E2EConfig;
