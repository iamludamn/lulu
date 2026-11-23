import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { Environment } from "../host/types.js";
import { PanelDoc } from "../panel.js";
import { SpaceRefreshDoc, SpaceRefreshIndex, spaceEntries, type Refresh } from "./doc.js";
import { bytes, json, record, SourceError } from "./source.js";

const encoder = new TextEncoder();
const base64url = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const segment = (value: object): string => base64url(encoder.encode(JSON.stringify(value)));

function config(env: Environment) {
  const { LULU_APNS_TEAM_ID: team, LULU_APNS_KEY_ID: id, LULU_APNS_KEY: key, LULU_APNS_TOPIC: topic } = env;
  return team && id && key && topic ? { team, id, key, topic, host: env.LULU_APNS_SANDBOX === "true" ? "api.sandbox.push.apple.com" : "api.push.apple.com" } : null;
}

let jwt: { forConfig: string; until: number; value: string } | undefined;

async function authorization(settings: NonNullable<ReturnType<typeof config>>, now: number): Promise<string> {
  const forConfig = settings.team + ":" + settings.id;
  if (jwt?.forConfig === forConfig && jwt.until > now) return jwt.value;
  const bytes = Uint8Array.from(atob(settings.key.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const message = segment({ alg: "ES256", kid: settings.id }) + "." + segment({ iss: settings.team, iat: Math.floor(now / 1000) });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(message));
  const value = "bearer " + message + "." + base64url(new Uint8Array(signature));
  jwt = { forConfig, until: now + 45 * 60_000, value };
  return value;
}

export async function spaceDevice(harness: Harness, request: Request): Promise<Response> {
  if (request.method !== "POST") throw new SourceError(405, "Method not allowed");
  const input = record(json(await bytes(request)));
  const token = input.token;
  if (typeof token !== "string" || !/^(?:[a-f0-9]{2}){16,128}$/.test(token) || (input.action !== "register" && input.action !== "remove")) throw new SourceError(400, "Invalid device");
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SpaceRefreshIndex);
    const devices = doc.devices ?? [];
    doc.devices = input.action === "register" ? [...devices.filter((item) => item !== token), token].slice(-12) : devices.filter((item) => item !== token);
  }, context);
  return new Response(null, { status: 204 });
}

const waiting = (entry: Refresh): boolean => entry.enabled && entry.notify && entry.version > Math.max(entry.seen, entry.delivered);

export async function nextPushAlarm(harness: Harness, env: Environment): Promise<number | undefined> {
  if (config(env) === null) return undefined;
  const doc = await harness.snapshot(SpaceRefreshIndex, context);
  if (!doc?.devices?.length || !(await spaceEntries(harness, doc.ids)).some(([, entry]) => waiting(entry))) return undefined;
  return doc.pushRetryAt ?? Date.now();
}

export async function sendSpacePushes(harness: Harness, env: Environment, now: number): Promise<void> {
  const settings = config(env);
  if (!settings) return;
  const doc = await harness.snapshot(SpaceRefreshIndex, context);
  if (!doc?.devices?.length || (doc.pushRetryAt ?? 0) > now) return;
  const panel = await harness.snapshot(PanelDoc, context);
  const pending = (await spaceEntries(harness, doc.ids)).filter(([id, entry]) => Object.hasOwn(panel?.widgets ?? {}, id) && waiting(entry)).slice(0, 4);
  if (!pending.length) return;
  const expired = new Set<string>();
  const delivered = new Map<string, number>();
  let retry = false;

  try {
    const token = await authorization(settings, now);
    for (const [id, entry] of pending) {
      const collapse = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(id + ":" + entry.version))));
      const results = await Promise.allSettled(doc.devices.filter((device) => !expired.has(device)).map(async (device) => {
        const response = await fetch(`https://${settings.host}/3/device/${device}`, {
          method: "POST", signal: AbortSignal.timeout(10_000), redirect: "error",
          headers: { authorization: token, "content-type": "application/json", "apns-topic": settings.topic, "apns-push-type": "alert", "apns-collapse-id": collapse },
          body: JSON.stringify({ aps: { alert: { title: (panel?.widgets[id]?.title ?? "Lulu").slice(0, 140), body: "有新内容" }, sound: "default", "thread-id": id }, space: id }),
        });
        if (response.ok) return;
        const failure = record(await response.json().catch(() => null)).reason;
        if (response.status === 410 || failure === "BadDeviceToken" || failure === "DeviceTokenNotForTopic") {
          expired.add(device);
          return;
        }
        throw new Error(`APNs status ${response.status}`);
      }));
      if (results.some((result) => result.status === "rejected")) retry = true;
      else delivered.set(id, entry.version);
    }
  } catch {
    retry = true;
  }

  await harness.commit(async (tx) => {
    const draft = await tx.doc(SpaceRefreshIndex);
    const latest = await tx.doc(PanelDoc);
    if (draft.devices) draft.devices = draft.devices.filter((device) => !expired.has(device));
    draft.pushRetryAt = retry ? now + 5 * 60_000 : null;
    for (const [id, version] of delivered) {
      const { entry } = await tx.doc(SpaceRefreshDoc, id, null);
      if (entry && Object.hasOwn(latest.widgets, id)) entry.delivered = Math.max(entry.delivered, version);
    }
  }, context);
  if (retry) console.error("Space notification delivery failed");
}
