import type { DurableHost } from "../host/types.js";
import { Call, type Written } from "./call.js";
import type { Writer } from "./line.js";
import { decode, encode } from "./doubao/events.js";
import { DoubaoLine } from "./doubao/line.js";
import { type Endpoint, HostTransport } from "./transport.js";

const VOICE = "zh_male_yunzhou_jupiter_bigtts";
const FAILED_PREFIX = "The job failed: ";
const EMPTY_OUTCOME = "The job finished with nothing to report.";

export type TaskStatus = { status: "running" | "done" | "failed" | "unknown"; summary?: string; error?: string };

export interface VoiceHost {
  readonly agentName: string;
  readonly userName: string;
  send(event: Record<string, unknown>): void;
  ask(request: string): Promise<string>;
  watch(taskId: string, done: (status: TaskStatus) => void): void;
  recent(): Promise<Written[]>;
  connect: DurableHost["connect"];
}

export class VoiceRelay {
  readonly #call: Call;
  readonly #line: DoubaoLine;
  readonly #heard = new Set<string>();
  #reason: string | undefined;

  constructor(host: VoiceHost, endpoint: Endpoint, writer?: Writer) {
    this.#call = new Call(
      {
        send: async (request) => {
          const taskId = await host.ask(request);
          host.watch(taskId, (status) => {
            if (status.status === "failed") this.#call.landed(`${FAILED_PREFIX}${status.error ?? "unknown"}`, { key: taskId });
            else this.#call.landed(status.summary ?? EMPTY_OUTCOME, { key: taskId });
          });
          return taskId;
        },
        recent: () => host.recent(),
      },
      { agentName: host.agentName, userName: host.userName },
      {
        ready: () => host.send({ type: "voice.state", state: "ready" }),
        caller: (transcript) => host.send({ type: "conversation.item.input_audio_transcription.completed", transcript }),
        failed: (message) => host.send({ type: "error", error: { message } }),
        closed: () => host.send({ type: "voice.state", state: "closed", ...(this.#reason === undefined ? {} : { reason: this.#reason }) }),
      },
    );
    const sink = {
      play: (pcm: Uint8Array) => host.send({ type: "response.output_audio.delta", delta: encode(pcm) }),
      flush: () => host.send({ type: "voice.flush" }),
    };
    this.#line = new DoubaoLine(new HostTransport(host.connect, endpoint), this.#call.settings(VOICE), this.#call, sink, Date.now, writer);
  }

  start(): Promise<void> {
    return this.#call.start(this.#line);
  }

  audio(base64: string): void {
    this.#line.listen(decode(base64));
  }

  mute(muted: boolean): void {
    if (muted) this.#line.mute();
    else this.#line.unmute();
  }

  stop(reason?: string): void {
    if (reason !== undefined) this.#reason = reason;
    void this.#line.close();
  }

  deliver(text: string): void {
    this.#call.landed(text);
  }

  overheard(key: string, text: string): void {
    if (this.#heard.has(key)) return;
    this.#heard.add(key);
    this.#call.overheard(text);
  }
}
