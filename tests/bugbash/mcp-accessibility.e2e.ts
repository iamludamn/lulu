import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("MCP configuration accessibility", { session: "mcp-admin", tags: ["bugbash"] }, () => {
  test("names the lock button at mobile widths", async ({ app, browser, screen }) => {
    await app.open("/mcp");
    const lock = screen.getByRole("banner").getByRole("button");
    await expect(lock).toHaveAccessibleName("锁定配置页");

    await browser.setViewport({ width: 390, height: 844 });

    await expect(lock).toHaveAccessibleName("锁定配置页");
  });

  test("returns keyboard focus to the catalog opener after Escape", async ({ app, browser, screen }) => {
    await browser.route("**/api/bots/main/mcp/catalog?*", (route) =>
      route.fulfill({ json: { servers: [], fetchedAt: 0, stale: false } }));
    await app.open("/mcp");
    const opener = screen.getByRole("button", "从目录添加");
    await opener.press("Enter");
    await screen.getByRole("dialog").waitFor();

    await browser.keyboard.press("Escape");

    await expect(screen.getByRole("dialog")).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
