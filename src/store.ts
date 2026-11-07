import { DurableObject } from 'cloudflare:workers';
import type { BotConfig, BotStore, ChatRow, LogLine } from './bot/bot.ts';
import type { Digest, DigestConfig } from './digest.ts';

const KEEP_DIGESTS = 14;
/** Matches what the bot promises in /privacy. */
const KEEP_LINES_MS = 24 * 3600_000;

/**
 * The gateway's only state, in one SQLite-backed Durable Object. KV would be simpler, but its free
 * tier allows 1,000 writes a day; DO SQLite allows 100,000 row writes.
 */
export class Store extends DurableObject implements BotStore {
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
}
