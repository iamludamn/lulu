import { resolve } from "node:path";
import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";
import { workerCommand } from "./e2e.worker";
import { serverURL } from "./tests/ios/server-url";

const device = process.env.E2E_IOS_DEVICE;
if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(device ?? "")) {
  throw new Error("Set E2E_IOS_DEVICE to a disposable iOS simulator UDID. This suite clears Lulu's app data.");
}
process.env.AGENT_DEVICE_HOME ??= resolve(".e2e/ios/agent-device");

export default {
  tests: "tests/ios/*.e2e.ts",
  targets: [{
    name: "ios",
    engine: mobile({ platform: "ios", device }),
    app: {
      bundleId: "com.zenlix.pistack",
      appPath: process.env.E2E_IOS_APP_PATH ?? ".e2e/ios-build/Build/Products/Debug-iphonesimulator/Lulu.app",
      command: workerCommand(new URL(serverURL).port, "lulu-ios-local-only", ".e2e/ios/logs/worker.log"),
      readyUrl: serverURL,
    },
  }],
  workers: 1,
  retries: 0,
  launchTimeout: 180_000,
  actionTimeout: 15_000,
  assertionTimeout: 10_000,
  output: ".e2e/ios",
  reporters: ["list", "junit"],
} satisfies E2EConfig;
