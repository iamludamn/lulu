import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Cable, Check, ChevronDown, CircleAlert, Layers2, LockKeyhole, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { McpRegistryView, McpServerInput, McpServerView } from "@lulu/core/protocol/mcp.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Unauthorized, registry, saveToken, savedToken } from "./api";
import { ConnectionRow } from "./ConnectionRow";
import { ServerForm } from "./ServerForm";
import { TokenGate } from "./TokenGate";

interface Notice { readonly kind: "ok" | "bad"; readonly text: string }
type Editing = { readonly server: McpServerView | undefined } | undefined;

function noticeFromLocation(): Notice | undefined {
  const params = new URLSearchParams(location.search);
  const login = params.get("login");
  const error = params.get("error");
  if (login === null && error === null) return undefined;
  history.replaceState(null, "", location.pathname);
  return error === null ? { kind: "ok", text: `${login} 已成功连接，工具现在可以使用了。` } : { kind: "bad", text: `授权未完成：${error}` };
}

export function McpPage() {
  const [token, setToken] = useState(savedToken);
  const [invalid, setInvalid] = useState(false);
  const [view, setView] = useState<McpRegistryView | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | undefined>(noticeFromLocation);
  const [editing, setEditing] = useState<Editing>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState<string | undefined>(undefined);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [builtinOpen, setBuiltinOpen] = useState(false);

  const run = useCallback(async (label: string, action: () => Promise<McpRegistryView | undefined>) => {
    setBusy(label);
    if (label !== "list") setNotice(undefined);
    if (label === "save") setFormError(undefined);
    if (label.startsWith("remove:")) setDeleteError(undefined);
    try {
      const next = await action();
      if (next !== undefined) setView(next);
      return true;
    } catch (error) {
      if (error instanceof Unauthorized) {
        saveToken("");
        setToken("");
        setView(undefined);
        setEditing(undefined);
        setDeleting(undefined);
        setInvalid(true);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        if (label === "save") setFormError(message);
        else if (label.startsWith("remove:")) setDeleteError(message);
        else setNotice({ kind: "bad", text: message });
      }
      return false;
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => { if (token !== "") void run("list", () => registry.list(token)); }, [token, run]);

  const enter = (value: string) => { saveToken(value); setInvalid(false); setToken(value); };
  const lock = () => { saveToken(""); setToken(""); setView(undefined); setNotice(undefined); };
  const edit = (server?: McpServerView) => { setFormError(undefined); setEditing({ server }); };
  const login = (name: string) => run(`login:${name}`, async () => {
    const result = await registry.login(token, name);
    if (result.authorizationUrl !== undefined) location.assign(result.authorizationUrl);
    return result.authorizationUrl === undefined ? registry.list(token) : undefined;
  });
  const save = async (name: string, input: McpServerInput) => {
    let next: McpRegistryView | undefined;
    if (await run("save", async () => { next = await registry.save(token, name, input); return next; })) {
      setEditing(undefined);
      if (next?.statuses.some((status) => status.name === name && status.state === "needs-auth")) await login(name);
      else setNotice({ kind: "ok", text: `已保存 ${name} 的连接配置。` });
    }
  };
  const remove = async () => {
    if (deleting !== undefined && await run(`remove:${deleting}`, () => registry.remove(token, deleting))) {
      setNotice({ kind: "ok", text: `已删除 ${deleting}。` });
      setDeleting(undefined);
    }
  };
  const statuses = new Map((view?.statuses ?? []).map((status) => [status.name, status]));
  const builtin = (view?.statuses ?? []).filter((status) => status.source === "platform");
  const connected = view?.servers.filter((server) => statuses.get(server.name)?.state === "connected").length ?? 0;
  const attention = (view?.servers.length ?? 0) - connected;

  return (
    <div className="min-h-dvh">
      <header className="border-b bg-card/70">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
          <a href="/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight"><img src="/icon.svg" alt="" className="size-7" />lulu<Separator orientation="vertical" className="mx-2 !h-4" /><span className="font-normal text-muted-foreground">连接</span></a>
          {token !== "" && <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" disabled={busy !== ""} onClick={lock}><LockKeyhole className="size-3.5" /><span className="hidden sm:inline">锁定配置页</span></Button>}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-[calc(3rem+env(safe-area-inset-bottom))] pt-10 sm:px-8 sm:pt-14">
        {token === "" ? <TokenGate onToken={enter} invalid={invalid} /> : <>
          <div className="mb-9 flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-center">
            <div><p className="mb-2 text-xs font-medium tracking-wider text-muted-foreground">工作空间 / 工具与数据</p><h1 className="text-3xl font-semibold tracking-tight">连接你的工具</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">把日常使用的服务交给 lulu，让对话连接到你的工作。</p></div>
            <Button className="shrink-0 shadow-sm" disabled={busy !== ""} onClick={() => edit()}><Plus />添加连接</Button>
          </div>
          {notice !== undefined && <Alert variant={notice.kind === "bad" ? "destructive" : "default"} className="mb-6 bg-card pr-10" role="status">{notice.kind === "bad" ? <CircleAlert /> : <Check className="text-emerald-600" />}<AlertDescription className={notice.kind === "ok" ? "text-foreground" : undefined}>{notice.text}</AlertDescription><Button variant="ghost" size="icon" className="absolute top-2 right-2 size-6" aria-label="关闭提示" onClick={() => setNotice(undefined)}><X className="size-3.5" /></Button></Alert>}
          <section aria-labelledby="connections-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2"><h2 id="connections-heading" className="text-sm font-semibold">你的连接</h2>{view !== undefined && <Badge variant="secondary" className="rounded-md px-1.5 text-[10px]">{view.servers.length}</Badge>}</div>
              {view !== undefined && <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />{connected} 已连接</span>{attention > 0 && <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-amber-500" />{attention} 待处理</span>}<Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" disabled={busy !== ""} onClick={() => void run("reload", () => registry.reload(token))}><RefreshCw className={busy === "reload" ? "size-3 animate-spin" : "size-3"} />刷新连接</Button></div>}
            </div>
            {view === undefined ? busy === "list" ? <Card className="gap-0 overflow-hidden py-0 shadow-none">{[0, 1, 2].map((row) => <div className="flex items-center gap-4 border-b p-5 last:border-b-0" key={row}><Skeleton className="size-11 rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-48 max-w-full" /></div><Skeleton className="h-6 w-14" /></div>)}</Card> : <Card className="shadow-none"><CardContent className="text-center"><CircleAlert className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm font-medium">暂时无法加载连接</p><p className="mt-1 text-xs text-muted-foreground">检查网络后再试一次。</p><Button variant="outline" size="sm" className="mt-4" onClick={() => void run("list", () => registry.list(token))}><RefreshCw />重新加载</Button></CardContent></Card> : view.servers.length === 0 ? <Card className="border-dashed py-0 shadow-none"><CardContent className="flex flex-col items-center px-6 py-14 text-center"><div className="mb-5 flex size-14 items-center justify-center rounded-2xl border bg-background shadow-xs"><Cable className="size-6 text-muted-foreground" /></div><h3 className="text-base font-semibold">从一个连接开始</h3><p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">添加 MCP 服务，让 lulu 获取上下文、查找信息，或调用你常用的工具。</p><Button variant="outline" className="mt-6" onClick={() => edit()}><Plus />添加第一个连接</Button><span className="mt-4 text-xs text-muted-foreground">支持远程 HTTP / HTTPS 服务</span></CardContent></Card> : <Card className="gap-0 divide-y overflow-hidden py-0 shadow-none">{view.servers.map((server) => <ConnectionRow key={server.name} name={server.name} server={server} status={statuses.get(server.name)} busy={busy} onEdit={() => edit(server)} onRemove={() => { setDeleteError(undefined); setDeleting(server.name); }} onConnect={() => void (statuses.get(server.name)?.state === "needs-auth" ? login(server.name) : run(`retry:${server.name}`, () => registry.reconnect(token, server.name)))} />)}</Card>}
          </section>
          {builtin.length > 0 && <Collapsible open={builtinOpen} onOpenChange={setBuiltinOpen} className="mt-7"><CollapsibleTrigger asChild><Button variant="ghost" className="mb-2 h-auto w-full justify-between px-0 py-2 text-muted-foreground hover:bg-transparent"><span className="flex items-center gap-2 text-xs"><Layers2 className="size-3.5" />内置连接<Badge variant="secondary" className="rounded-md px-1.5 text-[10px]">{builtin.length}</Badge></span><ChevronDown className={`size-3.5 transition-transform ${builtinOpen ? "rotate-180" : ""}`} /></Button></CollapsibleTrigger><CollapsibleContent><Card className="gap-0 divide-y overflow-hidden py-0 shadow-none">{builtin.map((status) => <ConnectionRow key={status.name} name={status.name} status={status} busy={busy} />)}</Card><p className="mt-2 text-xs text-muted-foreground">由工作空间提供，无需单独配置。</p></CollapsibleContent></Collapsible>}
          <div className="mt-9 flex flex-col gap-2 border-t pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />凭证加密保存，只向服务方发送</span><a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 transition-colors hover:text-foreground">了解 MCP<ArrowUpRight className="size-3" /></a></div>
        </>}
      </main>
      <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open && busy !== "save") setEditing(undefined); }}>{editing !== undefined && <ServerForm key={editing.server?.name ?? "new"} server={editing.server} busy={busy === "save"} error={formError} onSave={(name, input) => void save(name, input)} onCancel={() => setEditing(undefined)} />}</Dialog>
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => { if (!open && !busy.startsWith("remove:")) setDeleting(undefined); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除「{deleting}」？</AlertDialogTitle><AlertDialogDescription>lulu 将无法再使用这个连接的工具，已保存的凭证也会移除。之后可以重新添加。</AlertDialogDescription></AlertDialogHeader>{deleteError !== undefined && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={busy !== ""}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy !== ""} onClick={(event) => { event.preventDefault(); void remove(); }}>{busy.startsWith("remove:") ? "正在删除…" : "删除连接"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
