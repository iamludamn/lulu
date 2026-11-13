import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const stubs = new Set(["http2", "vm", "cluster", "domain", "trace_events", "wasi", "_stream_wrap", "dgram", "inspector", "sqlite", "child_process", "readline", "repl", "tty", "v8", "worker_threads"]);
let failed = false;

async function check(directory, core) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await check(path, core);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    const source = parse(await readFile(path, "utf8"), { sourceType: "unambiguous", plugins: ["typescript", ...(entry.name.endsWith("x") ? ["jsx"] : [])] });
    function visit(node) {
      if (!node || typeof node !== "object") return;
      let specifier;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) specifier = node.source;
      if (node.type === "ImportExpression") specifier = node.source;
      if (node.type === "CallExpression" && (node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require"))) specifier = node.arguments[0];
      if (specifier && (specifier.type === "StringLiteral" || (specifier.type === "TemplateLiteral" && specifier.expressions.length === 0))) {
        const value = specifier.type === "StringLiteral" ? specifier.value : specifier.quasis[0].value.cooked;
        const name = value.replace(/^node:/, "");
        const restricted = core ? value.startsWith("cloudflare:") || value.startsWith("node:") || builtins.has(name) : stubs.has(name.split("/")[0]);
        if (restricted) {
          console.error(`${path}:${specifier.loc.start.line}:${specifier.loc.start.column + 1}: ${value} is not allowed in ${core ? "core; use a host abstraction" : "the Worker; use a supported runtime API"}`);
          failed = true;
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
      }
    }
    visit(source.program);
  }
}

await check("core/src", true);
await check("apps/cf/src", false);
if (failed) process.exitCode = 1;
