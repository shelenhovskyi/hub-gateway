import { DurableObject } from 'cloudflare:workers';
import type { BotConfig, BotStore, ChatRow, LogLine } from './bot/bot.ts';
import { Telegram } from './bot/telegram.ts';
import type { Env } from './http.ts';
import { type Job, MAX_JOBS, nextAfter, runJob } from './jobs.ts';
import type { Digest, DigestConfig } from './digest.ts';

const KEEP_DIGESTS = 14;
/** Matches what the bot promises in /privacy. */
const KEEP_LINES_MS = 24 * 3600_000;

/**
 * The gateway's only state, in one SQLite-backed Durable Object. KV would be simpler, but its free
 * tier allows 1,000 writes a day; DO SQLite allows 100,000 row writes.
 */
export class Store extends DurableObject<Env> implements BotStore {
  #ready = false;

  #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS digests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, body TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS bot_chats (id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, allowed INTEGER NOT NULL, last_at INTEGER NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS bot_lines (chat_id INTEGER NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL)');
      sql.exec('CREATE INDEX IF NOT EXISTS bot_lines_chat ON bot_lines (chat_id, at)');
      sql.exec('CREATE TABLE IF NOT EXISTS bot_facts (chat_id INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)');
      this.#ready = true;
    }
    return sql;
  }

  #get<T>(key: string): T | null {
    const row = this.#sql().exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  #set(key: string, value: unknown): void {
    this.#sql().exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  async getDigestConfig(): Promise<DigestConfig | null> {
    return this.#get<DigestConfig>('digest:config');
  }

  async setDigestConfig(cfg: DigestConfig): Promise<void> {
    this.#set('digest:config', cfg);
  }

  async lastDigestAt(): Promise<number | null> {
    const row = this.#sql().exec<{ t: number | null }>('SELECT MAX(created_at) AS t FROM digests').toArray()[0];
    return row?.t ?? null;
  }

  async saveDigest(d: Digest): Promise<void> {
    const sql = this.#sql();
    sql.exec('INSERT INTO digests (created_at, body) VALUES (?, ?)', d.createdAt, JSON.stringify(d));
    sql.exec('DELETE FROM digests WHERE id NOT IN (SELECT id FROM digests ORDER BY created_at DESC LIMIT ?)', KEEP_DIGESTS);
  }

  async latestDigest(): Promise<Digest | null> {
    const row = this.#sql().exec<{ body: string }>('SELECT body FROM digests ORDER BY created_at DESC LIMIT 1').toArray()[0];
    return row ? (JSON.parse(row.body) as Digest) : null;
  }

  async getBotConfig(): Promise<BotConfig | null> {
    return this.#get<BotConfig>('bot:config');
  }

  async setBotConfig(c: BotConfig): Promise<void> {
    this.#set('bot:config', c);
  }

  /** Disconnecting erases everything the bot kept, as Telegram's terms require once a bot stops. */
  async clearBot(): Promise<void> {
    const sql = this.#sql();
    sql.exec("DELETE FROM kv WHERE key = 'bot:config'");
    for (const t of ['bot_chats', 'bot_lines', 'bot_facts', 'counters']) sql.exec(`DELETE FROM ${t}`);
  }

  async listChats(): Promise<ChatRow[]> {
    return this.#sql()
      .exec<{ id: number; title: string; type: ChatRow['type']; allowed: number; last_at: number }>('SELECT * FROM bot_chats ORDER BY last_at DESC LIMIT 100')
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, type: r.type, allowed: !!r.allowed, lastAt: r.last_at }));
  }

  async upsertChat(chat: { id: number; title: string; type: ChatRow['type'] }, now: number, allowed?: boolean): Promise<ChatRow> {
    const sql = this.#sql();
    sql.exec(
      'INSERT INTO bot_chats (id, title, type, allowed, last_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, type = excluded.type, last_at = excluded.last_at' +
        (allowed === undefined ? '' : ', allowed = excluded.allowed'),
      chat.id,
      chat.title,
      chat.type,
      allowed ? 1 : 0,
      now,
    );
    const r = sql.exec<{ allowed: number }>('SELECT allowed FROM bot_chats WHERE id = ?', chat.id).one();
    return { ...chat, allowed: !!r.allowed, lastAt: now };
  }

  async setChatAllowed(id: number, allowed: boolean): Promise<void> {
    this.#sql().exec('UPDATE bot_chats SET allowed = ? WHERE id = ?', allowed ? 1 : 0, id);
  }

  /** A group that becomes a supergroup gets a new id; its permission, history and facts move with it. */
  async migrateChat(from: number, to: number): Promise<void> {
    const sql = this.#sql();
    sql.exec('DELETE FROM bot_chats WHERE id = ?', to);
    for (const [t, col] of [['bot_chats', 'id'], ['bot_lines', 'chat_id'], ['bot_facts', 'chat_id']] as const) sql.exec(`UPDATE ${t} SET ${col} = ? WHERE ${col} = ?`, to, from);
  }

  async addLine(chatId: number, line: LogLine): Promise<void> {
    const sql = this.#sql();
    sql.exec('INSERT INTO bot_lines (chat_id, at, who, text) VALUES (?, ?, ?, ?)', chatId, line.at, line.who, line.text);
    sql.exec('DELETE FROM bot_lines WHERE at < ?', line.at - KEEP_LINES_MS);
  }

  /** The newest `limit` lines since `since`, oldest first. */
  async recentLines(chatId: number, since: number, limit: number): Promise<LogLine[]> {
    return this.#sql()
      .exec<{ at: number; who: string; text: string }>('SELECT at, who, text FROM bot_lines WHERE chat_id = ? AND at >= ? ORDER BY at DESC LIMIT ?', chatId, since, limit)
      .toArray()
      .reverse();
  }

  async clearLines(chatId: number): Promise<void> {
    this.#sql().exec('DELETE FROM bot_lines WHERE chat_id = ?', chatId);
  }

  async addFact(chatId: number, text: string, now: number): Promise<void> {
    this.#sql().exec('INSERT INTO bot_facts (chat_id, at, text) VALUES (?, ?, ?)', chatId, now, text);
  }

  async facts(chatId: number): Promise<string[]> {
    return this.#sql()
      .exec<{ text: string }>('SELECT text FROM bot_facts WHERE chat_id = ? ORDER BY at', chatId)
      .toArray()
      .map((r) => r.text);
  }

  async clearFacts(chatId: number): Promise<void> {
    this.#sql().exec('DELETE FROM bot_facts WHERE chat_id = ?', chatId);
  }

  async hit(key: string, windowMs: number, now: number): Promise<number> {
    const sql = this.#sql();
    sql.exec(
      'INSERT INTO counters (key, n, until) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN until <= ? THEN 1 ELSE n + 1 END, until = CASE WHEN until <= ? THEN excluded.until ELSE until END',
      key,
      now + windowMs,
      now,
      now,
    );
    sql.exec('DELETE FROM counters WHERE until <= ?', now);
    return sql.exec<{ n: number }>('SELECT n FROM counters WHERE key = ?', key).one().n;
  }

  async listJobs(): Promise<Job[]> {
    return this.#sql()
      .exec<{ body: string }>('SELECT body FROM jobs ORDER BY next_at')
      .toArray()
      .map((r) => JSON.parse(r.body) as Job);
  }

  async getJob(id: string): Promise<Job | null> {
    const row = this.#sql().exec<{ body: string }>('SELECT body FROM jobs WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(row.body) as Job) : null;
  }

  async putJob(job: Job): Promise<void> {
    const sql = this.#sql();
    const exists = sql.exec('SELECT 1 FROM jobs WHERE id = ?', job.id).toArray().length > 0;
    if (!exists && sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs').one().n >= MAX_JOBS) throw new Error(`at most ${MAX_JOBS} jobs`);
    this.#save(job);
    await this.#arm();
  }

  async deleteJob(id: string): Promise<void> {
    this.#sql().exec('DELETE FROM jobs WHERE id = ?', id);
    await this.#arm();
  }

  /** Runs one job now, for the app's "check now", and keeps its schedule. */
  async runJobNow(id: string): Promise<Job | null> {
    const job = await this.getJob(id);
    if (!job) return null;
    return this.#run(job, Date.now(), false);
  }

  #save(job: Job): void {
    const next = Number.isFinite(job.nextAt) ? job.nextAt : 0;
    this.#sql().exec(
      'INSERT INTO jobs (id, next_at, enabled, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET next_at = excluded.next_at, enabled = excluded.enabled, body = excluded.body',
      job.id,
      next,
      job.enabled && Number.isFinite(job.nextAt) ? 1 : 0,
      JSON.stringify(job),
    );
  }

  /** One alarm for the soonest enabled job; a Durable Object keeps only one. */
  async #arm(): Promise<void> {
    const row = this.#sql().exec<{ t: number | null }>('SELECT MIN(next_at) AS t FROM jobs WHERE enabled = 1').one();
    if (row.t === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(row.t, Date.now() + 1000));
  }

  async #run(job: Job, now: number, reschedule: boolean): Promise<Job> {
    const r = await runJob(job, { fetch: (u, i) => fetch(u, i), now });
    const next: Job = {
      ...job,
      state: r.state,
      enabled: job.enabled && !r.disable,
      nextAt: reschedule ? nextAfter(job, now) : job.nextAt,
    };
    if (reschedule && !Number.isFinite(next.nextAt)) next.enabled = false;
    if (r.notify) await this.#notify(job, r.notify);
    this.#save(next);
    return next;
  }

  async #notify(job: Job, text: string): Promise<void> {
    const cfg = await this.getBotConfig();
    const chat = job.chatId ?? cfg?.ownerId;
    if (!cfg || !chat) return;
    await new Telegram(cfg.token).call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } }).catch((e) => console.error('notify', e));
  }

  /** At most a few jobs per alarm: each run may fetch a page, and one invocation gets 50 subrequests. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.#sql()
      .exec<{ body: string }>('SELECT body FROM jobs WHERE enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT 5', now)
      .toArray()
      .map((r) => JSON.parse(r.body) as Job);
    for (const job of due) await this.#run(job, now, true);
    await this.#arm();
  }
}
