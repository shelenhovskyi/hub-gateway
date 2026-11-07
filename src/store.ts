import { DurableObject } from 'cloudflare:workers';
import type { BotConfig, ChatRow } from './bot/bot.ts';
import { Telegram } from './bot/telegram.ts';
import type { Digest, DigestConfig } from './digest.ts';
import type { Env } from './http.ts';
import { Hub, type SaveJobResult } from './hub.ts';
import type { Job } from './jobs.ts';

/**
 * The gateway's only state, in one SQLite-backed Durable Object. KV would be simpler, but its free
 * tier allows 1,000 writes a day; DO SQLite allows 100,000 row writes. The logic lives in `Hub`,
 * which tests run on `node:sqlite`; this class only wires it to the runtime.
 */
export class Store extends DurableObject<Env> {
  #hub: Hub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.#hub = new Hub({
      sql: storage.sql,
      transaction: (fn) => storage.transactionSync(fn),
      alarm: { get: () => storage.getAlarm(), set: (at) => storage.setAlarm(at), delete: () => storage.deleteAlarm() },
      fetch: (u, i) => fetch(u, i),
      telegram: (token) => new Telegram(token),
      run: (model, input) => env.AI.run(model as Parameters<Ai['run']>[0], input as never),
      now: () => Date.now(),
    });
  }

  getDigestConfig(): DigestConfig | null {
    return this.#hub.db.getDigestConfig();
  }

  setDigestConfig(cfg: DigestConfig): void {
    this.#hub.db.setDigestConfig(cfg);
  }

  lastDigestAt(): number | null {
    return this.#hub.db.lastDigestAt();
  }

  saveDigest(d: Digest): void {
    this.#hub.db.saveDigest(d);
  }

  latestDigest(): Digest | null {
    return this.#hub.db.latestDigest();
  }

  getBotConfig(): BotConfig | null {
    return this.#hub.db.getBotConfig();
  }

  setBotConfig(c: BotConfig): void {
    this.#hub.db.setBotConfig(c);
  }

  clearBot(): Promise<void> {
    return this.#hub.clearBot();
  }

  listChats(): ChatRow[] {
    return this.#hub.db.listChats();
  }

  setChatAllowed(id: number, allowed: boolean): void {
    this.#hub.db.setChatAllowed(id, allowed);
  }

  enqueue(secret: string | null, body: string): Promise<boolean> {
    return this.#hub.enqueue(secret, body);
  }

  listJobs(): Job[] {
    return this.#hub.db.listJobs();
  }

  saveJob(input: unknown, now: number): Promise<SaveJobResult> {
    return this.#hub.saveJob(input, now);
  }

  deleteJob(id: string): Promise<void> {
    return this.#hub.deleteJob(id);
  }

  runJobNow(id: string): Promise<Job | null> {
    return this.#hub.runJobNow(id);
  }

  maintain(now: number): Promise<void> {
    return this.#hub.maintain(now);
  }

  override alarm(): Promise<void> {
    return this.#hub.alarm();
  }
}
