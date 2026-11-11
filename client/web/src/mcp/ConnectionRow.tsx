import { Cable, Check, CircleAlert, Ellipsis, KeyRound, Loader2, Pencil, RefreshCw, Trash2, Wrench } from "lucide-react";
import type { McpStatus } from "@lulu/core/protocol/contract.js";
import type { McpServerView } from "@lulu/core/protocol/mcp.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface Props {
  readonly name: string;
  readonly server?: McpServerView;
  readonly status: McpStatus | undefined;
  readonly busy: string;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
  readonly onConnect?: () => void;
}

export function ConnectionRow({ name, server, status, busy, onEdit, onRemove, onConnect }: Props) {
  const connected = status?.state === "connected";
  const needsAuth = status?.state === "needs-auth";
  const failed = status?.state === "failed";
  const working = busy === `login:${name}` || busy === `retry:${name}` || busy === `remove:${name}`;
  const Icon = connected ? Check : needsAuth ? KeyRound : failed ? CircleAlert : Cable;
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3.5">
        <div className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/40"><Cable className="size-5 text-muted-foreground" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 flex-wrap items-center gap-2">
            <span className="break-all text-sm font-semibold">{name}</span>
            <Badge variant="outline" className={cn("gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium", connected && "border-emerald-500/15 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400", needsAuth && "border-amber-500/20 bg-amber-500/8 text-amber-600 dark:text-amber-400", failed && "border-destructive/15 bg-destructive/5 text-destructive")}>
              {working ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
              {working ? "处理中" : connected ? "已连接" : needsAuth ? "需要授权" : failed ? "连接失败" : "未连接"}
            </Badge>
          </div>
          {server !== undefined && <p className="mt-1 truncate text-xs text-muted-foreground" title={server.url}>{server.url}</p>}
          {connected && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Wrench className="size-3" />{status.tools} 个工具可用</p>}
          {failed && status.error !== undefined && <p className="mt-2 break-words text-xs leading-relaxed text-destructive">{status.error}</p>}
          {server !== undefined && !connected && <Button size="sm" variant={needsAuth ? "default" : "outline"} className="mt-3 h-8 text-xs" disabled={busy !== ""} onClick={onConnect}>{working ? <Loader2 className="animate-spin" /> : needsAuth ? <KeyRound /> : <RefreshCw />}{needsAuth ? "授权连接" : "重试连接"}</Button>}
        </div>
        {server !== undefined && <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="-mr-1 size-8 shrink-0 text-muted-foreground" disabled={busy !== ""} aria-label={`管理 ${name}`}><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={onEdit}><Pencil />编辑连接</DropdownMenuItem>
            <DropdownMenuItem onSelect={onConnect}><RefreshCw />{needsAuth ? "授权连接" : "重新连接"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}><Trash2 />删除连接</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
    </div>
  );
}
