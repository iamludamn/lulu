import { useEffect, useState } from "react";
import type { MemoryListing } from "../protocol";
import { loadMemory, loadMemoryFile } from "../session/bots";
import { Prose } from "./Prose";

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback);

export function MemoryPanel({ botId }: { botId: string }) {
  const [listing, setListing] = useState<MemoryListing>();
  const [error, setError] = useState<string>();
  const [path, setPath] = useState<string>();
  const [content, setContent] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(undefined);
    loadMemory(botId)
      .then((loaded) => {
        if (alive) setListing(loaded);
      })
      .catch((failure: unknown) => {
        if (alive) setError(messageOf(failure, "加载记忆失败"));
      });
    return () => {
      alive = false;
    };
  }, [botId, attempt]);

  const open = (file: string) => {
    setPath(file);
    setContent(undefined);
    loadMemoryFile(botId, file)
      .then(setContent)
      .catch((failure: unknown) => setContent(messageOf(failure, "加载文件失败")));
  };

  if (error !== undefined) {
    return (
      <>
        <p className="error">{error}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重试
        </button>
      </>
    );
  }
  if (listing === undefined) return <p className="muted">正在加载记忆…</p>;

  if (path !== undefined) {
    return (
      <>
        <div className="panel-row">
          <button type="button" onClick={() => setPath(undefined)}>
            ← 返回
          </button>
          <code className="muted">{path}</code>
        </div>
        {content === undefined ? (
          <p className="muted">正在加载…</p>
        ) : path.endsWith(".md") ? (
          <div className="memory-file">
            <Prose text={content} />
          </div>
        ) : (
          <pre className="memory-file">{content}</pre>
        )}
      </>
    );
  }

  return (
    <>
      <div className="panel-row">
        <span className="muted">{`${listing.files.length} 个文件`}</span>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          刷新
        </button>
      </div>
      {listing.files.length === 0 ? (
        <p className="muted">暂无记忆</p>
      ) : (
        <ul className="subtasks">
          {listing.files.map((file) => (
            <li key={file}>
              <button type="button" className="file-link" onClick={() => open(file)}>
                {file}
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing.commits.length > 0 && <h3>最近整理</h3>}
      <ul className="subtasks">
        {listing.commits.map((commit) => (
          <li key={commit.oid}>
            <span className="muted">{`${new Date(commit.at).toLocaleString("zh-CN")} · `}</span>
            {commit.message.split("\n")[0]}
          </li>
        ))}
      </ul>
    </>
  );
}
