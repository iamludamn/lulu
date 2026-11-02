import { useState } from "react";
import type { BotAccess, ExecutorStatus, McpStatus, ModelConfig, ModelRef, SubtaskProgress } from "../protocol";
import { rotateToken } from "../session/bots";
import { CopyButton } from "./Copy";
import { MemoryPanel } from "./MemoryPanel";
import { SchedulePanel } from "./SchedulePanel";
import { Permissions } from "./Permissions";

type Tab = "subtasks" | "executors" | "mcp" | "memory" | "schedules" | "model" | "permissions";

export function SidePanel({
  open,
  botId,
  access,
  subtasks,
  models,
  username,
  executors,
  mcp,
  onModel,
  onSelectExecutor,
  onClose,
}: {
  open: boolean;
  botId: string;
  access: BotAccess | undefined;
  subtasks: SubtaskProgress[];
  models: ModelConfig | undefined;
  username: string;
  executors: readonly ExecutorStatus[];
  mcp: readonly McpStatus[];
  onModel: (model: ModelRef) => void;
  onSelectExecutor: (owner: string, name: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("subtasks");
  const running = subtasks.filter((subtask) => subtask.running);
  const finished = subtasks.filter((subtask) => !subtask.running);
  const online = executors.filter((executor) => executor.online).length;
  const broken = mcp.filter((server) => server.state !== "connected").length;
  const tabs: [Tab, string][] = [
    ["subtasks", running.length > 0 ? `子任务（${running.length}）` : "子任务"],
    ["executors", online > 0 ? `执行环境（${online}）` : "执行环境"],
    ["mcp", broken > 0 ? `MCP（${broken} 异常）` : "MCP"],
    ...(access === undefined || access === "none" ? [] : [["memory", "记忆"] as [Tab, string], ["schedules", "定时任务"] as [Tab, string]]),
    ["model", "模型"],
    ...(access === "owner" ? [["permissions", "权限"] as [Tab, string]] : []),
  ];

  return (
    <aside className={open ? "panel open" : "panel"}>
      <div className="panel-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="panel-tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="panel-close" aria-label="关闭面板" onClick={onClose}>
          ✕
        </button>
      </div>
      <section className="panel-body" role="tabpanel">
        {tab === "subtasks" && <SubtaskList subtasks={[...running, ...finished]} empty="暂无子任务" />}
        {tab === "executors" && (
          <Executors botId={botId} username={username} canRotate={access === "owner"} executors={executors} onSelect={onSelectExecutor} />
        )}
        {tab === "mcp" && <McpServers servers={mcp} />}
        {tab === "memory" && <MemoryPanel botId={botId} />}
        {tab === "schedules" && <SchedulePanel botId={botId} />}
        {tab === "model" &&
          (models === undefined ? <p className="muted">正在加载模型…</p> : <ModelPicker models={models} onModel={onModel} />)}
        {tab === "permissions" && access === "owner" && <Permissions botId={botId} />}
      </section>
    </aside>
  );
}

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback);

function Executors({
  botId,
  username,
  canRotate,
  executors,
  onSelect,
}: {
  botId: string;
  username: string;
  canRotate: boolean;
  executors: readonly ExecutorStatus[];
  onSelect: (owner: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(username);
  const [command, setCommand] = useState<string>();
  const [error, setError] = useState<string>();

  const generate = async () => {
    setError(undefined);
    try {
      const token = await rotateToken(botId);
      setCommand(connectCommand(botId, token, name.trim(), owner.trim()));
    } catch (failure) {
      setError(messageOf(failure, "生成连接命令失败"));
    }
  };

  return (
    <>
      {executors.length === 0 ? (
        <p className="muted">未连接执行环境</p>
      ) : (
        <ul className="subtasks">
          {executors.map((executor) => (
            <li key={`${executor.owner}/${executor.name}`}>
              <span className={executor.online ? "dot on" : "dot"} aria-hidden="true" />
              <span className="item-body">
                <span>
                  {executor.name}
                  {executor.isDefault && <span className="tag">默认</span>}
                </span>
                <span className="muted">{`${executor.owner} · ${executor.online ? "在线" : "离线"}${executor.os === "" ? "" : ` · ${executor.os}`}`}</span>
                {executor.cwd !== "" && <code className="muted">{executor.cwd}</code>}
              </span>
              {executor.online && !executor.isDefault && (
                <button type="button" onClick={() => onSelect(executor.owner, executor.name)}>
                  设为默认
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <label>
        执行环境名称
        <input value={name} placeholder="例如 mac-studio" onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        归属
        <input value={owner} onChange={(event) => setOwner(event.target.value)} />
      </label>
      {!canRotate ? (
        <p className="muted">只有 owner 可以生成连接命令</p>
      ) : name.trim() === "" || owner.trim() === "" ? (
        <p className="muted">填写执行环境名称和归属后，再生成连接命令</p>
      ) : (
        <button type="button" onClick={generate}>
          生成连接命令
        </button>
      )}
      {command !== undefined && (
        <>
          <CopyField label="连接命令" value={command} />
          <p className="muted">生成新命令会使旧命令的 token 立即失效，已连接的执行环境需要用新命令重连。</p>
        </>
      )}
      {error !== undefined && <p className="error">{error}</p>}
    </>
  );
}

const MCP_SOURCE: Record<McpStatus["source"], string> = { bot: "自定义", platform: "平台" };
const MCP_STATE: Record<McpStatus["state"], string> = { connected: "已连接", failed: "连接失败", "needs-auth": "需要授权" };

function McpServers({ servers }: { servers: readonly McpStatus[] }) {
  if (servers.length === 0) return <p className="muted">未配置 MCP 服务器</p>;
  return (
    <ul className="subtasks">
      {servers.map((server) => (
        <li key={server.name}>
          <span className={server.state === "connected" ? "dot on" : "dot"} aria-hidden="true" />
          <span className="item-body">
            <span>
              {server.name}
              <span className="tag">{MCP_SOURCE[server.source]}</span>
            </span>
            <span className={server.state === "connected" ? "muted" : "muted warn"}>
              {`${MCP_STATE[server.state]} · ${server.tools} 个工具 · 检查于 ${new Date(server.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
            </span>
            {server.error !== undefined && <span className="muted">{server.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="copy-field">
      <textarea readOnly value={value} aria-label={label} rows={4} onFocus={(event) => event.currentTarget.select()} />
      <CopyButton text={() => value} />
    </div>
  );
}

function connectCommand(botId: string, token: string, name: string, owner: string): string {
  const server = shellArg(location.origin);
  return `curl -fsSL ${server}/bridge/pistack-bridge.mjs -o pistack-bridge.mjs && node pistack-bridge.mjs --server ${server} --bot ${shellArg(botId)} --token ${shellArg(token)} --target local --name ${shellArg(name)} --owner ${shellArg(owner)}`;
}

function shellArg(value: string): string {
  return /^[\w./:@%+,=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function SubtaskList({ subtasks, empty }: { subtasks: SubtaskProgress[]; empty: string }) {
  if (subtasks.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="subtasks">
      {subtasks.map((subtask) => (
        <li key={subtask.id}>
          <span className={subtask.running ? "dot running" : "dot"} aria-hidden="true" />
          <span>{subtask.description}</span>
        </li>
      ))}
    </ul>
  );
}

function ModelPicker({ models, onModel }: { models: ModelConfig; onModel: (model: ModelRef) => void }) {
  const selected = models.model;
  const index =
    selected === null
      ? -1
      : models.models.findIndex((model) => model.provider === selected.provider && model.id === selected.id);
  const hint = models.overridden
    ? "模型已由服务端环境变量固定，无法在这里切换"
    : models.models.length === 0
      ? "没有可用模型，请检查服务端的 API key 配置"
      : undefined;
  return (
    <div className="model-picker">
      {hint !== undefined && <p className="muted">{hint}</p>}
      <label>
        模型
        <select
          value={index < 0 ? "" : String(index)}
          disabled={models.overridden || models.models.length === 0}
          onChange={(event) => {
            const next = models.models[Number(event.currentTarget.value)];
            if (next !== undefined) onModel(next);
          }}
        >
          {index < 0 && <option value="">选择模型</option>}
          {models.models.map((model, position) => (
            <option key={`${model.provider}/${model.id}`} value={String(position)}>
              {`${model.provider}/${model.id}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
