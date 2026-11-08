import { type BotStore, commandsKey, handleUpdate, sendCommands } from './bot/bot.ts';
import type { Telegram, TgUpdate } from './bot/telegram.ts';
import { Notifier } from './notify.ts';
import { Db, type Sql } from './db.ts';
import { HttpError, sameSecret } from './http.ts';
import { type Job, MAX_JOBS, nextAfter, runJob, validateJob } from './jobs.ts';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Run = (model: string, input: Record<string, unknown>) => Promise<unknown>;

export interface HubDeps {
  sql: Sql;
  transaction: <T>(fn: () => T) => T;
  alarm: { get(): Promise<number | null>; set(at: number): Promise<void>; delete(): Promise<void> };
  fetch: Fetch;
  telegram: (token: string) => Telegram;
  run: Run;
  now: () => number;
}

/** Each run may fetch a page, and one alarm invocation gets 50 subrequests. */
const JOBS_PER_ALARM = 5;
/** Keeps a backlog of due jobs from re-firing the alarm in a tight loop. */
const MIN_ALARM_DELAY = 1000;

export type SaveJobResult = { job: Job } | { status: number; error: string };

/**
 * Everything the gateway's Durable Object does, apart from being one. The alarm serves two queues:
 * Telegram updates, answered here rather than in the webhook's `waitUntil` (cut off after 30 s,
 * too short for a long voice note), and due jobs.
 */
export class Hub {
  readonly db: Db;
  readonly notifier: Notifier;
  readonly bot: BotStore;
  #running = new Set<string>();
  #chats = new Map<number, Promise<void>>();
  #draining = false;

  constructor(private readonly deps: HubDeps) {
    this.db = new Db(deps.sql, deps.transaction);
    this.notifier = new Notifier(this.db, (u, i) => deps.fetch(u, i), deps.now);
    const db = this.db;
    this.bot = {
      getBotConfig: async () => db.getBotConfig(),
      setBotConfig: async (c) => db.setBotConfig(c),
      upsertChat: async (chat, now, allowed) => db.upsertChat(chat, now, allowed),
      setChatAllowed: async (id, allowed) => db.setChatAllowed(id, allowed),
      migrateChat: async (from, to) => db.migrateChat(from, to),
      addLine: async (chatId, line) => db.addLine(chatId, line),
      recentLines: async (chatId, since, limit) => db.recentLines(chatId, since, limit),
      clearLines: async (chatId) => db.clearLines(chatId),
      addFact: async (chatId, text, now) => db.addFact(chatId, text, now),
      facts: async (chatId) => db.facts(chatId),
      clearFacts: async (chatId) => db.clearFacts(chatId),
      hit: async (key, windowMs, now) => db.hit(key, windowMs, now),
      count: async (key, now) => db.count(key, now),
      getCache: async (key, now) => db.getCache(key, now),
      setCache: async (key, value, until) => db.setCache(key, value, until),
      dropCache: async (key) => db.dropCache(key),
      addReminder: async (job) => {
        if (db.saveJob(job) !== 'ok') return false;
        await this.arm();
        return true;
      },
      chatReminders: async (chatId) => db.chatReminders(chatId),
      deleteJob: (id) => this.deleteJob(id),
    };
  }

  // --- bot ---

  /** The webhook's whole job: check the secret, queue the update, and let the alarm answer it. */
  async enqueue(secret: string | null, body: string): Promise<boolean> {
    const cfg = this.db.getBotConfig();
    if (!cfg || !sameSecret(secret, cfg.secret)) return false;
    let u: TgUpdate;
    try {
      u = JSON.parse(body) as TgUpdate;
    } catch {
      return true;
    }
    if (!Number.isSafeInteger(u.update_id)) return true;
    const chat = u.message?.chat.id ?? u.my_chat_member?.chat.id ?? 0;
    if (!this.db.enqueue(u.update_id, chat, body, this.deps.now())) return true;
    // An alarm already draining picks the chat up at once; otherwise wake one.
    if (this.#draining) this.#startChats();
    else await this.deps.alarm.set(this.deps.now());
    return true;
  }

  /** One runner per chat: a chat's updates are answered in order, different chats side by side. */
  #startChats(): void {
    for (const chat of this.db.pendingChats()) {
      if (this.#chats.has(chat)) continue;
      this.#chats.set(chat, this.#drainChat(chat).finally(() => this.#chats.delete(chat)));
    }
  }

  async #drainChat(chat: number): Promise<void> {
    for (let body = this.db.takeUpdate(chat); body !== null; body = this.db.takeUpdate(chat)) {
      const cfg = this.db.getBotConfig();
      if (!cfg) return;
      try {
        await handleUpdate(JSON.parse(body) as TgUpdate, cfg, { tg: this.deps.telegram(cfg.token), store: this.bot, run: this.deps.run, now: this.deps.now() });
      } catch (e) {
        console.error('bot', e instanceof Error ? e.message : e);
      }
    }
  }

  async clearBot(): Promise<void> {
    this.db.clearBot();
    await this.arm();
  }

  // --- jobs ---

  /** Validates and stores in one turn, so two saves of the same job cannot interleave. */
  async saveJob(input: unknown, now: number): Promise<SaveJobResult> {
    const id = (input as { id?: unknown } | null)?.id;
    const existing = typeof id === 'string' ? this.db.getJob(id) : null;
    if (typeof id === 'string' && !existing) return { status: 404, error: 'no such job' };
    let job: Job;
    try {
      job = validateJob(input, now, existing?.job);
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, error: e.message };
      throw e;
    }
    if (this.db.saveJob(job) === 'full') return { status: 409, error: `at most ${MAX_JOBS} jobs` };
    await this.arm();
    return { job };
  }

  async deleteJob(id: string): Promise<void> {
    this.db.deleteJob(id);
    await this.arm();
  }

  /** The app's "check now": the same claim as a scheduled run, but the schedule stays. A run already in flight is not doubled. */
  async runJobNow(id: string): Promise<Job | null> {
    const row = this.db.getJob(id);
    if (!row) return null;
    if (this.#running.has(id)) return row.job;
    const version = this.db.claim(id, row.version, 'keep');
    if (version !== null) await this.#execute(row.job, version, this.deps.now());
    return this.db.getJob(id)?.job ?? null;
  }

  async #execute(job: Job, version: number, now: number): Promise<void> {
    this.#running.add(job.id);
    try {
      const r = await runJob(job, { fetch: this.deps.fetch, now });
      let state = r.state;
      if (r.notify) {
        const failed = await this.#notify(job, r.notify);
        if (failed) state = { ...state, lastOk: false, lastResult: failed };
      }
      this.db.finish(job.id, version, state, !!r.disable);
    } finally {
      this.#running.delete(job.id);
    }
  }

  /**
   * A group's reminder goes only to that group. Everything else goes to the owner on every channel
   * they set up: the Telegram bot, email, push. Returns what failed, or null when all got through.
   */
  async #notify(job: Job, text: string): Promise<string | null> {
    if (job.chatId !== undefined) return this.#telegram(job.chatId, text);
    const failures = await this.notifyOwner(job.title, text);
    return failures.length ? failures.join('; ') : null;
  }

  async notifyOwner(title: string, text: string): Promise<string[]> {
    const owner = this.db.getBotConfig()?.ownerId;
    const failures: string[] = [];
    if (owner) {
      const err = await this.#telegram(owner, text);
      if (err) failures.push(err);
    }
    failures.push(...(await this.notifier.send(title, text)));
    return failures;
  }

  async #telegram(chat: number, text: string): Promise<string | null> {
    const cfg = this.db.getBotConfig();
    if (!cfg) return null;
    try {
      await this.deps.telegram(cfg.token).call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } });
      return null;
    } catch (e) {
      console.error('notify', e);
      return `Telegram: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // --- the alarm ---

  /** The one alarm a Durable Object has, set for whatever needs it soonest. */
  async arm(): Promise<void> {
    const now = this.deps.now();
    const next = this.db.nextWake(now);
    const current = await this.deps.alarm.get();
    if (next === null) {
      if (current !== null) await this.deps.alarm.delete();
      return;
    }
    const at = Math.max(next, now + MIN_ALARM_DELAY);
    if (current === null || current > at || current < now) await this.deps.alarm.set(at);
  }

  /**
   * Claims each due job before running it, so a run happens at most once even if a "check now",
   * an edit or a second alarm races it. A failure anywhere still leaves the next alarm set.
   */
  async alarm(): Promise<void> {
    this.#draining = true;
    try {
      this.#startChats();
      const now = this.deps.now();
      const runs = this.db.dueJobs(now, JOBS_PER_ALARM).map(async ({ job, version }) => {
        const claimed = this.db.claim(job.id, version, nextAfter(job, now));
        if (claimed !== null) await this.#execute(job, claimed, now);
      });
      for (const r of await Promise.allSettled(runs)) if (r.status === 'rejected') console.error('job', r.reason);
      while (this.#chats.size) await Promise.all(this.#chats.values());
    } catch (e) {
      console.error('alarm', e);
    } finally {
      this.#draining = false;
      await this.arm().catch((e) => console.error('arm', e));
    }
  }

  /** Hourly from the cron: housekeeping, and a fresh alarm should anything have left it unset. */
  async maintain(now: number): Promise<void> {
    this.db.prune(now);
    await this.arm();
    // Bots connected before a release that added commands would otherwise never show them.
    const cfg = this.db.getBotConfig();
    if (cfg && cfg.commandsSent !== commandsKey(cfg.language)) {
      const sent = await sendCommands(this.deps.telegram(cfg.token), cfg.language).catch((e) => console.error('commands', e));
      if (sent) this.db.setBotConfig({ ...this.db.getBotConfig()!, commandsSent: sent });
    }
  }
}
