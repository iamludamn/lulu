import type { Wake } from "@earendil-works/pi-durable";
import type { DurableAlarm } from "../host/types.js";

export const RECOVERY_ALARM_DELAY_MS = 60_000;

export class BotAlarm {
  #updates = Promise.resolve();
  #work = 0;
  #recoveryAt = Infinity;

  constructor(
    private readonly alarm: DurableAlarm,
    private readonly wake: () => Wake,
    private readonly applicationDeadline: () => Promise<number>,
  ) {}

  refresh(): Promise<void> {
    return this.#serialize(async () => {
      const applicationAt = await this.applicationDeadline();
      const current = await this.alarm.get();
      const now = Date.now();
      if (current !== null && current <= now) return;
      const wake = this.wake();
      const due = Math.min(applicationAt, wake.at ?? Infinity, wake.active ? now + RECOVERY_ALARM_DELAY_MS : Infinity, this.#recoveryAt);
      if (due === current) return;
      if (Number.isFinite(due)) await this.alarm.set(due);
      else if (current !== null) await this.alarm.delete();
    });
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.#serialize(async () => {
      const now = Date.now();
      const recoveryAt = this.#work === 0 || this.#recoveryAt <= now ? now + RECOVERY_ALARM_DELAY_MS : this.#recoveryAt;
      const current = await this.alarm.get();
      if (current === null || current > recoveryAt) await this.alarm.set(recoveryAt);
      this.#recoveryAt = recoveryAt;
      this.#work += 1;
    });
    let result: T;
    try {
      result = await work();
    } finally {
      this.#work -= 1;
      if (this.#work === 0) this.#recoveryAt = Infinity;
    }
    await this.refresh();
    return result;
  }

  #serialize(update: () => Promise<void>): Promise<void> {
    const next = this.#updates.then(update, update);
    this.#updates = next;
    return next;
  }
}
