import { describe, expect, test } from "e2e";

describe("iOS server URL validation", { tags: ["bugbash"] }, () => {
  test("rejects FTP as a Lulu server scheme", async ({ app, screen }) => {
    await app.clearState();

    await screen.getByRole("textbox", "https://example.com").fill("ftp://127.0.0.1:9178");

    await expect(screen.getByRole("button", "连接")).toBeDisabled();
  });
});
