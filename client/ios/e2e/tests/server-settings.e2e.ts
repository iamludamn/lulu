import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, test } from "e2e";

const execFileAsync = promisify(execFile);
const bundleId = "com.zenlix.pistack.e2e";

interface Node {
  ref?: string;
  kind: string;
  label?: string;
  placeholder?: string;
  enabled?: boolean;
}

async function device(...args: string[]) {
  const command = process.env.LULU_AGENT_DEVICE;
  if (!command) throw new Error("Set LULU_AGENT_DEVICE to the device-bound agent-device executable.");

  const { stdout } = await execFileAsync(command, [...args, "--json"], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function snapshot(): Promise<Node[]> {
  const { data } = await device("snapshot");
  return data.nodes;
}

async function fill(kind: string, value: string) {
  const nodes = (await snapshot()).filter((node) => node.kind === kind);
  const ref = nodes.length === 1 && nodes[0].ref;
  if (!ref) throw new Error(`Expected one ${kind} in the server form, found ${nodes.length}.`);
  await device("fill", `@${ref}`, value, "--settle");
}

async function connectButton() {
  return (await snapshot()).find((node) => node.kind === "button" && node.label === "连接");
}

describe("iOS server settings", () => {
  beforeEach(async () => {
    await device("open", bundleId, "--relaunch", "--foreground",
      "--launch-args=-lulu.server", "--launch-args=", "--timeout", "90000");
    await expect.poll(async () => Boolean(await connectButton()), { timeout: 15_000 }).toBe(true);
  });

  test("opens the server form with Connect disabled", async () => {
    const nodes = await snapshot();

    expect(nodes.find((node) => node.kind === "text-field")?.placeholder).toBe("https://example.com");
    expect(nodes.find((node) => node.kind === "securetextfield")?.placeholder).toBe("连接令牌");
    expect(nodes.find((node) => node.kind === "button" && node.label === "连接")?.enabled).toBe(false);
  });

  test("enables Connect after entering an HTTPS address", async () => {
    await fill("text-field", "https://lulu.example.invalid");

    await expect.poll(async () => (await connectButton())?.enabled).toBe(true);
  });

  test("disables Connect when an HTTP address has a token", async () => {
    await fill("text-field", "http://127.0.0.1:1");
    await expect.poll(async () => (await connectButton())?.enabled).toBe(true);

    await fill("securetextfield", "fixture-token");

    await expect.poll(async () => (await connectButton())?.enabled).toBe(false);
  });

  test("shows an offline message when the service is unreachable", async () => {
    await fill("text-field", "http://127.0.0.1:1");
    const button = await connectButton();
    if (!button?.ref || button.enabled !== true) throw new Error("Connect must be available.");

    await device("press", `@${button.ref}`, "--settle");

    await expect.poll(async () => (await snapshot()).map((node) => node.label), {
      timeout: 30_000,
    }).toContain("暂时无法连接 lulu");
  });
});
