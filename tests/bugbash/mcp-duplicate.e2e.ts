import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("Manual MCP connections", { session: "mcp-admin", tags: ["bugbash"] }, () => {
  test("preserves an existing connection when adding the same name", async ({ app, browser, screen }) => {
    const name = "duplicate-fixture";
    const original = "http://127.0.0.1:1/mcp";
    const replacement = "http://127.0.0.1:2/mcp";
    await browser.route("**/api/bots/main/mcp/catalog?*", (route) =>
      route.fulfill({ json: { servers: [], fetchedAt: 0, stale: false } }));
    await app.open("/mcp");
    const opener = screen.getByRole("button", "从目录添加");
    const manual = screen.getByRole("button", "手动添加");
    const address = screen.getByLabel("MCP 服务器地址");
    await opener.tap();
    await manual.tap();
    await screen.getByLabel("连接名称").fill(name);
    await address.fill(original);
    await screen.getByRole("button", "添加并连接").tap();
    await screen.getByText(original, { exact: true }).waitFor();

    await opener.tap();
    await manual.tap();
    await screen.getByLabel("连接名称").fill(name);
    await address.fill(replacement);
    const submit = screen.getByRole("button", "添加并连接");
    if (await submit.isEnabled()) {
      const saved = browser.waitForResponse({ method: "PUT", url: `**/mcp/servers/${name}` });
      await submit.tap();
      await saved;
    }

    const list = await browser.evaluate(async () => {
      const token = localStorage.getItem("lulu.mcp.token");
      const response = await fetch("/api/bots/main/mcp", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
      return response.json() as Promise<{ servers: { name: string; url: string }[] }>;
    });
    expect(list.servers.find((server) => server.name === name)?.url).toBe(original);
  });
});
