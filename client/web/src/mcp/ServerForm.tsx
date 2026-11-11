import { useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, KeyRound, Loader2, Plus, ShieldCheck, X } from "lucide-react";
import { MCP_MASK, MCP_SERVER_NAME, type McpServerInput, type McpServerView } from "@lulu/core/protocol/mcp.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  readonly server: McpServerView | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onSave: (name: string, input: McpServerInput) => void;
  readonly onCancel: () => void;
  readonly onBack?: () => void;
}

interface Pair { id: number; name: string; value: string }

export function ServerForm({ server, busy, error, onSave, onCancel, onBack }: Props) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [pairs, setPairs] = useState<Pair[]>(Object.entries(server?.headers ?? {}).map(([header, value], id) => ({ id, name: header, value })));
  const [nextId, setNextId] = useState(pairs.length);
  const [advanced, setAdvanced] = useState(pairs.length > 0);
  const valid = MCP_SERVER_NAME.test(name) && /^https?:\/\//i.test(url.trim());
  const change = (id: number, patch: Partial<Pair>) => setPairs(pairs.map((pair) => pair.id === id ? { ...pair, ...patch } : pair));

  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]" showCloseButton={!busy}>
      <DialogHeader className="text-left">
        {onBack !== undefined && <Button variant="ghost" size="sm" className="-ml-2 w-fit text-xs text-muted-foreground" disabled={busy} onClick={onBack}><ArrowLeft className="size-3.5" />返回目录</Button>}
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl border bg-muted/50"><Plus className="size-5" /></div>
        <DialogTitle>{server === undefined ? "手动添加" : "编辑连接"}</DialogTitle>
        <DialogDescription>填入服务的 MCP 地址，lulu 会自动完成连接或引导你授权。</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        onSave(name, { url: url.trim(), headers: Object.fromEntries(pairs.filter((pair) => pair.name.trim() !== "").map((pair) => [pair.name.trim(), pair.value])) });
      }}>
        <fieldset disabled={busy} className="space-y-5 py-2 disabled:opacity-70">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">连接名称</Label>
            <Input id="mcp-name" value={name} disabled={server !== undefined} placeholder="例如 linear" autoCapitalize="none" autoCorrect="off" autoComplete="off" required pattern={"[A-Za-z0-9_\\-]+"} onChange={(event) => setName(event.target.value)} />
            <p className="text-xs text-muted-foreground">使用字母、数字、下划线或连字符，创建后不可更改。</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-url">MCP 服务器地址</Label>
            <Input id="mcp-url" type="url" value={url} placeholder="https://mcp.example.com/mcp" autoCapitalize="none" autoCorrect="off" autoComplete="off" required onChange={(event) => setUrl(event.target.value)} />
            <p className="text-xs text-muted-foreground">支持 HTTP / HTTPS。需要 OAuth 的服务会在连接后打开授权页面。</p>
          </div>
          <Collapsible open={advanced} onOpenChange={setAdvanced} className="rounded-lg border">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="h-auto w-full justify-between rounded-lg px-3 py-3 text-sm">
                <span className="flex items-center gap-2"><KeyRound className="size-4 text-muted-foreground" />请求头<span className="font-normal text-muted-foreground">可选{pairs.length > 0 ? ` · ${pairs.length}` : ""}</span></span>
                <ChevronDown className={`size-4 text-muted-foreground transition-transform ${advanced ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 border-t p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">使用 API Key 的服务可在这里添加凭证。OAuth 连接通常无需填写。</p>
              {pairs.map((pair) => (
                <div key={pair.id} className="flex items-start gap-2">
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <Input aria-label={`请求头 ${pair.id + 1} 名称`} value={pair.name} placeholder="Authorization" autoCapitalize="none" autoCorrect="off" autoComplete="off" onChange={(event) => change(pair.id, { name: event.target.value })} />
                    <Input aria-label={`请求头 ${pair.id + 1} 值`} type="password" value={pair.value} placeholder="Bearer …" autoComplete="off" onChange={(event) => change(pair.id, { value: event.target.value })} />
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`移除请求头 ${pair.id + 1}`} onClick={() => setPairs(pairs.filter((item) => item.id !== pair.id))}><X className="size-4" /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => { setPairs([...pairs, { id: nextId, name: "", value: "" }]); setNextId(nextId + 1); }}><Plus />添加请求头</Button>
            </CollapsibleContent>
          </Collapsible>
          {server !== undefined && <p className="text-xs text-muted-foreground">保留 {MCP_MASK} 即沿用已保存的密钥，输入新值即可替换。</p>}
          {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </fieldset>
        <div className="mt-5 flex items-center gap-2 border-t pt-4 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" />凭证加密保存，密钥不会明文返回。</div>
        <DialogFooter className="mt-5">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
          <Button type="submit" disabled={!valid || busy}>{busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}{busy ? "正在连接…" : server === undefined ? "添加并连接" : "保存并连接"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
