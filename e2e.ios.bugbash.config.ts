import type { E2EConfig } from "e2e";
import base from "./e2e.ios.config";

export default {
  ...base,
  tests: "tests/ios/bugbash/*.e2e.ts",
  output: ".e2e/ios/bugbash",
} satisfies E2EConfig;
