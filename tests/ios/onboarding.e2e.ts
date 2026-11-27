import { describe, expect } from "e2e";
import { iosTest as test, serverURL } from "./fixture";

describe("iOS server setup", () => {
  test.beforeEach(async ({ app }) => {
    await app.clearState();
  });

  test("requires a server address on first launch", async ({ screen }) => {
    await expect(screen.getByRole("button", "连接")).toBeDisabled();
  });

  test("connects to the server and opens the board", async ({ screen }) => {
    await screen.getByPlaceholder("https://example.com").fill(serverURL);

    await screen.getByRole("button", "连接").tap();

    await expect(screen.getByText("你的看板")).toBeVisible();
  });
});

describe("iOS workspace", () => {
  test.beforeEach(async ({ app, screen }) => {
    await app.clearState();
    await screen.getByPlaceholder("https://example.com").fill(serverURL);
    await screen.getByRole("button", "连接").tap();
    await screen.getByText("你的看板").waitFor();
  });

  test("opens the empty assets view from the page switcher", async ({ screen }) => {
    await screen.getByRole("button", "资产").tap();

    await expect(screen.getByText("bot 发来的文件卡片，右滑就能收进这里。")).toBeVisible();
  });

  test("prefills a chat draft from the board's add button", async ({ screen }) => {
    await screen.getByRole("button", "添加组件").tap();

    await expect(screen.getByRole("textbox")).toHaveValue("帮我在视图里加一个组件：");
  });
});
