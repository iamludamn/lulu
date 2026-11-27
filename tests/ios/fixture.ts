import { test } from "@e2e-dev/mobile";

export { serverURL } from "./server-url";

export const iosTest = test.extend<{}, { installed: boolean }>({
  installed: [async ({ device }, use) => {
    await device.installApp();
    await use(true);
  }, { scope: "worker", auto: true }],
});
