import { useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TokenGate({ onToken, invalid }: { onToken: (token: string) => void; invalid: boolean }) {
  const [token, setToken] = useState("");
  return (
    <div className="mx-auto w-full max-w-sm py-8 sm:py-16">
      <Card className="gap-5 shadow-sm">
        <CardHeader>
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl border bg-muted/50"><LockKeyhole className="size-5 text-muted-foreground" /></div>
          <CardTitle className="text-xl tracking-tight">管理你的连接</CardTitle>
          <CardDescription className="leading-relaxed">输入管理口令，为 lulu 添加或管理工具与数据连接。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (token !== "") onToken(token); }}>
            <div className="space-y-2"><Label htmlFor="mcp-token">管理口令</Label><Input id="mcp-token" type="password" value={token} autoComplete="off" aria-invalid={invalid} aria-describedby="token-help" onChange={(event) => setToken(event.target.value)} /><p id="token-help" className={invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{invalid ? "口令不正确，请重新输入。" : "口令只保存在当前浏览器中。"}</p></div>
            <Button className="w-full" type="submit" disabled={token === ""}>进入配置<ArrowRight /></Button>
          </form>
          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" />你的服务凭证始终加密保存</p>
        </CardContent>
      </Card>
    </div>
  );
}
