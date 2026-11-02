import { memo, useLayoutEffect, useRef, useState } from "react";
import type { MessageProgress } from "../protocol";
import type { BotStore, Snapshot } from "../session/store";
import { chatEntries, liveOf, splitAttribution, timeline } from "../session/view";
import { CopyButton } from "./Copy";
import { Prose } from "./Prose";

const NOTICE_LABEL: Record<string, string> = { "prompt.abort": "停止请求", "model.select": "切换模型", "executor.select": "切换执行环境" };

export const Transcript = memo(function Transcript({ snapshot, store, username }: { snapshot: Snapshot; store: BotStore; username: string }) {
  const { view, progress, requests } = snapshot;
  const items = timeline(chatEntries(view, progress?.hiddenEntries ?? []), progress?.messages ?? []);
  const live = liveOf(view);
  const prompts = requests.flatMap((request) =>
    request.command.type === "prompt.submit"
      ? [{ requestId: request.command.requestId, text: request.command.content, state: request.state, error: request.error }]
      : [],
  );
  const notices = requests.flatMap((request) =>
    request.command.type !== "prompt.submit" && request.state === "failed"
      ? [{ requestId: request.command.requestId, label: NOTICE_LABEL[request.command.type] ?? "操作", error: request.error ?? "" }]
      : [],
  );
  const empty = view !== undefined && items.length === 0 && prompts.length === 0 && !live.busy;

  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const sent = useRef(prompts.length);
  const [detached, setDetached] = useState(false);

  useLayoutEffect(() => {
    if (prompts.length > sent.current) {
      pinned.current = true;
      setDetached(false);
    }
    sent.current = prompts.length;
    const list = listRef.current;
    if (list !== null && pinned.current) list.scrollTop = list.scrollHeight;
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const list = listRef.current;
    if (list === null) return;
    pinned.current = list.scrollHeight - list.clientHeight - list.scrollTop < 24;
    setDetached(!pinned.current);
  };

  const toBottom = () => {
    const list = listRef.current;
    if (list === null) return;
    pinned.current = true;
    setDetached(false);
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="transcript-frame">
      <div className="transcript" ref={listRef} onScroll={onScroll}>
        {view === undefined && <p className="muted transcript-empty">正在加载对话…</p>}
        {empty && <p className="muted transcript-empty">还没有消息，发送第一条开始对话</p>}
        <ol className="messages">
          {items.map((item) =>
            item.kind === "entry" ? (
              <Message key={item.entry.id} role={item.entry.role} text={item.entry.text} />
            ) : (
              <Message key={`prompt-${item.message.id}`} role="user" text={item.message.text} progress={item.message} />
            ),
          )}
          {prompts.map((prompt) => (
            <Message
              key={prompt.requestId}
              role="user"
              text={prompt.text}
              author={username}
              pending={{
                state: prompt.state,
                error: prompt.error,
                onRetry: () => store.retry(prompt.requestId),
                onDismiss: () => store.dismiss(prompt.requestId),
              }}
            />
          ))}
          {notices.map((notice) => (
            <li key={notice.requestId} className="notice" role="alert">
              <span>{`${notice.label}失败：${notice.error}`}</span>
              <button type="button" onClick={() => store.retry(notice.requestId)}>
                重试
              </button>
              <button type="button" onClick={() => store.dismiss(notice.requestId)}>
                关闭
              </button>
            </li>
          ))}
          {live.busy && (
            <li className="message assistant live" aria-live="polite">
              <div className="live-status">
                <span className="typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                {live.tools.length > 0 ? (
                  live.tools.map((tool, index) => (
                    <span key={`${tool}-${index}`} className="tool-chip">
                      {tool}
                    </span>
                  ))
                ) : (
                  <span className="muted">思考中</span>
                )}
              </div>
            </li>
          )}
        </ol>
      </div>
      {detached && (
        <button type="button" className="jump" onClick={toBottom}>
          ↓ 回到最新
        </button>
      )}
    </div>
  );
});

function Message({
  role,
  text,
  author,
  progress,
  pending,
}: {
  role: "user" | "assistant";
  text: string;
  author?: string;
  progress?: MessageProgress;
  pending?: { state: "sending" | "failed"; error: string | undefined; onRetry: () => void; onDismiss: () => void };
}) {
  const attributed = splitAttribution(text);
  const name = attributed.author ?? author;
  const waiting = progress !== undefined && progress.state !== "done";
  return (
    <li className={`message ${role}`}>
      {role === "assistant" ? (
        <>
          <Prose text={text} />
          <div className="message-actions">
            <CopyButton text={() => text} />
          </div>
        </>
      ) : (
        <>
          {name !== undefined && <span className="author">{name}</span>}
          <p className="text">{attributed.body}</p>
        </>
      )}
      {(waiting || progress?.error) && (
        <div className="progress">
          {waiting && <span className={`state state-${progress.state}`}>{progress.state === "todo" ? "排队中" : "处理中"}</span>}
          {progress?.error ? <span className="error">{progress.error}</span> : null}
        </div>
      )}
      {pending !== undefined && (
        <div className="progress">
          {pending.state === "sending" ? (
            <span className="state state-todo">发送中…</span>
          ) : (
            <>
              <span className="error">{`发送失败${pending.error ? `：${pending.error}` : ""}`}</span>
              <button type="button" onClick={pending.onRetry}>
                重试
              </button>
              <button type="button" onClick={pending.onDismiss}>
                关闭
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
