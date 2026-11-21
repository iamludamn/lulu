import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi';
import { Parser } from 'htmlparser2';
import bash from '@ast-grep/lang-bash';
import cpp from '@ast-grep/lang-cpp';
import go from '@ast-grep/lang-go';
import python from '@ast-grep/lang-python';
import swift from '@ast-grep/lang-swift';

registerDynamicLanguage({ bash, cpp, go, python, swift });

const languages = new Map([
  ['.js', Lang.JavaScript], ['.mjs', Lang.JavaScript], ['.cjs', Lang.JavaScript],
  ['.jsx', Lang.JavaScript], ['.ts', Lang.TypeScript], ['.mts', Lang.TypeScript],
  ['.cts', Lang.TypeScript], ['.tsx', Lang.Tsx], ['.css', Lang.Css], ['.html', Lang.Html],
  ['.go', 'go'], ['.swift', 'swift'], ['.metal', 'cpp'],
  ['.py', 'python'], ['.sh', 'bash'], ['.bash', 'bash'],
]);
const commentRule = { kind: 'comment' };
const swiftCommentRule = { any: [commentRule, { kind: 'multiline_comment' }] };
const root = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = 'scripts/comment-baseline.json';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

function htmlComments(path, source) {
  const comments = [];
  const position = (index) => {
    const lines = source.slice(0, index).split('\n');
    return { line: lines.length - 1, column: lines.at(-1).length, index };
  };
  const parser = new Parser({
    oncomment() {
      const start = parser.startIndex;
      const end = parser.endIndex + 1;
      comments.push({ path, text: source.slice(start, end), start: position(start), end: position(end) });
    },
  });
  parser.end(source);
  return comments;
}

function* sourceComments() {
  const files = new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'));
  for (const path of [...files].sort()) {
    const language = languages.get(extname(path));
    if (language === undefined) continue;

    let source;
    try {
      source = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    if (language === Lang.Html) {
      yield* htmlComments(path, source);
      continue;
    }
    const rule = language === 'swift' ? swiftCommentRule : commentRule;
    for (const node of parse(language, source).root().findAll({ rule })) {
      yield { path, text: node.text(), ...node.range() };
    }
  }
}

function counts(entries) {
  const result = new Map();
  for (const { path, text } of entries) {
    const key = JSON.stringify([path, text]);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function* excess(entries, budget) {
  const remaining = counts(budget);
  for (const entry of entries) {
    const key = JSON.stringify([entry.path, entry.text]);
    const available = remaining.get(key) ?? 0;
    if (available > 0) remaining.set(key, available - 1);
    else yield entry;
  }
}

const comments = [...sourceComments()];
if (process.argv[2] === '--inventory') {
  console.log(JSON.stringify(comments, null, 2));
} else {
  const baseline = JSON.parse(readFileSync(new URL('comment-baseline.json', import.meta.url), 'utf8'));
  for (const { path, start } of excess(comments, baseline)) {
    console.error(`${path}:${start.line + 1}:${start.column + 1}: [no-comments] Remove the comment or record the decision in docs/adr/.`);
    process.exitCode = 1;
  }
  for (const { path } of excess(baseline, comments)) {
    console.error(`${path}: [no-comments] Remove the obsolete entry from ${baselinePath}.`);
    process.exitCode = 1;
  }

  const base = process.env.COMMENT_LINT_BASE;
  if (base && git('ls-tree', '--name-only', base, '--', baselinePath).trim()) {
    const previous = JSON.parse(git('show', `${base}:${baselinePath}`));
    for (const { path } of excess(baseline, previous)) {
      console.error(`${path}: [no-comments] ${baselinePath} may only shrink relative to the base branch.`);
      process.exitCode = 1;
    }
  }
}
