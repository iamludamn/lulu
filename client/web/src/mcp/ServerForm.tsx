import { useState } from "react";
import { MCP_MASK, MCP_SERVER_NAME, type McpServerInput, type McpServerView } from "@lulu/core/protocol/mcp.js";

interface Props {
  readonly server: McpServerView | undefined;
  readonly busy: boolean;
  readonly onSave: (name: string, input: McpServerInput) => void;
  readonly onCancel: () => void;
}

interface Pair {
  name: string;
  value: string;
}

export function ServerForm({ server, busy, onSave, onCancel }: Props) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [pairs, setPairs] = useState<Pair[]>(Object.entries(server?.headers ?? {}).map(([header, value]) => ({ name: header, value })));
  const valid = MCP_SERVER_NAME.test(name) && url.trim() !== "";

  const change = (index: number, patch: Partial<Pair>) => setPairs(pairs.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)));

  const submit = () => {
    const headers = Object.fromEntries(pairs.filter((pair) => pair.name.trim() !== "").map((pair) => [pair.name.trim(), pair.value]));
    onSave(name, { url: url.trim(), headers });
  };

  return (
    <div className="card">
      <label htmlFor="mcp-name">名称</label>
      <input id="mcp-name" value={name} disabled={server !== undefined} placeholder="github" autoCapitalize="none" autoCorrect="off" onChange={(event) => setName(event.target.value)} />
      <p className="hint">只能包含字母、数字、_ 和 -，工具会以 mcp__名称__工具 的形式出现。</p>
      <label htmlFor="mcp-url">服务器地址</label>
      <input id="mcp-url" type="url" value={url} placeholder="https://example.com/mcp" autoCapitalize="none" autoCorrect="off" onChange={(event) => setUrl(event.target.value)} />
      <p className="hint">只支持 HTTP（streamable HTTP）服务器。需要 OAuth 的服务器不用填 Authorization，保存后点「登录」。</p>
      <label>请求头</label>
      {pairs.map((pair, index) => (
        <div className="pair" key={index}>
          <input value={pair.name} placeholder="Authorization" autoCapitalize="none" autoCorrect="off" onChange={(event) => change(index, { name: event.target.value })} />
          <input type="password" value={pair.value} placeholder="Bearer …" autoComplete="off" onChange={(event) => change(index, { value: event.target.value })} />
          <button type="button" onClick={() => setPairs(pairs.filter((_, at) => at !== index))}>移除</button>
        </div>
      ))}
      <button type="button" onClick={() => setPairs([...pairs, { name: "", value: "" }])}>添加请求头</button>
      {server !== undefined && <p className="hint">值为 {MCP_MASK} 的请求头保持不变，改写即可替换。</p>}
      <div className="actions">
        <button type="button" className="primary" disabled={!valid || busy} onClick={submit}>
          {busy ? "保存中…" : "保存并连接"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
