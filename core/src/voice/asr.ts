import type { DurableHost, Socket } from "../host/types.js";

export function asrPacket(kind: number, payload: Uint8Array): ArrayBuffer {
  const packet = new Uint8Array(8 + payload.length);
  packet.set([0x11, kind, kind === 0x10 ? 0x10 : 0, 0]);
  new DataView(packet.buffer).setUint32(4, payload.length);
  packet.set(payload, 8);
  return packet.buffer;
}

export async function asrResult(data: unknown): Promise<{ text: string; final: boolean }> {
  if (data instanceof Blob) data = await data.arrayBuffer();
  if (!(data instanceof ArrayBuffer)) throw new Error("ASR 返回格式错误");
  const bytes = new Uint8Array(data);
  if (bytes.length < 8 || bytes[0]! >> 4 !== 1) throw new Error("ASR 返回格式错误");
  const kind = bytes[1]! >> 4, flags = bytes[1]! & 15;
  let offset = (bytes[0]! & 15) * 4;
  if (kind === 15 || (flags & 1) !== 0) offset += 4;
  if (offset + 4 > bytes.length) throw new Error("ASR 返回不完整");
  const size = new DataView(data).getUint32(offset);
  if (offset + 4 + size !== bytes.length) throw new Error("ASR 返回不完整");
  let payload = bytes.slice(offset + 4);
  if ((bytes[2]! & 15) === 1) {
    payload = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } else if ((bytes[2]! & 15) !== 0) throw new Error("ASR 压缩格式不支持");
  if (kind === 15) throw new Error(`语音识别失败（${new DataView(data).getUint32((bytes[0]! & 15) * 4)}）`);
  if (kind !== 9) throw new Error("ASR 返回类型错误");
  let body: { result?: { text?: unknown } };
  try { body = JSON.parse(new TextDecoder().decode(payload)) as typeof body; }
  catch { throw new Error("ASR 返回的 JSON 无效"); }
  return { text: typeof body.result?.text === "string" ? body.result.text : "", final: (flags & 2) !== 0 };
}

type Recognition = { id: string; upstream?: Socket; timer: ReturnType<typeof setTimeout>; bytes: number; finishing: boolean; chain: Promise<void> };

export class AsrSessions {
  readonly #sessions = new Map<Socket, Recognition>();
  constructor(private readonly host: DurableHost, private readonly send: (socket: Socket, event: Record<string, unknown>) => void) {}

  async start(socket: Socket, id: string): Promise<void> {
    this.cancel(socket);
    const env = this.host.env;
    const key = env.VOLC_SPEECH_ASR_API_KEY;
    if (!key) throw new Error("语音识别服务未配置");
    const session: Recognition = { id, timer: setTimeout(() => this.#fail(socket, session, "录音已超过 60 秒，请重试"), 65_000), bytes: 0, finishing: false, chain: Promise.resolve() };
    this.#sessions.set(socket, session);
    try {
      const result = await this.host.connect("https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async", {
        "X-Api-Key": key, "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Connect-Id": crypto.randomUUID(),
      }, {
        message: (data) => {
          session.chain = session.chain.then(async () => {
            if (this.#sessions.get(socket) !== session) return;
            const result = await asrResult(data);
            this.send(socket, { type: "asr.transcript", sessionId: id, ...result });
            if (result.final) this.cancel(socket, id);
          }).catch((error: unknown) => {
            console.error("ASR upstream decoding failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
            this.#fail(socket, session, error instanceof Error ? error.message : "语音识别失败，请重试");
          });
        },
        close: () => { void session.chain.then(() => this.#fail(socket, session, "语音识别连接已断开，请重试")); },
      });
      if (!result.socket) throw new Error(`语音识别连接失败（${result.status}）`);
      if (this.#sessions.get(socket) !== session) { result.socket.close(); return; }
      session.upstream = result.socket;
      const refine = env.VOLC_SPEECH_ASR_REFINE === "true";
      const correctionTable = env.VOLC_SPEECH_ASR_CORRECTION_TABLE_ID?.trim();
      result.socket.send(asrPacket(0x10, new TextEncoder().encode(JSON.stringify({
        user: { uid: "lulu-ios" }, audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel", enable_itn: true, enable_punc: true, result_type: "full",
          ...(refine ? { enable_nonstream: true, enable_ddc: true } : {}),
          ...(correctionTable ? { corpus: { correct_table_id: correctionTable } } : {}),
        },
      }))));
      this.send(socket, { type: "asr.ready", sessionId: id });
    } catch (error) {
      this.cancel(socket, id);
      throw error;
    }
  }

  audio(socket: Socket, id: string, audio: string): void {
    const session = this.#sessions.get(socket);
    if (!session || session.id !== id || !session.upstream || session.finishing) return;
    try {
      if (audio.length > 12_800) throw new Error("音频分包过大");
      const bytes = Uint8Array.from(atob(audio), (value) => value.charCodeAt(0));
      if (bytes.length % 2 !== 0) throw new Error("音频格式错误");
      session.bytes += bytes.length;
      if (session.bytes > 60 * 32_000) throw new Error("录音已超过 60 秒，请重试");
      session.upstream.send(asrPacket(0x20, bytes));
    } catch { this.#fail(socket, session, "录音数据无效或过长，请重试"); }
  }

  finish(socket: Socket, id: string): void {
    const session = this.#sessions.get(socket);
    if (!session || session.id !== id || !session.upstream || session.finishing) return;
    session.finishing = true;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.#fail(socket, session, "识别超时，请重试"), 15_000);
    session.upstream.send(asrPacket(0x22, new Uint8Array()));
  }

  cancel(socket: Socket, id?: string): void {
    const session = this.#sessions.get(socket);
    if (!session || (id !== undefined && session.id !== id)) return;
    this.#sessions.delete(socket);
    clearTimeout(session.timer);
    session.upstream?.close();
  }

  #fail(socket: Socket, session: Recognition, message: string): void {
    if (this.#sessions.get(socket) !== session) return;
    this.send(socket, { type: "asr.error", sessionId: session.id, message });
    this.cancel(socket, session.id);
  }
}
