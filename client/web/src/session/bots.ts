import type { BotAccess, MemoryListing, PermissionsUpdate, PermissionsView, ScheduleEntry } from "../protocol";
import { SignInRequired } from "./account";

export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly access: BotAccess;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

const botUrl = (botId: string, suffix = ""): string => `/api/bots/${encodeURIComponent(botId)}${suffix}`;

export async function listBots(): Promise<BotSummary[]> {
  const response = await fetch("/api/bots");
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error(`加载 bot 列表失败（${response.status}）`);
  return (await response.json()) as BotSummary[];
}

export async function createBot(name: string): Promise<BotSummary> {
  const response = await fetch("/api/bots", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error(`创建 bot 失败（${response.status}）`);
  const body = (await response.json()) as { id?: unknown; name?: unknown };
  if (typeof body.id !== "string" || body.id === "") throw new Error("服务返回的 bot ID 无效");
  if (typeof body.name !== "string" || body.name === "") throw new Error("服务返回的 bot 名称无效");
  return { id: body.id, name: body.name, access: "owner" };
}

export async function renameBot(botId: string, name: string): Promise<void> {
  const response = await fetch(botUrl(botId), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
  if (response.status === 403) throw new Error("只有 owner 可以改名");
  if (!response.ok) throw new Error(`改名失败（${response.status}）`);
}

export async function deleteBot(botId: string): Promise<void> {
  const response = await fetch(botUrl(botId), { method: "DELETE" });
  if (response.status === 403) throw new Error("只有 owner 可以删除");
  if (!response.ok) throw new Error(`删除失败（${response.status}）`);
}

export async function rotateToken(botId: string): Promise<string> {
  const response = await fetch(botUrl(botId, "/token"), { method: "POST" });
  if (response.status === 403) throw new Error("只有 owner 可以生成连接命令");
  if (!response.ok) throw new Error(`生成连接命令失败（${response.status}）`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token === "") throw new Error("服务返回的 token 无效");
  return body.token;
}

export async function loadPermissions(botId: string): Promise<PermissionsView> {
  const response = await fetch(botUrl(botId, "/permissions"));
  if (response.status === 403) throw new Error("只有 owner 可以查看权限");
  if (!response.ok) throw new Error(`加载权限失败（${response.status}）`);
  return (await response.json()) as PermissionsView;
}

export async function loadMemory(botId: string): Promise<MemoryListing> {
  const response = await fetch(botUrl(botId, "/memory"));
  if (response.status === 403) throw new Error("没有查看记忆的权限");
  if (!response.ok) throw new Error(`加载记忆失败（${response.status}）`);
  return (await response.json()) as MemoryListing;
}

export async function loadSchedules(botId: string): Promise<ScheduleEntry[]> {
  const response = await fetch(botUrl(botId, "/schedules"));
  if (response.status === 403) throw new Error("没有查看定时任务的权限");
  if (!response.ok) throw new Error(`加载定时任务失败（${response.status}）`);
  return (await response.json()) as ScheduleEntry[];
}

export async function loadMemoryFile(botId: string, path: string): Promise<string> {
  const response = await fetch(`${botUrl(botId, "/memory/file")}?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`加载文件失败（${response.status}）`);
  return response.text();
}

export async function savePermissions(botId: string, update: PermissionsUpdate): Promise<PermissionsView> {
  const response = await fetch(botUrl(botId, "/permissions"), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(update),
  });
  if (response.status === 403) throw new Error("只有 owner 可以修改权限");
  if (!response.ok) throw new Error(`保存权限失败（${response.status}）`);
  return (await response.json()) as PermissionsView;
}
