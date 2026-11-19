import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { CHAT_DELIVERY_WINDOW_MS, ChatDeliveryDoc, type ChatDelivery } from "./delivery-doc.js";

const METRIC = "lulu_chat_delivery_window";
const QUERY = /^lulu_chat_delivery_window\{measure="([a-z0-9_]+)",from="(\d{1,13})",to="(\d{1,13})"(?:,release="(all)")?\}$/;
const headers = { "Cache-Control": "no-store" };

function outcome(request: ChatDelivery, now: number): string {
  if (request.receipt) return "delivered";
  if (request.final) return request.deadline <= now ? "missing_receipt" : "awaiting_receipt";
  if (request.terminal) return request.terminal;
  return request.deadline <= now ? "no_result" : "pending";
}

function aggregate(requests: ChatDelivery[], measure: string, now: number): [string, number][] {
  if (measure === "accepted") return [["all", requests.length]];
  if (measure === "final_delivery_fraction") return [["all", requests.filter((item) => item.receipt).length / requests.length]];
  if (measure === "overdue") return [["all", requests.filter((item) => !item.receipt && item.terminal !== "cancelled" && item.deadline <= now).length]];
  if (measure === "first_reply_p95_seconds") {
    const latencies = requests.flatMap((item) => item.firstAt === undefined ? [] : [Math.max(0, item.firstAt - item.acceptedAt)]).sort((a, b) => a - b);
    return latencies.length > 0 ? [["all", latencies[Math.ceil(latencies.length * 0.95) - 1]! / 1000]] : [];
  }
  if (measure === "outcome") {
    const counts = new Map<string, number>();
    for (const item of requests) {
      const key = outcome(item, now);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts];
  }
  return [];
}

export async function chatDeliveryQuery(request: Request, read: DocumentReader): Promise<Response> {
  const match = QUERY.exec(new URL(request.url).searchParams.get("query") ?? "");
  const from = Number(match?.[2]);
  const to = Number(match?.[3]);
  if (!match || from >= to || to - from > CHAT_DELIVERY_WINDOW_MS) {
    return Response.json({ status: "error", errorType: "bad_data", error: "Select a window of up to seven days" }, { status: 400, headers });
  }
  const now = Date.now();
  const lower = Math.max(from, now - CHAT_DELIVERY_WINDOW_MS);
  const state = await read.snapshot(ChatDeliveryDoc, BACKGROUND_CONTEXT);
  const requests = (state?.requests ?? []).filter((item) => item.acceptedAt >= lower && item.acceptedAt < to);
  const groups = new Map<string, ChatDelivery[]>();
  if (match[4] === "all") {
    if (requests.length > 0) groups.set("all", requests);
  } else {
    for (const item of requests) {
      const group = groups.get(item.release) ?? [];
      group.push(item);
      groups.set(item.release, group);
    }
  }
  const measure = match[1]!;
  const result = [...groups].flatMap(([release, items]) =>
    aggregate(items, measure, now).map(([outcome, value]) => ({
      metric: { __name__: METRIC, measure, release, outcome },
      value: [now / 1000, String(value)],
    })));
  return Response.json({ status: "success", data: { resultType: "vector", result } }, { headers });
}
