import { useEffect, useState } from "react";
import type { DefaultAccess, Grant, PermissionsUpdate, PermissionsView } from "../protocol";
import { loadPermissions, savePermissions } from "../session/bots";

const DEFAULT_ACCESSES: readonly DefaultAccess[] = ["none", "read", "full"];
const DEFAULT_LABEL: Record<DefaultAccess, string> = { none: "无", read: "只读", full: "Full Access" };

const messageOf = (failure: unknown, fallback: string): string => (failure instanceof Error ? failure.message : fallback);

export function Permissions({ botId }: { botId: string }) {
  const [view, setView] = useState<PermissionsView>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    loadPermissions(botId)
      .then((loaded) => {
        if (alive) setView(loaded);
      })
      .catch((failure: unknown) => {
        if (alive) setError(messageOf(failure, "加载权限失败"));
      });
    return () => {
      alive = false;
    };
  }, [botId]);

  const save = async (update: PermissionsUpdate) => {
    setError(undefined);
    setSaving(true);
    try {
      setView(await savePermissions(botId, update));
    } catch (failure) {
      setError(messageOf(failure, "保存权限失败"));
    } finally {
      setSaving(false);
    }
  };

  if (view === undefined) {
    return (
      <section>
        {error === undefined ? <p className="muted">加载中…</p> : <p className="error">{error}</p>}
      </section>
    );
  }

  const others = view.people.filter((person) => person.accountId !== view.owner);

  const regrant = (accountId: string, level: Grant | "remove") => {
    const rest = Object.entries(view.grants).filter(([key]) => key !== accountId);
    const grants = Object.fromEntries(level === "remove" ? rest : [...rest, [accountId, level] as const]);
    save({ defaultAccess: view.defaultAccess, grants });
  };

  return (
    <section className="permissions">
      <fieldset disabled={saving}>
        <legend>默认访问级别</legend>
        {DEFAULT_ACCESSES.map((level) => (
          <label key={level} className="radio">
            <input
              type="radio"
              name="default-access"
              checked={view.defaultAccess === level}
              onChange={() => save({ defaultAccess: level, grants: view.grants })}
            />
            {DEFAULT_LABEL[level]}
          </label>
        ))}
      </fieldset>
      <fieldset disabled={saving}>
        <legend>逐人授权</legend>
        {others.length === 0 && <p className="muted">暂无其他人员</p>}
        {others.map((person) => (
          <label key={person.accountId} className="grant">
            <span>{person.name}</span>
            <select
              value={Object.hasOwn(view.grants, person.accountId) ? view.grants[person.accountId] : "remove"}
              onChange={(event) => regrant(person.accountId, event.currentTarget.value as Grant | "remove")}
            >
              <option value="remove">移除</option>
              <option value="read">只读</option>
              <option value="full">Full Access</option>
            </select>
          </label>
        ))}
      </fieldset>
      {saving && <p className="muted">保存中…</p>}
      {error !== undefined && <p className="error">{error}</p>}
    </section>
  );
}
