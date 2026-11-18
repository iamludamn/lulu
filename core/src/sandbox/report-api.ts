import type { Context } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { ACCOUNTING_WINDOW_MS, SandboxAccountingDoc } from "./accounting.js";
import { sandboxReport } from "./report.js";

const QUERY = /^lulu_sandbox_window\{(?:measure="([a-z_]+)",)?from="(\d{1,13})",to="(\d{1,13})"\}$/;
const headers = { "Cache-Control": "no-store" };

function vector(result: Record<string, number | null>, timestamp: number): Response {
  return Response.json({
    status: "success",
    data: {
      resultType: "vector",
      result: Object.entries(result).map(([measure, value]) => ({
        metric: { __name__: "lulu_sandbox_window", measure },
        value: [timestamp / 1000, value === null ? "NaN" : String(value)],
      })),
    },
  }, { headers });
}

export async function sandboxWindowQuery(request: Request, read: DocumentReader, context: Context): Promise<Response> {
  const query = new URL(request.url).searchParams.get("query") ?? "";
  const now = Date.now();
  if (query === "1+1" || query === "vector(1)") return vector({ health: query === "1+1" ? 2 : 1 }, now);
  const match = QUERY.exec(query);
  const from = Number(match?.[2]);
  const to = Number(match?.[3]);
  if (!match || from >= to || to - from > ACCOUNTING_WINDOW_MS) {
    return Response.json({ status: "error", errorType: "bad_data", error: "Select a window of up to seven days" }, { status: 400, headers });
  }
  const state = await read.snapshot(SandboxAccountingDoc, context);
  const result = state ? sandboxReport(state, from, to, now) : { uncovered_seconds: (to - from) / 1000 };
  const measure = match[1];
  return vector(measure ? Object.fromEntries(Object.entries(result).filter(([key]) => key === measure)) : result, to);
}
