import { test } from "@e2e-dev/web";
import { expect, secrets } from "e2e";

test("rejects a wrong MCP admin token", async ({ app, screen }) => {
  await app.open("/mcp");
  await screen.getByLabel("管理口令").fill("wrong-e2e-token");
  await screen.getByRole("button", "进入配置").click();

  await expect(screen.getByText("口令不正确，请重新输入。")).toBeVisible();
  await expect(screen.getByRole("heading", "连接你的工具")).toBeHidden();
});

test("keeps the MCP configuration unlocked on reload until explicitly locked", async ({ app, browser, screen }) => {
  await app.open("/mcp");
  await screen.getByLabel("管理口令").fill(secrets.get("mcpAdminToken"));
  await screen.getByRole("button", "进入配置").click();
  await expect(screen.getByRole("heading", "从一个连接开始")).toBeVisible();

  await browser.reload();
  await expect(screen.getByRole("heading", "从一个连接开始")).toBeVisible();

  await screen.getByRole("button", "锁定配置页").click();
  await browser.reload();
  await expect(screen.getByLabel("管理口令")).toBeVisible();
  await expect(screen.getByRole("heading", "连接你的工具")).toBeHidden();
});
