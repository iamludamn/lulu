import type { AudioSink, Line, LineEvents, LineSettings, Notice, ToolCall, Update, Writer } from "../line.js";
import type { Transport } from "../transport.js";
import { type Down, encode, INPUT_RATE, lastAssistant, MODEL, noticeItem, OUTPUT_FORMAT, parseDown, type Raw, reportItems, toolReply } from "./events.js";
import { Pacer } from "./pacer.js";
import { OUTPUT_RATE, Playback } from "./playback.js";

const READY_TIMEOUT_MS = 8_000;
const CLOSE_ACK_MS = 1_500;
const RECONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 500;
const FAREWELL_WAIT_MS = 8_000;
const FAREWELL_TAIL_MS = 500;
const GRACE_MS = 400;
const LICENSE_MS = 6_000;
const RETRIGGER_MS = 3_000;
const IMPLICIT_RESPONSE = "implicit";
const CUT_PLACEHOLDER = "…";

export type AudioOut = { responseId: string; atMs: number; endsAtMs: number; samples: number; text: string; heardText: string | undefined; progress: boolean };
export type Stray = { responseId: string; samples: number; reason: "interrupted" | "unprompted" };
export type CutRecord = { heardMs: number; playedMs: number };

export class LineDebug {
  readonly #out: Map<string, AudioOut>;
  readonly #strays: Stray[];
  readonly #cuts: CutRecord[];
  readonly #contextErrors: string[];
  readonly playedSamples: () => number;

  constructor(out: Map<string, AudioOut>, strays: Stray[], cuts: CutRecord[], contextErrors: string[], playedSamples: () => number) {
    this.#out = out;
    this.#strays = strays;
    this.#cuts = cuts;
    this.#contextErrors = contextErrors;
    this.playedSamples = playedSamples;
  }

  get audioOut(): readonly AudioOut[] {
    return [...this.#out.values()];
  }

  get strayDeltas(): readonly Stray[] {
    return this.#strays;
  }

  get cuts(): readonly CutRecord[] {
    return this.#cuts;
  }

  get contextErrors(): readonly string[] {
    return this.#contextErrors;
  }
}

type Timer = ReturnType<typeof setTimeout>;
type Owed = { text: string; writeBack: boolean };

export class DoubaoLine implements Line {
  readonly #transport: Transport;
  readonly #settings: LineSettings;
  readonly #events: LineEvents;
  readonly #sink: AudioSink;
  readonly #now: () => number;
  readonly #writer: Writer | undefined;
  readonly debug: LineDebug;
  readonly #pacer = new Pacer();
  readonly #playback = new Playback();
  readonly #out = new Map<string, AudioOut>();
  readonly #strays: Stray[] = [];
  readonly #cuts: CutRecord[] = [];
  readonly #contextErrors: string[] = [];
  readonly #pendingText = new Map<string, string>();
  readonly #progressKeys = new Set<string>();
  readonly #silenced = new Map<string, Stray["reason"]>();
  readonly #admitted = new Set<string>();
  readonly #reportOf = new Map<string, string[]>();
  readonly #tracked = new Set<string>();
  #owed: Owed[] = [];
  #reports: Update[] = [];
  #notices: Notice[] = [];
  #sessionId: string;
  #resumeId: string | undefined;
  #sequence = 0;
  #ready = false;
  #muted = false;
  #closing = false;
  #composing = false;
  #callerSpeaking = false;
  #inFlight: string | undefined;
  #licensedUntil = 0;
  #idleSince: number | undefined;
  #reporting: string[] = [];
  #rewrite: string | undefined;
  #hangingUp = false;
  #spoken: Owed | undefined;
  #retries = 0;
  #pump: Timer | undefined;
  #recheck: Timer | undefined;
  #farewell: Timer | undefined;
  #opened: { resolve(): void; reject(error: Error): void } | undefined;
  #acknowledged: (() => void) | undefined;

  constructor(transport: Transport, settings: LineSettings, events: LineEvents, sink: AudioSink, now: () => number = Date.now, writer?: Writer) {
    this.#transport = transport;
    this.#settings = settings;
    this.#events = events;
    this.#sink = sink;
    this.#now = now;
    this.#writer = writer;
    this.#sessionId = crypto.randomUUID();
    this.debug = new LineDebug(this.#out, this.#strays, this.#cuts, this.#contextErrors, () => this.#playback.playedSamples(this.#now()));
    transport.onEvent((raw) => void this.#down(parseDown(raw)).catch((error: unknown) => this.#events.failed(String(error))));
    transport.onClose(() => this.#lost());
  }

  async start(): Promise<void> {
    await this.#transport.connect();
    const opened = new Promise<void>((resolve, reject) => {
      this.#opened = { resolve, reject };
    });
    const timeout = setTimeout(() => this.#opened?.reject(new Error("Voice session did not start")), READY_TIMEOUT_MS);
    this.#create();
    try {
      await opened;
    } finally {
      clearTimeout(timeout);
    }
  }

  listen(pcm: Uint8Array): void {
    if (this.#ready && !this.#muted && !this.#closing) this.#pacer.push(pcm);
  }

  mute(): void {
    if (this.#muted) return;
    this.#muted = true;
    this.#stopPump();
    this.#up({ type: "input_audio_mute.commit" });
  }

  unmute(): void {
    if (!this.#muted) return;
    this.#muted = false;
    this.#up({ type: "input_audio_unmute.commit" });
    this.#startPump();
  }

  say(text: string): void {
    this.#owed.push({ text, writeBack: false });
    this.#flush();
  }

  report(updates: Update[]): void {
    this.#reports.push(...updates);
    this.#flush();
  }

  note(notices: Notice[]): void {
    this.#notices.push(...notices);
    this.#flush();
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#stopPump();
    clearTimeout(this.#recheck);
    clearTimeout(this.#farewell);
    const acknowledged = new Promise<void>((resolve) => {
      this.#acknowledged = resolve;
    });
    this.#up({ type: "session.close" });
    await Promise.race([acknowledged, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_ACK_MS))]);
    this.#transport.close();
    this.#events.closed();
  }

  #create(): void {
    this.#up({
      type: "session.create",
      session: {
        id: this.#resumeId ?? this.#sessionId,
        model: MODEL,
        instructions: this.#settings.instructions,
        audio: {
          input: { format: { type: "pcm", rate: INPUT_RATE } },
          output: { format: { type: OUTPUT_FORMAT, rate: OUTPUT_RATE }, voice: this.#settings.voice },
        },
        tools: this.#settings.tools,
      },
      extension: { asr: { extra: {} }, tts: { extra: {} }, dialog: { extra: {} } },
    });
  }

  #up(event: Raw): string {
    const eventId = `event_${++this.#sequence}`;
    this.#transport.send({ ...event, event_id: eventId });
    return eventId;
  }

  #track(event: Raw): void {
    this.#tracked.add(this.#up(event));
  }

  #license(): void {
    this.#licensedUntil = this.#now() + LICENSE_MS;
  }

  #startPump(): void {
    this.#stopPump();
    this.#pacer.reset(this.#now());
    const step = (): void => {
      const { frame, wait } = this.#pacer.next(this.#now());
      this.#up({ type: "input_audio_buffer.append", audio: encode(frame) });
      this.#pump = setTimeout(step, wait);
    };
    step();
  }

  #stopPump(): void {
    clearTimeout(this.#pump);
    this.#pump = undefined;
  }

  #admit(id: string): boolean {
    if (this.#admitted.has(id)) return !this.#silenced.has(id);
    this.#admitted.add(id);
    if (this.#now() <= this.#licensedUntil) {
      this.#licensedUntil = 0;
      this.#reportOf.set(id, this.#reporting);
      this.#reporting = [];
      return true;
    }
    this.#silenced.set(id, "unprompted");
    this.#up({ type: "response.cancel" });
    return false;
  }

  async #down(event: Down): Promise<void> {
    switch (event.kind) {
      case "created":
        this.#resumeId = event.sessionId === "" ? this.#resumeId : event.sessionId;
        this.#retries = 0;
        this.#ready = true;
        if (!this.#muted) this.#startPump();
        this.#opened?.resolve();
        this.#opened = undefined;
        this.#events.ready();
        this.#flush();
        return;
      case "closed":
        this.#acknowledged?.();
        return;
      case "callerStarted":
        this.#callerSpeaking = true;
        this.#license();
        this.#yield();
        return;
      case "callerDone":
        this.#callerSpeaking = false;
        this.#license();
        if (event.transcript !== "") this.#events.caller(event.transcript);
        this.#flush();
        return;
      case "callerFailed":
        this.#callerSpeaking = false;
        this.#flush();
        return;
      case "text": {
        const id = event.responseId ?? this.#inFlight ?? IMPLICIT_RESPONSE;
        if (!this.#admit(id)) return;
        const out = this.#out.get(id);
        if (out !== undefined) out.text += event.delta;
        else this.#pendingText.set(id, (this.#pendingText.get(id) ?? "") + event.delta);
        return;
      }
      case "textDone": {
        const id = event.responseId ?? this.#inFlight ?? IMPLICIT_RESPONSE;
        if (this.#admitted.has(id) && !this.#silenced.has(id) && event.text !== "") this.#events.agent(event.text);
        return;
      }
      case "audioStarted": {
        const id = event.responseId ?? IMPLICIT_RESPONSE;
        if (!this.#admit(id)) return;
        this.#inFlight = id;
        if (event.ttsType === "chat_tts_text") {
          this.#pendingText.set(id, this.#spoken?.text ?? "");
          this.#spoken = undefined;
        }
        return;
      }
      case "audio":
        this.#accept(event.responseId ?? this.#inFlight ?? IMPLICIT_RESPONSE, event.pcm);
        return;
      case "audioDone":
        if (event.responseId === undefined || event.responseId === this.#inFlight) this.#inFlight = undefined;
        this.#flush();
        return;
      case "responseDone":
      case "canceled":
        this.#inFlight = undefined;
        this.#flush();
        return;
      case "calls":
        await this.#answer(event.calls);
        return;
      case "retrieved": {
        const heard = this.#rewrite;
        const id = lastAssistant(event.items);
        this.#rewrite = undefined;
        if (heard !== undefined && id !== undefined) this.#track({ type: "conversation.item.update", items: [{ id, content: [{ type: "text", text: heard }] }] });
        return;
      }
      case "error":
        if (this.#tracked.has(event.eventId)) {
          this.#contextErrors.push(`${event.code}: ${event.message}`);
          return;
        }
        if (event.code.startsWith("5") && !this.#closing) void this.#reconnect();
        else {
          this.#opened?.reject(new Error(event.message));
          this.#events.failed(event.message || event.code);
        }
        return;
      case "updated":
      case "ignored":
        return;
    }
  }

  #accept(id: string, pcm: Uint8Array): void {
    const samples = pcm.length / 2;
    if (!this.#admit(id)) {
      this.#strays.push({ responseId: id, samples, reason: this.#silenced.get(id) ?? "unprompted" });
      return;
    }
    this.#inFlight ??= id;
    const now = this.#now();
    const startsAt = this.#playback.schedule(id, samples, now);
    const progress = (this.#reportOf.get(id) ?? []).some((key) => this.#progressKeys.has(key));
    const out = this.#out.get(id) ?? { responseId: id, atMs: startsAt, endsAtMs: startsAt, samples: 0, text: this.#pendingText.get(id) ?? "", heardText: undefined, progress };
    this.#pendingText.delete(id);
    out.samples += samples;
    out.endsAtMs = startsAt + samples / (OUTPUT_RATE / 1000);
    this.#out.set(id, out);
    this.#sink.play(pcm);
    if (this.#hangingUp) this.#closeAfterFarewell(0);
  }

  #yield(): void {
    const now = this.#now();
    const unheard = this.#playback.drop(now);
    if (unheard !== undefined) {
      this.#silenced.set(unheard.responseId, "interrupted");
      const record = this.#out.get(unheard.responseId);
      const text = record?.text ?? "";
      const heardText = text.slice(0, Math.round((text.length * unheard.heardMs) / Math.max(unheard.totalMs, 1)));
      if (record !== undefined) {
        record.heardText = heardText;
        record.endsAtMs = now;
      }
      this.#cuts.push({ heardMs: unheard.heardMs, playedMs: Math.floor(this.debug.playedSamples() / (OUTPUT_RATE / 1000)) });
      this.#events.cut({ heardMs: unheard.heardMs, heardText, reported: this.#reportOf.get(unheard.responseId) ?? [] });
      this.#rewrite = heardText === "" ? CUT_PLACEHOLDER : heardText;
      this.#track({ type: "conversation.item.retrieve", items: [] });
    }
    this.#sink.flush();
    if (this.#inFlight !== undefined) {
      this.#silenced.set(this.#inFlight, "interrupted");
      this.#inFlight = undefined;
      this.#up({ type: "response.cancel" });
    }
  }

  async #answer(calls: ToolCall[]): Promise<void> {
    if (calls.length === 0) return;
    const results = await this.#events.tools(calls);
    if (!results.every((result) => result.quiet === true)) this.#license();
    this.#up(toolReply(calls, results));
    if (results.some((result) => result.hangup === true)) {
      this.#hangingUp = true;
      const speaking = this.#inFlight !== undefined || this.#playback.remainingMs(this.#now()) > 0;
      this.#closeAfterFarewell(speaking ? 0 : FAREWELL_WAIT_MS);
    }
  }

  #closeAfterFarewell(minWait: number): void {
    const now = this.#now();
    const until = Math.max(now + minWait, now + this.#playback.remainingMs(now)) + FAREWELL_TAIL_MS;
    clearTimeout(this.#farewell);
    this.#farewell = setTimeout(() => void this.close(), until - now);
  }

  #recheckIn(ms: number): void {
    clearTimeout(this.#recheck);
    this.#recheck = setTimeout(() => this.#flush(), ms);
  }

  #flush(): void {
    if (!this.#ready || this.#closing) return;
    const now = this.#now();
    const remaining = this.#playback.remainingMs(now);
    if (this.#callerSpeaking || this.#inFlight !== undefined || this.#composing) {
      this.#idleSince = undefined;
      return;
    }
    if (remaining > 0) {
      this.#idleSince = undefined;
      this.#recheckIn(remaining + 10);
      return;
    }
    this.#idleSince ??= now;
    const wait = GRACE_MS - (now - this.#idleSince);
    if (wait > 0) {
      this.#recheckIn(wait + 5);
      return;
    }
    if (this.#notices.length > 0) {
      this.#track({ type: "conversation.item.create", items: [noticeItem(this.#notices)] });
      this.#notices = [];
    }
    if (this.#owed.length > 0) this.#speak();
    else if (this.#reports.length > 0) this.#deliver();
  }

  #speak(): void {
    const text = this.#owed.map((line) => line.text).join(" ");
    const writeBack = this.#owed.some((line) => line.writeBack);
    this.#owed = [];
    this.#spoken = { text, writeBack };
    this.#license();
    this.#up({ type: "speech_text_buffer.commit", speech_id: crypto.randomUUID(), text });
    if (writeBack) this.#track({ type: "conversation.item.create", items: [{ type: "message", role: "assistant", content: [{ type: "text", text }] }] });
    this.#idleSince = undefined;
    this.#recheckIn(RETRIGGER_MS);
  }

  #deliver(): void {
    const updates = this.#reports;
    this.#reports = [];
    for (const update of updates) if (update.progress) this.#progressKeys.add(update.key);
    if (this.#writer === undefined) {
      this.#reporting = updates.map((update) => update.key);
      this.#license();
      this.#up({ type: "conversation.item.create", items: reportItems(`report-${crypto.randomUUID()}`, updates, new Date(this.#now()).toISOString()) });
      this.#idleSince = undefined;
      this.#recheckIn(RETRIGGER_MS);
      return;
    }
    this.#composing = true;
    this.#writer.compose(updates).then(
      (text) => {
        this.#composing = false;
        if (text.trim() === "") this.#demote(updates);
        else {
          this.#reporting = updates.map((update) => update.key);
          this.#owed.push({ text: text.trim(), writeBack: true });
        }
        this.#flush();
      },
      () => {
        this.#composing = false;
        this.#demote(updates);
        this.#flush();
      },
    );
  }

  #demote(updates: readonly Update[]): void {
    const at = new Date(this.#now()).toISOString();
    this.#notices.push(...updates.map((update) => ({ kind: "landed" as const, key: update.key, text: update.text, at })));
  }

  #lost(): void {
    this.#stopPump();
    if (this.#closing) return;
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    if (this.#closing) return;
    this.#ready = false;
    this.#stopPump();
    if (this.#retries >= RECONNECT_ATTEMPTS) {
      this.#events.failed("Voice connection lost");
      void this.close();
      return;
    }
    this.#retries += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS * this.#retries));
    if (this.#closing) return;
    try {
      this.#pacer.reset(this.#now());
      this.#licensedUntil = 0;
      await this.#transport.connect();
      this.#create();
    } catch {
      void this.#reconnect();
    }
  }
}
