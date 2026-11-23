import { spawnSync } from "node:child_process";

const languages = ["ts", "tsx", "js", "cpp", "py", "bash", "html", "css", "json", "yaml"];

for (const language of languages) {
  const run = spawnSync("ast-grep", [
    "run", "--lang", language, "--kind", "comment", "--no-ignore", "hidden", "--json=compact", ".",
  ], { encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status === 1 && !run.stderr) continue;
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }

  for (const { file, text, range } of JSON.parse(run.stdout)) {
    const { line, column } = range.start;
    if (line === 0 && column === 0 && (language === "bash" || language === "py") && text.startsWith("#!")) continue;
    console.error(`${file}:${line + 1}:${column + 1}: error no-comments: Remove the source comment.`);
    process.exitCode = 1;
  }
}
