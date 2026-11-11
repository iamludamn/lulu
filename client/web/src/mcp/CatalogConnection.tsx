import { useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { MCP_SERVER_NAME, type McpCatalogServer, type McpServerInput } from "@lulu/core/protocol/mcp.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { catalogFields, catalogInput, catalogName } from "./catalog-input";

interface Props {
  readonly server: McpCatalogServer;
  readonly taken: readonly string[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onBack: () => void;
  readonly onSave: (name: string, input: McpServerInput) => void;
}

export function CatalogConnection({ server, taken, busy, error, onBack, onSave }: Props) {
  const [name, setName] = useState(() => catalogName(server, taken));
  const [remoteIndex, setRemoteIndex] = useState(0);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const remote = server.remotes[remoteIndex];
  const fields = catalogFields(remote);
  const input = catalogInput(remote, values);
  const collision = [...taken, "artifact", "tavily", "exa"].some((other) => other.replaceAll("-", "_") === name.replaceAll("-", "_"));
  const valid = MCP_SERVER_NAME.test(name) && !collision && input !== undefined;

  return <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]" showCloseButton={!busy}>
    <DialogHeader className="text-left"><Button variant="ghost" size="sm" className="mb-2 -ml-2 w-fit text-xs text-muted-foreground" disabled={busy} onClick={onBack}><ArrowLeft className="size-3.5" />返回目录</Button><DialogTitle>连接 {server.title}</DialogTitle><DialogDescription>{server.description}</DialogDescription></DialogHeader>
    <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSave(name, input); }}>
      <fieldset disabled={busy} className="space-y-5 py-2 disabled:opacity-70">
        <div className="space-y-2"><Label htmlFor="catalog-name">连接名称</Label><Input id="catalog-name" required value={name} pattern={"[A-Za-z0-9_\\-]+"} autoCapitalize="none" autoComplete="off" onChange={(event) => setName(event.target.value)} />{collision && <p className="text-xs text-destructive">这个名称已被使用，请换一个名称。</p>}</div>
        <div className="space-y-2"><Label htmlFor="catalog-remote">服务地址</Label>{server.remotes.length > 1 ? <Select value={String(remoteIndex)} onValueChange={(value) => { setRemoteIndex(Number(value)); setValues({}); }}><SelectTrigger id="catalog-remote" className="h-auto min-h-9 w-full [&_[data-slot=select-value]]:whitespace-normal [&_[data-slot=select-value]]:break-all"><SelectValue /></SelectTrigger><SelectContent>{server.remotes.map((remote, index) => <SelectItem key={index} value={String(index)} className="break-all">{remote.url}</SelectItem>)}</SelectContent></Select> : <p id="catalog-remote" className="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed break-all">{remote.url}</p>}<p className="text-xs break-all text-muted-foreground">发布者：{server.name}</p></div>
        {fields.filter((field) => field.value === undefined).map((field, index) => <div key={field.id} className="space-y-2"><Label htmlFor={`catalog-field-${index}`}>{field.label}<span className="font-normal text-muted-foreground">{field.isRequired ? "必填" : "可选"}</span></Label>{field.choices !== undefined && field.choices.length > 0 ? <Select value={values[field.id] ?? field.default ?? ""} onValueChange={(value) => setValues({ ...values, [field.id]: value })}><SelectTrigger id={`catalog-field-${index}`} className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger><SelectContent>{field.choices.map((choice) => <SelectItem key={choice} value={choice}>{choice}</SelectItem>)}</SelectContent></Select> : <Input id={`catalog-field-${index}`} type={field.isSecret ? "password" : field.format === "number" ? "number" : "text"} required={field.isRequired} value={values[field.id] ?? field.default ?? ""} placeholder={field.placeholder} autoCapitalize="none" autoComplete="off" onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} />}{field.description !== undefined && <p className="text-xs leading-relaxed break-words text-muted-foreground">{field.description}</p>}</div>)}
        {error !== undefined && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </fieldset>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">需要账号授权的服务，会自动打开服务方的授权页面。</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />凭证加密保存</span>{server.websiteUrl !== undefined && <a href={server.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">服务官网<ExternalLink className="size-3" /></a>}</div>
      <DialogFooter className="mt-5"><Button type="button" variant="outline" disabled={busy} onClick={onBack}>返回目录</Button><Button type="submit" disabled={!valid || busy}>{busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}{busy ? "正在连接…" : "添加并连接"}</Button></DialogFooter>
    </form>
  </DialogContent>;
}
