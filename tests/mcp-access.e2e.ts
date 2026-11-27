import { describe, test } from "@e2e-dev/web";
import { expect, secrets } from "e2e";

test.setup("unlock the local MCP registry", { sessions: ["mcp-admin"] }, async ({ app, screen, session }) => {
  await app.open("/mcp");
  await screen.getByLabel("管理口令").fill(secrets.get("local-admin"));
  await screen.getByRole("button", "进入配置").tap();
  await expect(screen.getByRole("heading", "从一个连接开始")).toBeVisible();
  await session.save("mcp-admin");
});

describe("MCP configuration access", () => {
  test("keeps submission disabled with an empty management token", async ({ app, screen }) => {
    await app.open("/mcp");

    await expect(screen.getByRole("button", "进入配置")).toBeDisabled();
  });

  test("explains that the management token was rejected", async ({ app, screen }) => {
    await app.open("/mcp");

    await screen.getByLabel("管理口令").fill("incorrect-fixture-token");
    await screen.getByRole("button", "进入配置").tap();

    await expect(screen.getByText("口令不正确，请重新输入。")).toBeVisible();
  });
});

describe("Unlocked MCP configuration", { session: "mcp-admin" }, () => {
  test("reopens the registry with the saved token", async ({ app, screen }) => {
    await app.open("/mcp");

    await expect(screen.getByRole("heading", "从一个连接开始")).toBeVisible();
  });

  test("requires the management token after locking and reloading", async ({ app, browser, screen }) => {
    await app.open("/mcp");
    await screen.getByRole("heading", "从一个连接开始").waitFor();

    await screen.getByRole("button", "锁定配置页").tap();
    await browser.reload();

    await expect(screen.getByLabel("管理口令")).toBeVisible();
  });
});
