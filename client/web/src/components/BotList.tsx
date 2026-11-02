import { useState, type FormEvent } from "react";
import type { Account, BotAccess } from "../protocol";
import type { BotSummary } from "../session/bots";
import { applyTheme, loadTheme, nextTheme, THEME_LABEL } from "../theme";

const ACCESS_TAG: Partial<Record<BotAccess, string>> = { read: "只读", full: "协作" };

export function BotList({
  open,
  bots,
  selected,
  account,
  notice,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onDismissNotice,
  onSignOut,
  onClose,
}: {
  open: boolean;
  bots: BotSummary[];
  selected: string | undefined;
  account: Account;
  notice: string | undefined;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDismissNotice: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState(loadTheme);

  const cycleTheme = () => {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  };

  return (
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="sidebar-head">
        <h2>Ludamn Workbench</h2>
        <button type="button" className="sidebar-close" aria-label="关闭 bot 列表" onClick={onClose}>
          ✕
        </button>
      </div>
      <NewBot onCreate={onCreate} />
      {notice !== undefined && (
        <p className="error dismissable" role="alert">
          <span>{notice}</span>
          <button type="button" aria-label="关闭提示" onClick={onDismissNotice}>
            ✕
          </button>
        </p>
      )}
      <ul className="bot-list">
        {bots.length === 0 && <li className="muted">还没有 bot，在上方输入名称新建一个</li>}
        {bots.map((bot) => (
          <BotRow key={bot.id} bot={bot} active={bot.id === selected} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
        ))}
      </ul>
      <footer className="sidebar-foot">
        <span className="account" title={account.name}>
          {account.name}
        </span>
        <button type="button" title="切换主题" onClick={cycleTheme}>
          {THEME_LABEL[theme]}
        </button>
        <button type="button" onClick={onSignOut}>
          退出
        </button>
      </footer>
    </aside>
  );
}

function NewBot({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = name.trim();
    if (value === "") return;
    setName("");
    onCreate(value);
  };

  return (
    <form className="bot-create" onSubmit={submit}>
      <input
        value={name}
        placeholder="新 bot 名称"
        aria-label="新 bot 名称"
        maxLength={60}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <button type="submit" disabled={name.trim() === ""}>
        新建
      </button>
    </form>
  );
}

function BotRow({
  bot,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  bot: BotSummary;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bot.name);
  const tag = ACCESS_TAG[bot.access];

  if (editing) {
    const save = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = draft.trim();
      setEditing(false);
      if (name !== "" && name !== bot.name) onRename(bot.id, name);
    };
    return (
      <li className="bot-item">
        <form className="bot-edit" onSubmit={save}>
          <input
            value={draft}
            aria-label="bot 名称"
            maxLength={60}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="submit">保存</button>
          <button type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      </li>
    );
  }

  return (
    <li className={active ? "bot-item active" : "bot-item"}>
      <button type="button" className="bot-select" aria-current={active || undefined} onClick={() => onOpen(bot.id)}>
        <span className="bot-name">{bot.name}</span>
        {tag !== undefined && <span className="tag">{tag}</span>}
      </button>
      {bot.access === "owner" && (
        <span className="bot-actions">
          <button
            type="button"
            onClick={() => {
              setDraft(bot.name);
              setEditing(true);
            }}
          >
            改名
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (window.confirm(`删除 bot「${bot.name}」？其中的对话会被永久清空，且无法恢复。`)) onDelete(bot.id);
            }}
          >
            删除
          </button>
        </span>
      )}
    </li>
  );
}
