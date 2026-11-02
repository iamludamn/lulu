import { useEffect, useState } from "react";
import { BotList } from "./components/BotList";
import { Workbench } from "./components/Workbench";
import { loadAccount, signOut, SignInRequired } from "./session/account";
import type { Account } from "./protocol";
import { createBot, deleteBot, listBots, renameBot, type BotSummary } from "./session/bots";
import { botPath } from "./session/store";

const BOT_PATH = /^\/bots\/([^/]+)\/?$/;
const LEGACY_SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;

function routeBotId(): string | undefined {
  const legacy = LEGACY_SESSION_PATH.exec(location.pathname);
  const match = BOT_PATH.exec(location.pathname) ?? legacy;
  if (match === null) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  if (legacy !== null) history.replaceState(null, "", botPath(id) + location.search);
  return id;
}

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback);

export function App() {
  const [botId, setBotId] = useState(routeBotId);
  const [navOpen, setNavOpen] = useState(botId === undefined);
  const [account, setAccount] = useState<Account | null>();
  const [bots, setBots] = useState<BotSummary[]>();
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onPopState = () => setBotId(routeBotId());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const title = bots?.find((bot) => bot.id === botId)?.name;

  useEffect(() => {
    document.title = title === undefined ? "lulu Workbench" : `${title} · lulu Workbench`;
  }, [title]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && botId !== undefined) setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen, botId]);

  useEffect(() => {
    let alive = true;
    setLoadError(undefined);
    loadAccount()
      .then((loaded) => {
        if (alive) setAccount(loaded ?? null);
      })
      .catch((failure: unknown) => {
        if (alive) setLoadError(messageOf(failure, "加载登录状态失败"));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (account === undefined || account === null) return;
    let alive = true;
    listBots()
      .then((list) => {
        if (alive) setBots(list);
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        if (failure instanceof SignInRequired) setAccount(null);
        else setLoadError(messageOf(failure, "加载 bot 列表失败"));
      });
    return () => {
      alive = false;
    };
  }, [account, attempt]);

  const open = (id: string | undefined) => {
    history.pushState(null, "", id === undefined ? "/" : botPath(id));
    setBotId(id);
    setNavOpen(id === undefined);
  };

  const create = async (name: string) => {
    setNotice(undefined);
    try {
      const created = await createBot(name);
      setBots((list) => [...(list ?? []), created]);
      open(created.id);
    } catch (failure) {
      if (failure instanceof SignInRequired) setAccount(null);
      else setNotice(messageOf(failure, "创建 bot 失败"));
    }
  };

  const rename = async (id: string, name: string) => {
    setNotice(undefined);
    try {
      await renameBot(id, name);
      setBots((list) => list?.map((bot) => (bot.id === id ? { ...bot, name } : bot)));
    } catch (failure) {
      setNotice(messageOf(failure, "改名失败"));
    }
  };

  const remove = async (id: string) => {
    setNotice(undefined);
    try {
      await deleteBot(id);
      setBots((list) => list?.filter((bot) => bot.id !== id));
      if (id === botId) open(undefined);
    } catch (failure) {
      setNotice(messageOf(failure, "删除失败"));
    }
  };

  const logOut = () => {
    void signOut().finally(() => location.assign("/"));
  };

  if (account === null) {
    return (
      <main className="centered">
        <div className="login">
          <img src="/icon.svg" alt="" width={48} height={48} />
          <h1>lulu Workbench</h1>
          <p className="muted">登录后即可使用你的 bot</p>
          <a className="button primary" href="/auth/feishu/login">
            使用飞书登录
          </a>
        </div>
      </main>
    );
  }

  if (loadError !== undefined) {
    return (
      <main className="centered">
        <p role="alert">{loadError}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重试
        </button>
      </main>
    );
  }

  if (account === undefined || bots === undefined) {
    return (
      <main className="centered">
        <p className="muted">正在加载…</p>
      </main>
    );
  }

  return (
    <div className="shell">
      <BotList
        open={navOpen}
        bots={bots}
        selected={botId}
        account={account}
        notice={notice}
        onOpen={open}
        onCreate={create}
        onRename={rename}
        onDelete={remove}
        onDismissNotice={() => setNotice(undefined)}
        onSignOut={logOut}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && <button type="button" className="scrim" aria-label="关闭 bot 列表" onClick={() => setNavOpen(false)} />}
      <main className="stage">
        {botId === undefined ? (
          <div className="empty">
            <header className="topbar">
              <button type="button" className="menu-toggle" aria-label="打开 bot 列表" onClick={() => setNavOpen(true)}>
                ☰
              </button>
              <h1>lulu Workbench</h1>
            </header>
            <p className="muted stage-empty">{bots.length === 0 ? "在左侧新建一个 bot 开始使用" : "从左侧选择一个 bot"}</p>
          </div>
        ) : (
          <Workbench
            key={botId}
            botId={botId}
            account={account}
            title={title}
            onMenu={() => setNavOpen(true)}
          />
        )}
      </main>
    </div>
  );
}
