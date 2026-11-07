import type { BotConfig, ChatRow, LogLine } from './bot/bot.ts';
import type { Digest, DigestConfig } from './digest.ts';
import { type Job, type JobState, MAX_BOT_JOBS, MAX_CHAT_REMINDERS, MAX_JOBS } from './jobs.ts';

/** The part of Durable Object SQLite this file uses, so tests can run it on `node:sqlite`. */
export interface Sql {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] };
}

const KEEP_DIGESTS = 14;
/** Matches what the bot promises in /privacy. */
export const KEEP_LINES_MS = 24 * 3600_000;
/** A chat's last-seen time is only for sorting the app's list; rewriting it on every message would cost a row write each. */
const CHAT_TOUCH_MS = 10 * 60_000;
/** Strangers who wrote to the bot once and were never let in. */
const KEEP_UNKNOWN_CHATS_MS = 30 * 24 * 3600_000;
/** Handled update ids stay this long so a resent update is recognised. */
const KEEP_HANDLED_MS = 3600_000;
/** An update still queued after this long was lost to a crash; nobody is waiting for its answer any more. */
const KEEP_QUEUED_MS = 24 * 3600_000;

type JobRow = {
  id: string;
  kind: string;
  source: string;
  chat_id: number | null;
  created_by: number | null;
  created_at: number;
  title: string;
  timezone: string;
  language: string;
  config: string;
  state: string;
  next_at: number | null;
  enabled: number;
  version: number;
};

function toJob(r: JobRow): Job {
  return {
    kind: r.kind,
    config: JSON.parse(r.config),
    id: r.id,
    title: r.title,
    timezone: r.timezone,
    language: r.language,
    enabled: !!r.enabled,
    ...(r.chat_id !== null && { chatId: r.chat_id }),
    nextAt: r.next_at,
    createdAt: r.created_at,
    state: JSON.parse(r.state) as JobState,
    source: r.source,
    ...(r.created_by !== null && { createdBy: r.created_by }),
  } as Job;
}

export type SaveResult = 'ok' | 'full';

/**
 * All of the gateway's state, as synchronous SQL. Each method runs within one turn of the Durable
 * Object's event loop, so it is atomic against every other request without explicit transactions.
 */
export class Db {
  #ready = false;

  constructor(
    private readonly raw: Sql,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  #rows<T extends Record<string, SqlStorageValue>>(q: string, ...b: (string | number | null)[]): T[] {
    return this.#sql().exec<T>(q, ...b).toArray();
  }

  #run(q: string, ...b: (string | number | null)[]): void {
    this.#sql().exec(q, ...b).toArray();
  }

  #tx(fn: () => void): void {
    this.#sql();
    this.transaction(fn);
  }

  #sql(): Sql {
    if (!this.#ready) {
      this.#ready = true;
      this.transaction(() => this.#migrate());
    }
    return this.raw;
  }

  #migrate(): void {
    const ddl = [
      'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS digests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS bot_chats (id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, allowed INTEGER NOT NULL, last_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS bot_lines (chat_id INTEGER NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS bot_lines_chat ON bot_lines (chat_id, at)',
      'CREATE INDEX IF NOT EXISTS bot_lines_at ON bot_lines (at)',
      'CREATE TABLE IF NOT EXISTS bot_facts (chat_id INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS bot_facts_chat ON bot_facts (chat_id, at)',
      'CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS counters_until ON counters (until)',
      'CREATE TABLE IF NOT EXISTS bot_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, until INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS bot_cache_until ON bot_cache (until)',
      'CREATE TABLE IF NOT EXISTS bot_queue (update_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, done INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS bot_queue_pending ON bot_queue (done, chat_id, update_id)',
      'CREATE TABLE IF NOT EXISTS schedule (id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, chat_id INTEGER, created_by INTEGER, created_at INTEGER NOT NULL, title TEXT NOT NULL, timezone TEXT NOT NULL, language TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL, next_at INTEGER, enabled INTEGER NOT NULL, version INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS schedule_due ON schedule (enabled, next_at)',
      'CREATE INDEX IF NOT EXISTS schedule_chat ON schedule (chat_id)',
    ];
    for (const q of ddl) this.raw.exec(q).toArray();
    const old = this.raw.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").toArray()[0]!.n;
    if (old) this.#migrateJobs();
  }

  /** 0.4 kept each job as one JSON body; a one-off that had run held `nextAt: null` there (Infinity through JSON). */
  #migrateJobs(): void {
    const rows = this.raw.exec<{ next_at: number; enabled: number; body: string }>('SELECT next_at, enabled, body FROM jobs').toArray();
    for (const r of rows) {
      let b: Partial<Job> & { nextAt?: number | null };
      try {
        b = JSON.parse(r.body);
      } catch {
        continue;
      }
      if (!b.id || !b.kind || !b.config) continue;
      const nextAt = typeof b.nextAt === 'number' && Number.isFinite(b.nextAt) && b.nextAt > 0 ? b.nextAt : r.next_at > 0 && r.enabled ? r.next_at : null;
      const source = b.chatId !== undefined && b.chatId !== null ? 'bot' : 'app';
      // A bot reminder that already fired is nothing anyone will look at again.
      if (source === 'bot' && nextAt === null) continue;
      this.raw
        .exec(
          'INSERT OR IGNORE INTO schedule (id, kind, source, chat_id, created_by, created_at, title, timezone, language, config, state, next_at, enabled, version) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
          b.id,
          b.kind,
          source,
          b.chatId ?? null,
          b.createdAt ?? Date.now(),
          b.title ?? '',
          b.timezone ?? 'UTC',
          b.language === 'uk' ? 'uk' : 'en',
          JSON.stringify(b.config),
          JSON.stringify(b.state ?? {}),
          nextAt,
          b.enabled && r.enabled && nextAt !== null ? 1 : 0,
        )
        .toArray();
    }
    this.raw.exec('DROP TABLE jobs').toArray();
  }

  // --- key-value and digests ---

  get<T>(key: string): T | null {
    const row = this.#rows<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.#run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  getDigestConfig(): DigestConfig | null {
    return this.get<DigestConfig>('digest:config');
  }

  setDigestConfig(cfg: DigestConfig): void {
    this.set('digest:config', cfg);
  }

  lastDigestAt(): number | null {
    return this.#rows<{ t: number | null }>('SELECT MAX(created_at) AS t FROM digests')[0]?.t ?? null;
  }

  saveDigest(d: Digest): void {
    this.#run('INSERT INTO digests (created_at, body) VALUES (?, ?)', d.createdAt, JSON.stringify(d));
    this.#run('DELETE FROM digests WHERE id NOT IN (SELECT id FROM digests ORDER BY created_at DESC LIMIT ?)', KEEP_DIGESTS);
  }

  latestDigest(): Digest | null {
    const row = this.#rows<{ body: string }>('SELECT body FROM digests ORDER BY created_at DESC LIMIT 1')[0];
    return row ? (JSON.parse(row.body) as Digest) : null;
  }

  // --- bot ---

  getBotConfig(): BotConfig | null {
    return this.get<BotConfig>('bot:config');
  }

  setBotConfig(c: BotConfig): void {
    this.set('bot:config', c);
  }

  /** Disconnecting erases everything the bot kept, reminders in its chats included, as /privacy and Telegram's terms promise. */
  clearBot(): void {
    this.#tx(() => {
      this.#run("DELETE FROM kv WHERE key = 'bot:config'");
      for (const t of ['bot_chats', 'bot_lines', 'bot_facts', 'counters', 'bot_cache', 'bot_queue']) this.#run(`DELETE FROM ${t}`);
      this.#run("DELETE FROM schedule WHERE source = 'bot' OR chat_id IS NOT NULL");
    });
  }

  listChats(): ChatRow[] {
    return this.#rows<{ id: number; title: string; type: ChatRow['type']; allowed: number; last_at: number }>('SELECT * FROM bot_chats ORDER BY last_at DESC LIMIT 100').map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      allowed: !!r.allowed,
      lastAt: r.last_at,
    }));
  }

  /** Writes only when something changed or the last-seen time is stale. */
  upsertChat(chat: { id: number; title: string; type: ChatRow['type'] }, now: number, allowed?: boolean): ChatRow {
    const row = this.#rows<{ title: string; type: string; allowed: number; last_at: number }>('SELECT title, type, allowed, last_at FROM bot_chats WHERE id = ?', chat.id)[0];
    if (!row) {
      this.#run('INSERT INTO bot_chats (id, title, type, allowed, last_at) VALUES (?, ?, ?, ?, ?)', chat.id, chat.title, chat.type, allowed ? 1 : 0, now);
      return { ...chat, allowed: !!allowed, lastAt: now };
    }
    const nextAllowed = allowed ?? !!row.allowed;
    if (row.title !== chat.title || row.type !== chat.type || nextAllowed !== !!row.allowed || now - row.last_at >= CHAT_TOUCH_MS) {
      this.#run('UPDATE bot_chats SET title = ?, type = ?, allowed = ?, last_at = ? WHERE id = ?', chat.title, chat.type, nextAllowed ? 1 : 0, now, chat.id);
      return { ...chat, allowed: nextAllowed, lastAt: now };
    }
    return { ...chat, allowed: nextAllowed, lastAt: row.last_at };
  }

  setChatAllowed(id: number, allowed: boolean): void {
    this.#run('UPDATE bot_chats SET allowed = ? WHERE id = ?', allowed ? 1 : 0, id);
  }

  /** A group that becomes a supergroup gets a new id; its permission, history, facts and reminders move with it. */
  migrateChat(from: number, to: number): void {
    this.#tx(() => {
      this.#run('DELETE FROM bot_chats WHERE id = ?', to);
      for (const [t, col] of [
        ['bot_chats', 'id'],
        ['bot_lines', 'chat_id'],
        ['bot_facts', 'chat_id'],
        ['schedule', 'chat_id'],
      ] as const)
        this.#run(`UPDATE ${t} SET ${col} = ? WHERE ${col} = ?`, to, from);
    });
  }

  addLine(chatId: number, line: LogLine): void {
    this.#run('INSERT INTO bot_lines (chat_id, at, who, text) VALUES (?, ?, ?, ?)', chatId, line.at, line.who, line.text);
  }

  /** The newest `limit` lines since `since`, oldest first. */
  recentLines(chatId: number, since: number, limit: number): LogLine[] {
    return this.#rows<{ at: number; who: string; text: string }>('SELECT at, who, text FROM bot_lines WHERE chat_id = ? AND at >= ? ORDER BY at DESC LIMIT ?', chatId, since, limit).reverse();
  }

  clearLines(chatId: number): void {
    this.#run('DELETE FROM bot_lines WHERE chat_id = ?', chatId);
  }

  addFact(chatId: number, text: string, now: number): void {
    this.#run('INSERT INTO bot_facts (chat_id, at, text) VALUES (?, ?, ?)', chatId, now, text);
  }

  facts(chatId: number): string[] {
    return this.#rows<{ text: string }>('SELECT text FROM bot_facts WHERE chat_id = ? ORDER BY at', chatId).map((r) => r.text);
  }

  clearFacts(chatId: number): void {
    this.#run('DELETE FROM bot_facts WHERE chat_id = ?', chatId);
  }

  hit(key: string, windowMs: number, now: number): number {
    return this.#rows<{ n: number }>(
      'INSERT INTO counters (key, n, until) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN until <= ? THEN 1 ELSE n + 1 END, until = CASE WHEN until <= ? THEN excluded.until ELSE until END RETURNING n',
      key,
      now + windowMs,
      now,
      now,
    )[0]!.n;
  }

  count(key: string, now: number): number {
    return this.#rows<{ n: number }>('SELECT n FROM counters WHERE key = ? AND until > ?', key, now)[0]?.n ?? 0;
  }

  getCache(key: string, now: number): string | null {
    return this.#rows<{ value: string }>('SELECT value FROM bot_cache WHERE key = ? AND until > ?', key, now)[0]?.value ?? null;
  }

  setCache(key: string, value: string, until: number): void {
    this.#run('INSERT INTO bot_cache (key, value, until) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, until = excluded.until', key, value, until);
  }

  dropCache(key: string): void {
    this.#run('DELETE FROM bot_cache WHERE key = ?', key);
  }

  // --- update queue ---

  /** False when Telegram resent an update already queued or handled. */
  enqueue(updateId: number, chatId: number, body: string, now: number): boolean {
    return this.#rows('INSERT INTO bot_queue (update_id, chat_id, at, body, done) VALUES (?, ?, ?, ?, 0) ON CONFLICT(update_id) DO NOTHING RETURNING update_id', updateId, chatId, now, body).length > 0;
  }

  pendingChats(): number[] {
    return this.#rows<{ chat_id: number }>('SELECT DISTINCT chat_id FROM bot_queue WHERE done = 0').map((r) => r.chat_id);
  }

  hasPending(): boolean {
    return this.#rows('SELECT 1 FROM bot_queue WHERE done = 0 LIMIT 1').length > 0;
  }

  /** Takes a chat's oldest update off the queue before it is handled: a crash loses one answer rather than repeating it. */
  takeUpdate(chatId: number): string | null {
    const row = this.#rows<{ update_id: number; body: string }>('SELECT update_id, body FROM bot_queue WHERE done = 0 AND chat_id = ? ORDER BY update_id LIMIT 1', chatId)[0];
    if (!row) return null;
    this.#run("UPDATE bot_queue SET done = 1, body = '' WHERE update_id = ?", row.update_id);
    return row.body;
  }

  /** Hourly housekeeping; every delete walks an index on its time column. */
  prune(now: number): void {
    this.#run('DELETE FROM bot_lines WHERE at < ?', now - KEEP_LINES_MS);
    this.#run('DELETE FROM counters WHERE until <= ?', now);
    this.#run('DELETE FROM bot_cache WHERE until <= ?', now);
    this.#run('DELETE FROM bot_queue WHERE (done = 1 AND at < ?) OR at < ?', now - KEEP_HANDLED_MS, now - KEEP_QUEUED_MS);
    this.#run("DELETE FROM bot_chats WHERE allowed = 0 AND type = 'private' AND last_at < ?", now - KEEP_UNKNOWN_CHATS_MS);
  }

  // --- jobs ---

  listJobs(): Job[] {
    return this.#rows<JobRow>('SELECT * FROM schedule ORDER BY next_at IS NULL, next_at').map(toJob);
  }

  getJob(id: string): { job: Job; version: number } | null {
    const r = this.#rows<JobRow>('SELECT * FROM schedule WHERE id = ?', id)[0];
    return r ? { job: toJob(r), version: r.version } : null;
  }

  /** Live reminders the bot set in one chat, soonest first. */
  chatReminders(chatId: number): Job[] {
    return this.#rows<JobRow>("SELECT * FROM schedule WHERE chat_id = ? AND kind = 'remind' AND enabled = 1 AND next_at IS NOT NULL ORDER BY next_at", chatId).map(toJob);
  }

  /** Inserts within the job's pool limit, or replaces an existing job; replacing bumps the version, so a run in flight cannot write over the edit. */
  saveJob(job: Job): SaveResult {
    const exists = this.#rows('SELECT 1 FROM schedule WHERE id = ?', job.id).length > 0;
    if (!exists && this.#full(job)) return 'full';
    const cols = [job.kind, job.source, job.chatId ?? null, job.createdBy ?? null, job.createdAt, job.title, job.timezone, job.language, JSON.stringify(job.config), JSON.stringify(job.state), job.nextAt, job.enabled ? 1 : 0];
    if (exists)
      this.#run(
        'UPDATE schedule SET kind = ?, source = ?, chat_id = ?, created_by = ?, created_at = ?, title = ?, timezone = ?, language = ?, config = ?, state = ?, next_at = ?, enabled = ?, version = version + 1 WHERE id = ?',
        ...cols,
        job.id,
      );
    else
      this.#run(
        'INSERT INTO schedule (kind, source, chat_id, created_by, created_at, title, timezone, language, config, state, next_at, enabled, id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        ...cols,
        job.id,
      );
    return 'ok';
  }

  #full(job: Job): boolean {
    const n = (where: string, ...b: (string | number)[]) => this.#rows<{ n: number }>(`SELECT COUNT(*) AS n FROM schedule WHERE ${where}`, ...b)[0]!.n;
    if (job.source === 'app') return n("source = 'app'") >= MAX_JOBS;
    if (n("source = 'bot'") >= MAX_BOT_JOBS) return true;
    return job.chatId !== undefined && n("source = 'bot' AND chat_id = ? AND enabled = 1 AND next_at IS NOT NULL", job.chatId) >= MAX_CHAT_REMINDERS;
  }

  deleteJob(id: string): void {
    this.#run('DELETE FROM schedule WHERE id = ?', id);
  }

  dueJobs(now: number, limit: number): { job: Job; version: number }[] {
    return this.#rows<JobRow>('SELECT * FROM schedule WHERE enabled = 1 AND next_at <= ? ORDER BY next_at LIMIT ?', now, limit).map((r) => ({ job: toJob(r), version: r.version }));
  }

  /**
   * Takes a job for one run if nobody changed it since `version` was read, moving its schedule on
   * (`nextAt`), or leaving it as it is when `nextAt` is `'keep'`. Returns the version the run holds,
   * or null when another run, an edit or a delete got there first.
   */
  claim(id: string, version: number, nextAt: number | null | 'keep'): number | null {
    const rows =
      nextAt === 'keep'
        ? this.#rows<{ version: number }>('UPDATE schedule SET version = version + 1 WHERE id = ? AND version = ? RETURNING version', id, version)
        : this.#rows<{ version: number }>('UPDATE schedule SET next_at = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version', nextAt, id, version);
    return rows[0]?.version ?? null;
  }

  /**
   * Records a run's result unless the job was edited or deleted while it ran. A job with no next run
   * turns off; a bot reminder that has fired is removed, since only its chat ever saw it.
   */
  finish(id: string, version: number, state: JobState, disable: boolean): void {
    const row = this.#rows<{ source: string; next_at: number | null }>('SELECT source, next_at FROM schedule WHERE id = ? AND version = ?', id, version)[0];
    if (!row) return;
    if (row.source === 'bot' && row.next_at === null) return this.#run('DELETE FROM schedule WHERE id = ?', id);
    this.#run('UPDATE schedule SET state = ?, enabled = CASE WHEN ? = 1 OR next_at IS NULL THEN 0 ELSE enabled END, version = version + 1 WHERE id = ?', JSON.stringify(state), disable ? 1 : 0, id);
  }

  /** The soonest time anything needs the alarm: a queued update now, else the next enabled job. */
  nextWake(now: number): number | null {
    if (this.hasPending()) return now;
    return this.#rows<{ t: number | null }>('SELECT MIN(next_at) AS t FROM schedule WHERE enabled = 1')[0]?.t ?? null;
  }
}
