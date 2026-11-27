import { describe, expect } from "e2e";
import { iosTest as test, serverURL } from "../fixture";

describe("iOS composer keyboard layout", { tags: ["bugbash"] }, () => {
  test("keeps Send above the keyboard when creating a component draft", async ({ app, device, screen }) => {
    await app.clearState();
    await screen.getByPlaceholder("https://example.com").fill(serverURL);
    await screen.getByRole("button", "连接").tap();
    const add = screen.getByRole("button", "添加组件");
    await add.waitFor();

    await add.tap();

    await expect(screen.getByRole("textbox")).toHaveValue("帮我在视图里加一个组件：");
    await expect.poll(() => device.isKeyboardShown()).toBe(true);
    await expect(screen.getByRole("button", "发送")).toBeVisible();
  });
});
