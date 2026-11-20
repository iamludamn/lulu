import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { DurableStorage } from "../host/types.js";
import type { Schedule } from "../protocol/contract.js";
import { spaceEntries } from "../space/doc.js";
import { CronJobsDoc } from "./doc.js";
import { GRACE_MS, dailyUtcCrons, onceCronTime, utcOnceCron, type ScheduledJob } from "./schedule.js";

const PROPAGATION_MS = 15 * 60_000;
const RETRY_MS = 5 * 60_000;

export interface CronRegistration {
  readonly key: string;
  replace(crons: readonly string[]): Promise<void>;
}

export class CronTriggerRegistration {
  readonly #key: string;
  #applied = new Map<string, number>();
  #loaded = false;
  #retryAt = Infinity;
  #pending: string[] | undefined;
  #queue = Promise.resolve();
  #rules = new Map<string, string[]>();

  constructor(private readonly target: CronRegistration, private readonly storage: DurableStorage) {
    this.#key = "cron-registration:" + target.key;
  }

  async load(): Promise<void> {
    const saved = await this.storage.get<[string, number][]>(this.#key);
    this.#loaded = saved !== undefined;
    this.#applied = new Map(saved);
  }

  #crons(schedule: Schedule): string[] {
    if (schedule.kind === "once") return [utcOnceCron(onceCronTime(schedule.at))];
    const { time, tz } = schedule;
    const key = time + " " + tz;
    let crons = this.#rules.get(key);
    if (crons === undefined) {
      crons = dailyUtcCrons(time, tz, Date.now());
      this.#rules.set(key, crons);
    }
    return crons;
  }

  isLocal(job: ScheduledJob, now: number): boolean {
    if (job.schedule.kind === "once" && now - job.schedule.at > GRACE_MS) return true;
    return this.isLocalSchedule(job.schedule, now);
  }

  isLocalSchedule(schedule: Schedule, now: number): boolean {
    return this.#crons(schedule).some((cron) => (this.#applied.get(cron) ?? Infinity) > now);
  }

  nextWake(now: number): number {
    return Math.min(this.#retryAt, ...[...this.#applied.values()].filter((at) => at > now));
  }

  reconcile(harness: Pick<Harness, "snapshot">): Promise<void> {
    const update = this.#queue.then(async () => {
      const now = Date.now();
      const jobs = (await harness.snapshot(CronJobsDoc, BACKGROUND_CONTEXT))?.jobs ?? [];
      const spaceRules = (await spaceEntries(harness)).flatMap(([, entry]) =>
        entry.enabled && entry.mode.kind === "scheduled" ? this.#crons({ kind: "daily", time: entry.mode.time, tz: entry.mode.tz }) : []);
      const jobRules = jobs.flatMap((job) => {
        if (job.state !== "active") return [];
        const crons = this.#crons(job.schedule);
        if (job.schedule.kind === "daily") return crons;
        if (now - job.schedule.at > GRACE_MS) return [];
        if (onceCronTime(job.schedule.at) <= now + PROPAGATION_MS && !this.#applied.has(crons[0])) return [];
        return crons;
      });
      const desired = [...new Set([...jobRules, ...spaceRules])].sort();
      if (this.#loaded && desired.length === this.#applied.size && desired.every((cron) => this.#applied.has(cron))) return;
      if (this.#pending?.length === desired.length && desired.every((cron, i) => this.#pending?.[i] === cron) && now < this.#retryAt) return;
      const previous = this.#applied;
      this.#retryAt = Infinity;
      try {
        // Invalidate the saved result before replacing the whole remote rule set.
        await this.storage.delete(this.#key);
        await this.target.replace(desired);
        const readyAt = Date.now() + PROPAGATION_MS;
        const applied = desired.map((cron): [string, number] => [cron, previous.get(cron) ?? readyAt]);
        await this.storage.put({ [this.#key]: applied });
        this.#applied = new Map(applied);
        this.#loaded = true;
        this.#retryAt = Infinity;
        this.#pending = undefined;
      } catch (error) {
        this.#applied = new Map();
        this.#loaded = false;
        this.#retryAt = Date.now() + RETRY_MS;
        this.#pending = desired;
        throw error;
      }
    });
    this.#queue = update.catch(() => undefined);
    return update;
  }
}
