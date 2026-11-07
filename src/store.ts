import { DurableObject } from 'cloudflare:workers';
import type { Digest, DigestConfig } from './digest.ts';

const KEEP_DIGESTS = 14;

/**
 * The gateway's only state, in one SQLite-backed Durable Object. KV would be simpler, but its free
 * tier allows 1,000 writes a day; DO SQLite allows 100,000 row writes.
 */
export class Store extends DurableObject {
  #ready = false;

  #sql() {
    const sql = this.ctx.storage.sql;
    if (!this.#ready) {
      sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS digests (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, body TEXT NOT NULL)');
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
}
