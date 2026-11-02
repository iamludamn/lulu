import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { type Account, MAX_CLIENT_FRAME_CHARACTERS } from "../protocol";
import { useBot } from "../session/use-session";
import { liveOf, subtasksOf } from "../session/view";
import { AccessNotice, MissingSession } from "./Gate";
import { SidePanel } from "./SidePanel";
import { VoiceControl } from "./VoiceControl";
import { Transcript } from "./Transcript";

const LINK_LABEL = { connecting: "连接中", online: "已连接", offline: "重连中" };
const WIDE = "(min-width: 768px)";
const TOUCH = "(pointer: coarse)";

const draftKey = (botId: string): string => `pistack.draft.${botId}`;

export function Workbench({
  botId,
  account,
  title,
  onMenu,
}: {
  botId: string;
  account: Account;
  title: string | undefined;
  onMenu: () => void;
}) {
  const { store, snapshot } = useBot(botId);
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(botId)) ?? "");
  const [panelOpen, setPanelOpen] = useState(() => matchMedia(WIDE).matches);
  const input = useRef<HTMLTextAreaElement>(null);
  const subtasks = subtasksOf(snapshot.progress);
  const running = subtasks.filter((subtask) => subtask.running).length;
  const live = liveOf(snapshot.view);
  const writable = snapshot.access === "owner" || snapshot.access === "full";
  const touch = matchMedia(TOUCH).matches;

  useEffect(() => {
    if (draft === "") localStorage.removeItem(draftKey(botId));
    else localStorage.setItem(draftKey(botId), draft);
  }, [botId, draft]);

  useEffect(() => {
    if (writable && !touch) input.current?.focus();
  }, [writable, touch]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !matchMedia(WIDE).matches) setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    store.submit(text);
    setDraft("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
    if (!touch) input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const link = snapshot.halt === undefined ? snapshot.link : "halted";

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="menu-toggle" aria-label="打开 bot 列表" onClick={onMenu}>
          ☰
        </button>
        <h1>{title ?? "Ludamn Workbench"}</h1>
        <span className={`link link-${link}`} role="status">
          <span className="link-dot" aria-hidden="true" />
          {link === "halted" ? "未连接" : LINK_LABEL[link]}
        </span>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          面板{running > 0 ? `（${running}）` : ""}
        </button>
      </header>
      {panelOpen && <button type="button" className="scrim" aria-label="关闭面板" onClick={() => setPanelOpen(false)} />}
      <div className={panelOpen ? "workspace" : "workspace panel-closed"}>
        <section className="chat">
          {(snapshot.halt === "unauthorized" || snapshot.halt === "forbidden") && <AccessNotice halt={snapshot.halt} />}
          {snapshot.halt === "not-found" && <MissingSession />}
          {snapshot.halt === undefined && (
            <>
              <Transcript snapshot={snapshot} store={store} username={account.name} />
              <div className="composer-dock">
                {snapshot.link === "offline" && <p className="banner" role="status">连接已断开，正在重连；未发出的消息会在恢复后自动发送</p>}
                {snapshot.access === "read" && <p className="banner">只读访问：可以查看对话，无法发送消息或停止</p>}
                <form className="composer" onSubmit={onSubmit}>
                  <textarea
                    ref={input}
                    value={draft}
                    maxLength={MAX_CLIENT_FRAME_CHARACTERS}
                    rows={1}
                    disabled={!writable}
                    aria-label="消息"
                    placeholder={
                      writable
                        ? touch
                          ? "输入消息"
                          : "输入消息，Enter 发送，Shift + Enter 换行"
                        : snapshot.access === "read"
                          ? "只读访问，无法发送消息"
                          : "连接中…"
                    }
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={onKeyDown}
                  />
                  <div className="composer-actions">
                    {writable && live.busy && (
                      <button type="button" className="stop" onClick={() => store.abort()}>
                        停止
                      </button>
                    )}
                    <VoiceControl store={store} enabled={writable} />
                    <button type="submit" className="send" disabled={!writable || draft.trim() === ""}>
                      {live.busy ? "追加" : "发送"}
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </section>
        <SidePanel
          open={panelOpen}
          botId={botId}
          access={snapshot.access}
          subtasks={subtasks}
          models={snapshot.models}
          username={account.name}
          executors={snapshot.executors}
          mcp={snapshot.mcp}
          onModel={(model) => store.selectModel(model)}
          onSelectExecutor={(owner, name) => store.selectExecutor(owner, name)}
          onClose={() => setPanelOpen(false)}
        />
      </div>
    </div>
  );
}
