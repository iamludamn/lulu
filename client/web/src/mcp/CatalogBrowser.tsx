import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Globe, Loader2, Plus, Search } from "lucide-react";
import type { McpCatalogPage, McpCatalogServer } from "@lulu/core/protocol/mcp.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { registry, Unauthorized } from "./api";

interface Props {
  readonly token: string;
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
  readonly onSelect: (server: McpCatalogServer) => void;
  readonly onManual: () => void;
  readonly onUnauthorized: () => void;
}

export function CatalogBrowser({ token, search, onSearchChange: setSearch, onSelect, onManual, onUnauthorized }: Props) {
  const [page, setPage] = useState<McpCatalogPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const query = search.trim();
  const short = query !== "" && Array.from(query).length < 3;

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setPage(undefined);
    setError(undefined);
    setLoading(!short);
    if (short) return () => abort.abort();
    const timer = setTimeout(() => {
      void registry.catalog(token, query, undefined, abort.signal).then((next) => {
        if (!abort.signal.aborted) setPage(next);
      }).catch((error: unknown) => {
        if (abort.signal.aborted) return;
        if (error instanceof Unauthorized) onUnauthorized();
        else setError(error instanceof Error ? error.message : String(error));
      }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, query === "" ? 0 : 350);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [token, query, short, retry, onUnauthorized]);

  const more = async () => {
    if (loading || page?.nextCursor === undefined) return;
    const abort = controller.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await registry.catalog(token, query, page.nextCursor, abort?.signal);
      if (abort?.signal.aborted) return;
      const servers = new Map([...page.servers, ...next.servers].map((server) => [server.name, server]));
      setPage({ ...next, servers: [...servers.values()], stale: page.stale || next.stale });
    } catch (error) {
      if (abort?.signal.aborted) return;
      if (error instanceof Unauthorized) onUnauthorized();
      else setError(error instanceof Error ? error.message : String(error));
    } finally { if (!abort?.signal.aborted) setLoading(false); }
  };

  return <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-auto sm:max-w-[680px]">
    <DialogHeader className="text-left"><div className="mb-2 flex size-11 items-center justify-center rounded-xl border bg-muted/50"><BookOpen className="size-5" /></div><DialogTitle>从目录添加</DialogTitle><DialogDescription>发现可连接的 MCP 服务，选好后即可连接你的账号。</DialogDescription></DialogHeader>
    <div className="relative"><Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" /><Input aria-label="搜索服务目录" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索服务，例如 Linear、Notion、GitHub" className="pl-9" autoComplete="off" />{search !== "" && <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" onClick={() => setSearch("")}><ArrowLeft className="size-3" />浏览全部</Button>}</div>
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Globe className="size-3.5" />MCP 官方目录</span><Badge variant="secondary" className="text-[10px]">远程 HTTP 服务</Badge></div>
    <div className="max-h-[48dvh] min-h-0 space-y-2 overflow-y-auto" aria-live="polite" aria-busy={loading}>
      {short ? <p className="py-10 text-center text-sm text-muted-foreground">请输入至少 3 个字符搜索服务。</p> : <>
        {page?.stale && <Alert><AlertDescription>目录更新暂不可用，正在显示上次缓存的结果。</AlertDescription></Alert>}
        {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}<Button variant="outline" size="sm" className="mt-2 w-fit" disabled={loading} onClick={() => page?.nextCursor !== undefined ? void more() : setRetry(retry + 1)}>重试</Button></AlertDescription></Alert>}
        {page?.servers.map((server) => <button key={server.name} type="button" onClick={() => onSelect(server)} className="group flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-sm font-semibold uppercase text-muted-foreground">{server.title.slice(0, 2)}</span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{server.title}</span><span className="mt-0.5 block break-all text-[11px] text-muted-foreground">{server.name}</span><span className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{server.description}</span></span><ArrowRight className="mt-3 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></button>)}
        {loading && page === undefined && [0, 1, 2].map((row) => <div key={row} className="flex gap-3 rounded-lg border p-4"><Skeleton className="size-10 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-44 max-w-full" /><Skeleton className="h-3 w-full" /></div></div>)}
        {!loading && page?.servers.length === 0 && <div className="py-10 text-center"><Search className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm font-medium">没有找到可连接的服务</p><p className="mt-2 text-xs text-muted-foreground">试试其他关键词，或使用服务提供的地址手动添加。</p></div>}
        {page?.nextCursor !== undefined && <Button variant="outline" className="w-full" disabled={loading} onClick={() => void more()}>{loading && <Loader2 className="animate-spin" />}{loading ? "正在加载…" : "加载更多服务"}</Button>}
      </>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground"><span>找不到你需要的服务？</span><Button variant="ghost" size="sm" onClick={onManual}><Plus className="size-3.5" />手动添加</Button></div>
  </DialogContent>;
}
