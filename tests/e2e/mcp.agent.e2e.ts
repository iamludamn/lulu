import { expect, secrets, test } from "e2e";

test("locks the MCP configuration from a natural-language goal", async ({ agent, app, screen }) => {
  await app.open("/mcp");
  await screen.getByLabel("管理口令").fill(secrets.get("mcpAdminToken"));
  await screen.getByRole("button", "进入配置").click();
  await expect(screen.getByRole("heading", "从一个连接开始")).toBeVisible();

  await agent.act("锁定配置页，让页面重新显示管理口令输入框。");

  await expect(screen.getByLabel("管理口令")).toBeVisible();
  await expect(screen.getByRole("heading", "连接你的工具")).toBeHidden();
});
