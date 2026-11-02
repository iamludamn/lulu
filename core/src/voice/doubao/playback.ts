export const OUTPUT_RATE = 24000;
const SAMPLES_PER_MS = OUTPUT_RATE / 1000;

export type Span = { responseId: string; startsAt: number; samples: number };
export type Unheard = { responseId: string; heardMs: number; totalMs: number };

const consumed = (span: Span, now: number): number => Math.min(span.samples, Math.max(0, Math.floor((now - span.startsAt) * SAMPLES_PER_MS)));
const endsAt = (span: Span): number => span.startsAt + span.samples / SAMPLES_PER_MS;

export class Playback {
  #spans: Span[] = [];
  #tail = 0;

  schedule(responseId: string, samples: number, now: number): number {
    const startsAt = Math.max(now, this.#tail);
    const last = this.#spans.at(-1);
    if (last !== undefined && last.responseId === responseId && endsAt(last) === startsAt) {
      last.samples += samples;
    } else {
      this.#spans.push({ responseId, startsAt, samples });
    }
    this.#tail = startsAt + samples / SAMPLES_PER_MS;
    return startsAt;
  }

  playedSamples(now: number): number {
    return this.#spans.reduce((sum, span) => sum + consumed(span, now), 0);
  }

  remainingMs(now: number): number {
    return Math.max(0, this.#tail - now);
  }

  unheard(now: number): Unheard | undefined {
    const live = this.#spans.filter((span) => endsAt(span) > now).at(-1);
    if (live === undefined) return undefined;
    const spans = this.#spans.filter((span) => span.responseId === live.responseId);
    const heard = spans.reduce((sum, span) => sum + consumed(span, now), 0);
    const total = spans.reduce((sum, span) => sum + span.samples, 0);
    return { responseId: live.responseId, heardMs: Math.floor(heard / SAMPLES_PER_MS), totalMs: Math.floor(total / SAMPLES_PER_MS) };
  }

  drop(now: number): Unheard | undefined {
    const unheard = this.unheard(now);
    this.#spans = this.#spans.map((span) => ({ ...span, samples: consumed(span, now) })).filter((span) => span.samples > 0);
    this.#tail = Math.min(this.#tail, now);
    return unheard;
  }
}
