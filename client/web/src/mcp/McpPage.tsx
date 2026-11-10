import { useCallback, useEffect, useState } from "react";
import type { McpStatus } from "@lulu/core/protocol/contract.js";
import type { McpRegistryView, McpServerInput, McpServerView } from "@lulu/core/protocol/mcp.js";
import { Unauthorized, registry, saveToken, savedToken } from "./api";
import { ServerForm } from "./ServerForm";
import "./mcp.css";

interface Notice {
  readonly kind: "ok" | "bad";
  readonly text: string;
}

type Editing = { readonly server: McpServerView | undefined } | undefined;

function noticeFromLocation(): Notice | undefined {
  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  const error = params.get("error");
  if (login === null && error === null) return undefined;
  history.replaceState(null, "", location.pathname);
  return error === null ? { kind: "ok", text: `${login} 已登录` } : { kind: "bad", text: `登录失败：${error}` };
}

function statusLabel(status: McpStatus | undefined): { className: string; text: string } {
  if (status === undefined) return { className: "unknown", text: "尚未连接" };
  if (status.state === "connected") return { className: "connected", text: `已连接 · ${status.tools} 个工具` };
  if (status.state === "needs-auth") return { className: "needs-auth", text: "需要登录" };
  return { className: "failed", text: `连接失败${status.error === undefined ? "" : `：${status.error}`}` };
}

function TokenGate({ onToken, invalid }: { onToken: (token: string) => void; invalid: boolean }) {
  const [token, setToken] = useState("");
  return (
    <div className="card">
      <label htmlFor="mcp-token">管理口令</label>
      <input id="mcp-token" type="password" value={token} autoComplete="off" onChange={(event) => setToken(event.target.value)} />
      <p className="hint">{invalid ? "口令不正确。" : "配置 MCP 需要管理口令（MCP_ADMIN_TOKEN），只保存在这个浏览器里。"}</p>
      <div className="actions">
        <button type="button" className="primary" disabled={token === ""} onClick={() => onToken(token)}>
          进入
        </button>
      </div>
    </div>
  );
}

export function McpPage() {
  const [token, setToken] = useState(savedToken);
  const [invalid, setInvalid] = useState(false);
  const [view, setView] = useState<McpRegistryView | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | undefined>(noticeFromLocation);
  const [editing, setEditing] = useState<Editing>(undefined);

  const run = useCallback(
    async (label: string, action: () => Promise<McpRegistryView | undefined>) => {
      setBusy(label);
      if (label !== "list") setNotice(undefined);
      try {
        const next = await action();
        if (next !== undefined) setView(next);
        return true;
      } catch (error) {
        if (error instanceof Unauthorized) {
          saveToken("");
          setToken("");
          setInvalid(true);
        } else {
          setNotice({ kind: "bad", text: error instanceof Error ? error.message : String(error) });
        }
        return false;
      } finally {
        setBusy("");
      }
    },
    [],
  );

  useEffect(() => {
    if (token !== "") void run("list", () => registry.list(token));
  }, [token, run]);

  const enter = (value: string) => {
    saveToken(value);
    setInvalid(false);
    setToken(value);
  };

  const save = async (name: string, input: McpServerInput) => {
    if (await run("save", () => registry.save(token, name, input))) setEditing(undefined);
  };

  const remove = (name: string) => {
    if (confirm(`删除 ${name}？`)) void run(`remove:${name}`, () => registry.remove(token, name));
  };

  const login = (name: string) =>
    run(`login:${name}`, async () => {
      const result = await registry.login(token, name);
      if (result.authorizationUrl !== undefined) location.assign(result.authorizationUrl);
      return result.servers === undefined || result.statuses === undefined ? undefined : { servers: result.servers, statuses: result.statuses };
    });

  const statuses = new Map((view?.statuses ?? []).map((status) => [status.name, status]));
  const builtin = (view?.statuses ?? []).filter((status) => status.source === "platform");

  return (
    <div className="mcp">
      <main>
        <header>
          <h1>MCP 服务器</h1>
          {token !== "" && (
            <button type="button" disabled={busy !== ""} onClick={() => void run("reload", () => registry.reload(token))}>
              {busy === "reload" ? "连接中…" : "重新连接"}
            </button>
          )}
        </header>
        {notice !== undefined && <div className={`banner ${notice.kind}`}>{notice.text}</div>}
        {token === "" ? (
          <TokenGate onToken={enter} invalid={invalid} />
        ) : (
          <>
            {editing !== undefined && (
              <ServerForm key={editing.server?.name ?? "new"} server={editing.server} busy={busy === "save"} onSave={(name, input) => void save(name, input)} onCancel={() => setEditing(undefined)} />
            )}
            {editing === undefined && (
              <button type="button" className="primary" onClick={() => setEditing({ server: undefined })}>
                添加服务器
              </button>
            )}
            <h2>已注册</h2>
            {view === undefined && <p className="empty">{busy === "list" ? "加载中…" : "无法加载。"}</p>}
            {view?.servers.length === 0 && <p className="empty">还没有注册任何服务器。</p>}
            {view?.servers.map((server) => {
              const status = statusLabel(statuses.get(server.name));
              return (
                <div className="card" key={server.name}>
                  <div className="name">{server.name}</div>
                  <div className="url">{server.url}</div>
                  <div className={`status ${status.className}`}>{status.text}</div>
                  <div className="actions">
                    {statuses.get(server.name)?.state === "needs-auth" && (
                      <button type="button" className="primary" disabled={busy !== ""} onClick={() => void login(server.name)}>
                        {busy === `login:${server.name}` ? "跳转中…" : "登录"}
                      </button>
                    )}
                    <button type="button" disabled={busy !== ""} onClick={() => setEditing({ server })}>
                      编辑
                    </button>
                    <button type="button" className="danger" disabled={busy !== ""} onClick={() => remove(server.name)}>
                      {busy === `remove:${server.name}` ? "删除中…" : "删除"}
                    </button>
                  </div>
                </div>
              );
            })}
            {builtin.length > 0 && <h2>内置</h2>}
            {builtin.map((status) => {
              const label = statusLabel(status);
              return (
                <div className="card" key={status.name}>
                  <div className="name">{status.name}</div>
                  <div className={`status ${label.className}`}>{label.text}</div>
                </div>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
