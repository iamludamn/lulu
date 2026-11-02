export const SYSTEM_DIR = "system";
export const SYSTEM_FILE_CHARACTERS = 1500;

const SYSTEM_PATH = /^system\/[^/.\\\r\n][^/\\\r\n]*\.md$/;
const TOPIC_PATH = /^(people|areas|topics)\/[^/.\\\r\n][^/\\\r\n]*\.md$/;
const DAILY_PATH = /^log\/\d{4}-\d{2}-\d{2}\.md$/;
const KEEP_PATH = /^(system|people|areas|topics|log)\/\.keep$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION = /^description:[ \t]*(.*)$/m;

export const SEED: Readonly<Record<string, string>> = {
  "system/profile.md": "---\ndescription: 用户是谁、长期偏好\n---\n",
  "system/feedback.md": "---\ndescription: 用户对助手的纠正与偏好\n---\n",
  "system/now.md": "---\ndescription: 当前在做的事与近期状态\n---\n",
};

export const isSystemPath = (path: string): boolean => SYSTEM_PATH.test(path);

export const isDailyPath = (path: string): boolean => DAILY_PATH.test(path);

export const isMemoryFile = (path: string): boolean => SYSTEM_PATH.test(path) || TOPIC_PATH.test(path) || DAILY_PATH.test(path);

export const isStoredFile = (path: string): boolean => isMemoryFile(path) || KEEP_PATH.test(path);

export const hasFrontmatter = (text: string): boolean => FRONTMATTER.test(text);

export const descriptionOf = (text: string): string => {
  const block = FRONTMATTER.exec(text)?.[1];
  return block === undefined ? "" : (DESCRIPTION.exec(block)?.[1] ?? "").trim();
};
