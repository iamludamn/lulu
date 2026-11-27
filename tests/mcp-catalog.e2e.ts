import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { McpCatalogPage } from "@lulu/core/protocol/mcp.js";

const emptyCatalog = { servers: [], fetchedAt: 0, stale: false } satisfies McpCatalogPage;

describe("MCP service catalog", { session: "mcp-admin" }, () => {
  test("explains the minimum search length for a short query", async ({ app, browser, screen }) => {
    await browser.route("**/api/bots/main/mcp/catalog?*", (route) => route.fulfill({ json: emptyCatalog }));
    await app.open("/mcp");
    await screen.getByRole("button", "从目录添加").tap();

    await screen.getByLabel("搜索服务目录").fill("中");

    await expect(screen.getByText("请输入至少 3 个字符搜索服务。")).toBeVisible();
  });

  test("shows a no-results message for an unmatched query", async ({ app, browser, screen }) => {
    await browser.route("**/api/bots/main/mcp/catalog?*", (route) => route.fulfill({
      json: new URL(route.request.url).searchParams.get("search") ? emptyCatalog : {
        ...emptyCatalog,
        servers: [{
          name: "example.test/board",
          title: "Board fixture",
          description: "A test-only catalog service",
          remotes: [{ url: "https://board.example.invalid/mcp", headers: [], variables: {} }],
        }],
      } satisfies McpCatalogPage,
    }));
    await app.open("/mcp");
    await screen.getByRole("button", "从目录添加").tap();
    await screen.getByRole("button", /Board fixture/).waitFor();

    await screen.getByLabel("搜索服务目录").fill("没有结果");

    await expect(screen.getByText("没有找到可连接的服务")).toBeVisible();
  });
});
