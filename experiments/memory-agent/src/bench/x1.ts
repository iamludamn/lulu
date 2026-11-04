import { mkdir } from "node:fs/promises";
import { openA, openB, type Exec } from "./backend.js";

const PRE = "rm -rf /work/p && mkdir -p /work/p && cd /work/p && ";
const GIT = "git init -q && git config user.email a@b.c && git config user.name n && ";

const PROBES: Record<string, string> = {
  "printf+cat": "printf 'a\\nb\\nc\\n' > f && cat f",
  heredoc: "cat > f <<'EOF'\nhello\nworld\nEOF\ncat f",
  append: "echo a > f && echo b >> f && cat f",
  "grep -n": "printf 'foo\\nbar\\nfoo2\\n' > f && grep -n foo f",
  "grep -rl": "mkdir d && echo x > d/a.md && echo y > d/b.md && grep -rl x .",
  "grep -iEc": "printf 'Foo\\nfoo\\nbar\\n' > f && grep -iEc 'f(o)+' f",
  "grep -v -A": "printf 'a\\nb\\nc\\nd\\n' > f && grep -A1 b f && grep -v b f",
  "sed -n": "printf 'a\\nb\\nc\\n' > f && sed -n 2p f",
  "sed -i": "echo hello > f && sed -i 's/hello/world/' f && cat f",
  "sed delete range": "printf '1\\n2\\n3\\n4\\n' > f && sed '2,3d' f",
  "sed -E group": "echo 'ab12' | sed -E 's/([a-z]+)([0-9]+)/\\2\\1/'",
  "sed append line": "printf 'a\\nb\\n' > f && sed -i '1a inserted' f && cat f",
  "awk sum": "printf 'a 1\\nb 2\\n' | awk '{s+=$2} END{print s}'",
  "awk -F": "printf 'a:b\\nc:d\\n' | awk -F: '{print $2}'",
  "awk NR": "printf 'a\\nb\\nc\\n' | awk 'NR==2'",
  "find -name": "mkdir -p a/b && touch a/b/x.md a/y.md && find . -name '*.md' | sort",
  "find -maxdepth -type": "mkdir -p a/b && touch a/b/x a/y && find . -maxdepth 2 -type f | sort",
  "sort uniq": "printf 'b\\na\\nb\\n' | sort | uniq -c",
  "head tail": "seq 1 10 | head -n 3 && seq 1 10 | tail -n 2",
  wc: "printf 'a b\\nc\\n' > f && wc -l f && wc -c f && wc -w f",
  xargs: "printf 'a\\nb\\n' | xargs -I{} echo got-{}",
  "cut tr": "echo a:b:c | cut -d: -f2 && echo abc | tr a-c A-C",
  "ls": "touch b a && ls",
  "ls glob": "touch a.md b.md c.txt && ls *.md",
  "stat -c": "echo hello > f && stat -c %s f",
  "cp mv rm": "echo x > a && cp a b && mv b c && rm a && ls",
  "cp -r": "mkdir d && echo x > d/f && cp -r d e && cat e/f",
  "mkdir -p rmdir": "mkdir -p a/b && rmdir a/b && ls a | wc -l",
  "and or": "false || echo ok; true && echo yes",
  "exit code": "printf 'x\\n' > f; grep nope f; echo $?",
  subst: "x=$(echo hi); echo \"$x-$((1+2))\"",
  "for loop": "for i in 1 2 3; do echo $i; done",
  "test -f": "touch f && [ -f f ] && echo exists",
  "basename dirname": "basename /a/b/c.md .md && dirname /a/b/c.md",
  diff: "printf 'a\\n' > x && printf 'b\\n' > y && diff x y; echo $?",
  tee: "echo hi | tee f && cat f",
  "ln -s": "echo x > f && ln -s f g && cat g",
  "echo -e printf": "echo -e 'a\\tb' && printf '%05d\\n' 42",
  base64: "echo hi | base64",
  sha256sum: "echo hi | sha256sum",
  "seq paste": "seq 1 5 | paste -sd,",
  unicode: "echo '你好' | wc -c && echo '你好世界' | grep 好",
  "herestring": "cat <<< hello",
  "process subst": "diff <(echo a) <(echo b); echo $?",
  "realpath": "echo x > f && realpath f",
  "readlink -f": "echo x > f && readlink -f f",
  "touch -d": "touch -d '2020-01-01' f && stat -c %Y f",
  "command -v": "command -v git >/dev/null && echo has-git",
  pwd: "pwd",
  "large output": "seq 1 5000 | wc -l",
  "pipe long": "seq 1 2000 | grep 9 | sort -r | head -n 2",
  "git log": `${GIT}echo x > f && git add -A && git commit -qm init && git log --oneline | wc -l`,
  "git diff --stat": `${GIT}echo x > f && git add -A && git commit -qm init && echo y >> f && git diff --stat | tail -n 1`,
  "git checkout file": `${GIT}echo x > f && git add -A && git commit -qm init && echo y >> f && git checkout -- f && cat f`,
  "git show": `${GIT}echo x > f && git add -A && git commit -qm init && git show HEAD:f`,
  "git status": `${GIT}echo x > f && git status --porcelain`,
  "git ls-tree": `${GIT}mkdir d && echo x > d/f && git add -A && git commit -qm init && git ls-tree -r --name-only HEAD`,
  "git grep": `${GIT}echo needle > f && git add -A && git commit -qm init && git grep -n needle`,
};

const norm = (text: string): string => text.split("\n").map((line) => line.trimEnd()).join("\n").trim();

const same = (a: Exec, b: Exec): boolean => norm(a.stdout) === norm(b.stdout) && a.exitCode === b.exitCode;

const clip = (text: string): string => JSON.stringify(norm(text).slice(0, 80));

await mkdir(new URL("../../data/bench/", import.meta.url).pathname, { recursive: true });
const a = await openA("x1");
const b = await openB("x1");
await a.exec("mkdir -p /work");
await b.exec("mkdir -p /work");

const diffs: string[] = [];
let matched = 0;
for (const [name, command] of Object.entries(PROBES)) {
  const [ra, rb] = [await a.exec(PRE + command), await b.exec(PRE + command)];
  if (same(ra, rb)) {
    matched += 1;
    continue;
  }
  diffs.push(`- ${name}\n    B: exit ${rb.exitCode} ${clip(rb.stdout)}\n    A: exit ${ra.exitCode} ${clip(ra.stdout)} ${ra.stderr.trim() === "" ? "" : `stderr ${clip(ra.stderr)}`}`);
}

const total = Object.keys(PROBES).length;
console.log(`一致 ${matched}/${total}（${((matched / total) * 100).toFixed(1)}%）`);
console.log(diffs.length === 0 ? "无差异" : `不一致 ${diffs.length} 条：\n${diffs.join("\n")}`);

await a.close();
await b.close();
