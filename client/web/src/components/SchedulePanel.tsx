import { useEffect, useState } from "react";
import type { ScheduleEntry } from "../protocol";
import { loadSchedules } from "../session/bots";

const STATE_LABEL: Record<ScheduleEntry["state"], string> = { active: "运行中", paused: "已暂停", done: "已完成", missed: "已错过" };
const RUN_LABEL: Record<NonNullable<ScheduleEntry["lastRun"]>["status"], string> = { running: "执行中", done: "成功", failed: "失败", closed: "已关闭" };

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback);

const timeOf = (ms: number): string => new Date(ms).toLocaleString("zh-CN");

const scheduleOf = (entry: ScheduleEntry): string =>
  entry.schedule.kind === "once" ? timeOf(entry.schedule.at) : `每天 ${entry.schedule.time}（${entry.schedule.tz}）`;

export function SchedulePanel({ botId }: { botId: string }) {
  const [entries, setEntries] = useState<ScheduleEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    loadSchedules(botId)
      .then((loaded) => {
        if (alive) setEntries(loaded);
      })
      .catch((failure: unknown) => {
        if (alive) setError(messageOf(failure, "加载定时任务失败"));
      });
    return () => {
      alive = false;
    };
  }, [botId]);

  if (error !== undefined) return <p className="muted">{error}</p>;
  if (entries === undefined) return <p className="muted">正在加载定时任务…</p>;
  if (entries.length === 0) return <p className="muted">暂无定时任务</p>;

  return (
    <ul className="subtasks">
      {entries.map((entry) => (
        <li key={entry.id}>
          <span className={entry.state === "active" ? "dot on" : "dot"} aria-hidden="true" />
          <span className="item-body">
            <span>
              {entry.name}
              <span className="tag">{STATE_LABEL[entry.state]}</span>
            </span>
            <span className="muted">{scheduleOf(entry)}</span>
            {entry.nextRunAt !== null && entry.state === "active" && <span className="muted">{`下次 ${timeOf(entry.nextRunAt)}`}</span>}
            {entry.lastRun !== null && (
              <span className={entry.lastRun.status === "failed" ? "muted warn" : "muted"}>
                {`上次 ${timeOf(entry.lastRun.scheduledFor)} ${RUN_LABEL[entry.lastRun.status]}`}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
