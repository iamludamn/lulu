import type { Account } from "../protocol";

export class SignInRequired extends Error {}

export async function loadAccount(): Promise<Account | undefined> {
  const response = await fetch("/auth/session");
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error(`加载登录状态失败（${response.status}）`);
  return (await response.json()) as Account;
}

export async function signOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}
