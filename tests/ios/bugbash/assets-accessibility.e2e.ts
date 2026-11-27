import { describe, expect } from "e2e";
import { iosTest as test, serverURL } from "../fixture";

describe("iOS assets accessibility", { tags: ["bugbash"] }, () => {
  test("keeps the board-only add button out of the Assets accessibility tree", async ({ app, screen }) => {
    await app.clearState();
    await screen.getByPlaceholder("https://example.com").fill(serverURL);
    await screen.getByRole("button", "连接").tap();
    const add = screen.getByRole("button", "添加组件");
    await add.waitFor();

    await screen.getByRole("button", "资产").tap();

    await expect(screen.getByText("bot 发来的文件卡片，右滑就能收进这里。")).toBeVisible();
    await expect(add).toHaveCount(0);
  });
});
