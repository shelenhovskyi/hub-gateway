import type { Sql } from './db.ts';

/**
 * The user's own data on their gateway: an encrypted vault for syncing devices, lists shared with
 * family by link, and forms that collect answers. Synchronous SQL in the one Durable Object, like
 * `Db`; limits keep a shared link or a public form from eating the free plan's row writes.
 */

/** DO SQLite caps a row near 2 MB, so the sealed vault is kept in parts. */
const VAULT_CHUNK = 1_000_000;
export const MAX_VAULT = 20_000_000;

export const LIMITS = {
  lists: 20,
  items: 300,
  itemText: 200,
  listTitle: 80,
  /** Writes through a shared link per list per day: plenty for a family, a ceiling for a leaked link. */
  listWritesPerDay: 600,
  forms: 20,
  formFields: 20,
  fieldLabel: 200,
  answer: 2000,
  responsesKept: 2000,
  responsesPerDayDefault: 100,
  responsesPerDayMax: 1000,
  /** Answers from one network address per form per day. */
  perAddressPerDay: 10,
} as const;

const DAY = 24 * 3600_000;

export type FieldKind = 'text' | 'long' | 'email' | 'phone' | 'number' | 'date' | 'choice' | 'check';

export interface FormField {
  id: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** For `choice`. */
  options?: string[];
}

export interface Form {
  id: string;
  title: string;
  description: string;
  fields: FormField[];
  open: boolean;
  closesAt: number | null;
  perDay: number;
  notify: boolean;
  createdAt: number;
  responses: number;
}

export interface ListItem {
  id: string;
  text: string;
  done: boolean;
  by: string;
  at: number;
}

export interface List {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  items: ListItem[];
}

export class DataError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const id = (bytes = 9) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class Data {
  #ready = false;

  constructor(
    private readonly raw: Sql,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  #sql(): Sql {
    if (!this.#ready) {
      this.#ready = true;
      this.transaction(() => {
        for (const q of [
          'CREATE TABLE IF NOT EXISTS vault (n INTEGER PRIMARY KEY, data TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, size INTEGER NOT NULL, device TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, title TEXT NOT NULL, secret TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
          'CREATE TABLE IF NOT EXISTS list_items (list_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (list_id, id))',
          'CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)',
          'CREATE TABLE IF NOT EXISTS form_responses (form_id TEXT NOT NULL, at INTEGER NOT NULL, answers TEXT NOT NULL)',
          'CREATE INDEX IF NOT EXISTS form_responses_form ON form_responses (form_id, at)',
          'CREATE TABLE IF NOT EXISTS data_counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
        ])
          this.raw.exec(q).toArray();
      });
    }
    return this.raw;
  }

  #rows<T extends Record<string, SqlStorageValue>>(q: string, ...b: (string | number | null)[]): T[] {
    return this.#sql().exec<T>(q, ...b).toArray();
  }

  #run(q: string, ...b: (string | number | null)[]): void {
    this.#sql().exec(q, ...b).toArray();
  }

  /** A fixed window counter; returns the count including this hit. */
  #hit(key: string, now: number, window = DAY): number {
    return this.#rows<{ n: number }>(
      'INSERT INTO data_counters (key, n, until) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = CASE WHEN until <= ? THEN 1 ELSE n + 1 END, until = CASE WHEN until <= ? THEN excluded.until ELSE until END RETURNING n',
      key,
      now + window,
      now,
      now,
    )[0]!.n;
  }

  prune(now: number): void {
    this.#run('DELETE FROM data_counters WHERE until <= ?', now);
  }

  // ——— Vault: one sealed blob, versioned so two devices can't silently overwrite each other ———

  vaultMeta(): { version: number; updatedAt: number; size: number; device: string } {
    const r = this.#rows<{ version: number; updated_at: number; size: number; device: string }>("SELECT version, updated_at, size, device FROM vault_meta WHERE k = 'main'")[0];
    return r ? { version: r.version, updatedAt: r.updated_at, size: r.size, device: r.device } : { version: 0, updatedAt: 0, size: 0, device: '' };
  }

  vaultGet(): { version: number; updatedAt: number; device: string; body: string | null } {
    const meta = this.vaultMeta();
    if (!meta.version) return { ...meta, body: null };
    const body = this.#rows<{ data: string }>('SELECT data FROM vault ORDER BY n').map((r) => r.data).join('');
    return { version: meta.version, updatedAt: meta.updatedAt, device: meta.device, body };
  }

  /** Stores the body only if the caller saw the current version; otherwise 409 with what is there. */
  vaultPut(body: string, baseVersion: number, device: string, now: number): { version: number; updatedAt: number } {
    if (typeof body !== 'string' || !body) throw new DataError(400, 'body required');
    if (body.length > MAX_VAULT) throw new DataError(413, 'vault too large');
    const meta = this.vaultMeta();
    if (baseVersion !== meta.version) throw new DataError(409, `vault changed: version ${meta.version}`);
    const version = meta.version + 1;
    this.transaction(() => {
      this.#run('DELETE FROM vault');
      for (let i = 0, n = 0; i < body.length; i += VAULT_CHUNK, n++) this.#run('INSERT INTO vault (n, data) VALUES (?, ?)', n, body.slice(i, i + VAULT_CHUNK));
      this.#run(
        "INSERT INTO vault_meta (k, version, updated_at, size, device) VALUES ('main', ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, size = excluded.size, device = excluded.device",
        version,
        now,
        body.length,
        device.slice(0, 60),
      );
    });
    return { version, updatedAt: now };
  }

  vaultDelete(): void {
    this.transaction(() => {
      this.#run('DELETE FROM vault');
      this.#run('DELETE FROM vault_meta');
    });
  }

  // ——— Shared lists ———

  async listCreate(title: string, now: number): Promise<{ list: List; secret: string }> {
    const t = str(title, LIMITS.listTitle);
    if (!t) throw new DataError(400, 'title required');
    const n = this.#rows<{ n: number }>('SELECT COUNT(*) AS n FROM lists')[0]!.n;
    if (n >= LIMITS.lists) throw new DataError(409, `at most ${LIMITS.lists} lists`);
    const listId = id();
    const secret = id(18);
    this.#run('INSERT INTO lists (id, title, secret, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', listId, t, await sha256(secret), now, now);
    return { list: this.list(listId)!, secret };
  }

  /** A new link; the old one stops working at once. */
  async listRotate(listId: string): Promise<string> {
    if (!this.list(listId)) throw new DataError(404, 'no such list');
    const secret = id(18);
    this.#run('UPDATE lists SET secret = ? WHERE id = ?', await sha256(secret), listId);
    return secret;
  }

  listDelete(listId: string): void {
    this.transaction(() => {
      this.#run('DELETE FROM list_items WHERE list_id = ?', listId);
      this.#run('DELETE FROM lists WHERE id = ?', listId);
    });
  }

  lists(): (Omit<List, 'items'> & { open: number })[] {
    return this.#rows<{ id: string; title: string; version: number; updated_at: number; open: number }>(
      'SELECT l.id, l.title, l.version, l.updated_at, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 0) AS open FROM lists l ORDER BY l.updated_at DESC',
    ).map((r) => ({ id: r.id, title: r.title, version: r.version, updatedAt: r.updated_at, open: r.open }));
  }

  list(listId: string): List | null {
    const l = this.#rows<{ id: string; title: string; version: number; updated_at: number }>('SELECT id, title, version, updated_at FROM lists WHERE id = ?', listId)[0];
    if (!l) return null;
    const items = this.#rows<{ id: string; text: string; done: number; by: string; at: number }>('SELECT id, text, done, by, at FROM list_items WHERE list_id = ? ORDER BY done, at', listId).map((r) => ({
      id: r.id,
      text: r.text,
      done: !!r.done,
      by: r.by,
      at: r.at,
    }));
    return { id: l.id, title: l.title, version: l.version, updatedAt: l.updated_at, items };
  }

  /** Whether `secret` opens `listId`; constant work whether the list exists or not. */
  async listAuthorized(listId: string, secret: string): Promise<boolean> {
    const want = this.#rows<{ secret: string }>('SELECT secret FROM lists WHERE id = ?', listId)[0]?.secret ?? '0'.repeat(64);
    const got = await sha256(secret);
    let diff = 0;
    for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0 && want !== '0'.repeat(64);
  }

  /** One change to a list. `guest` changes count against the shared link's daily limit. */
  listChange(listId: string, op: unknown, now: number, guest: boolean): List {
    const l = this.list(listId);
    if (!l) throw new DataError(404, 'no such list');
    if (guest && this.#hit(`list:${listId}`, now) > LIMITS.listWritesPerDay) throw new DataError(429, 'this list has had too many changes today');
    const o = (op ?? {}) as { op?: unknown; id?: unknown; text?: unknown; done?: unknown; by?: unknown; title?: unknown };
    const by = str(o.by, 40);
    switch (o.op) {
      case 'add': {
        const text = str(o.text, LIMITS.itemText);
        if (!text) throw new DataError(400, 'text required');
        if (l.items.length >= LIMITS.items) throw new DataError(409, `at most ${LIMITS.items} items`);
        this.#run('INSERT INTO list_items (list_id, id, text, done, by, at) VALUES (?, ?, ?, 0, ?, ?)', listId, id(), text, by, now);
        break;
      }
      case 'toggle':
        this.#run('UPDATE list_items SET done = ?, at = ? WHERE list_id = ? AND id = ?', o.done ? 1 : 0, now, listId, String(o.id));
        break;
      case 'remove':
        this.#run('DELETE FROM list_items WHERE list_id = ? AND id = ?', listId, String(o.id));
        break;
      case 'clearDone':
        this.#run('DELETE FROM list_items WHERE list_id = ? AND done = 1', listId);
        break;
      case 'rename': {
        if (guest) throw new DataError(403, 'only the owner can rename a list');
        const title = str(o.title, LIMITS.listTitle);
        if (!title) throw new DataError(400, 'title required');
        this.#run('UPDATE lists SET title = ? WHERE id = ?', title, listId);
        break;
      }
      default:
        throw new DataError(400, 'unknown change');
    }
    this.#run('UPDATE lists SET version = version + 1, updated_at = ? WHERE id = ?', now, listId);
    return this.list(listId)!;
  }

  // ——— Forms ———

  #formRow(formId: string): Omit<Form, 'responses'> | null {
    const r = this.#rows<{ body: string }>('SELECT body FROM forms WHERE id = ?', formId)[0];
    return r ? (JSON.parse(r.body) as Omit<Form, 'responses'>) : null;
  }

  form(formId: string): Form | null {
    const f = this.#formRow(formId);
    if (!f) return null;
    return { ...f, responses: this.#rows<{ n: number }>('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?', formId)[0]!.n };
  }

  forms(): Form[] {
    return this.#rows<{ id: string }>('SELECT id FROM forms ORDER BY created_at DESC').map((r) => this.form(r.id)!);
  }

  /** Creates (no `id`) or replaces a form. */
  formSave(input: unknown, now: number): Form {
    const i = (input ?? {}) as Record<string, unknown>;
    const existing = typeof i.id === 'string' ? this.#formRow(i.id) : null;
    if (typeof i.id === 'string' && !existing) throw new DataError(404, 'no such form');
    if (!existing && this.#rows<{ n: number }>('SELECT COUNT(*) AS n FROM forms')[0]!.n >= LIMITS.forms) throw new DataError(409, `at most ${LIMITS.forms} forms`);
    const title = str(i.title, 120);
    if (!title) throw new DataError(400, 'title required');
    const fields = validateFields(i.fields);
    const perDay = Math.min(LIMITS.responsesPerDayMax, Math.max(1, Math.floor(Number(i.perDay) || LIMITS.responsesPerDayDefault)));
    const closesAt = Number.isFinite(Number(i.closesAt)) && Number(i.closesAt) > 0 ? Number(i.closesAt) : null;
    const form: Omit<Form, 'responses'> = {
      id: existing?.id ?? id(),
      title,
      description: str(i.description, 1000),
      fields,
      // A new form starts closed: it goes public only when its owner says so.
      open: existing ? i.open === true : false,
      closesAt,
      perDay,
      notify: i.notify !== false,
      createdAt: existing?.createdAt ?? now,
    };
    this.#run('INSERT INTO forms (id, body, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body', form.id, JSON.stringify(form), form.createdAt);
    return this.form(form.id)!;
  }

  formDelete(formId: string): void {
    this.transaction(() => {
      this.#run('DELETE FROM form_responses WHERE form_id = ?', formId);
      this.#run('DELETE FROM forms WHERE id = ?', formId);
    });
  }

  formResponses(formId: string): { at: number; answers: Record<string, string> }[] {
    return this.#rows<{ at: number; answers: string }>('SELECT at, answers FROM form_responses WHERE form_id = ? ORDER BY at DESC', formId).map((r) => ({
      at: r.at,
      answers: JSON.parse(r.answers) as Record<string, string>,
    }));
  }

  /** Whether the form takes answers right now, and why not. */
  formState(f: Form, now: number): 'open' | 'closed' | 'full' {
    if (!f.open || (f.closesAt !== null && now >= f.closesAt)) return 'closed';
    if (f.responses >= LIMITS.responsesKept) return 'full';
    return 'open';
  }

  /** Checks and stores one answer. `address` is a hash of the sender's IP, only for the per-day limit. */
  formSubmit(formId: string, raw: Record<string, unknown>, address: string, now: number): { form: Form; answers: Record<string, string> } {
    const f = this.form(formId);
    if (!f) throw new DataError(404, 'no such form');
    const state = this.formState(f, now);
    if (state !== 'open') throw new DataError(410, state === 'full' ? 'this form has all the answers it can take' : 'this form is closed');
    const answers: Record<string, string> = {};
    for (const field of f.fields) {
      const v = raw[field.id];
      let s = field.kind === 'check' ? (v === 'on' || v === true || v === 'true' ? 'yes' : '') : str(v, LIMITS.answer);
      if (field.kind === 'choice' && s && !field.options?.includes(s)) s = '';
      if (field.kind === 'email' && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new DataError(400, `${field.label}: not an email address`);
      if (field.kind === 'number' && s && !Number.isFinite(Number(s.replace(',', '.')))) throw new DataError(400, `${field.label}: not a number`);
      if (field.required && !s) throw new DataError(400, `${field.label}: required`);
      if (s) answers[field.id] = s;
    }
    if (this.#hit(`form:${formId}:addr:${address}`, now) > LIMITS.perAddressPerDay) throw new DataError(429, 'too many answers from this network today');
    if (this.#hit(`form:${formId}`, now) > f.perDay) throw new DataError(429, 'this form has had all the answers it takes today');
    this.#run('INSERT INTO form_responses (form_id, at, answers) VALUES (?, ?, ?)', formId, now, JSON.stringify(answers));
    return { form: { ...f, responses: f.responses + 1 }, answers };
  }
}

function validateFields(v: unknown): FormField[] {
  if (!Array.isArray(v) || !v.length) throw new DataError(400, 'at least one field');
  if (v.length > LIMITS.formFields) throw new DataError(400, `at most ${LIMITS.formFields} fields`);
  const kinds: FieldKind[] = ['text', 'long', 'email', 'phone', 'number', 'date', 'choice', 'check'];
  const seen = new Set<string>();
  return v.map((x, n) => {
    const f = (x ?? {}) as Record<string, unknown>;
    const label = str(f.label, LIMITS.fieldLabel);
    if (!label) throw new DataError(400, `field ${n + 1}: label required`);
    const kind = kinds.includes(f.kind as FieldKind) ? (f.kind as FieldKind) : 'text';
    let fid = typeof f.id === 'string' && /^[\w-]{1,20}$/.test(f.id) ? f.id : `f${n + 1}`;
    while (seen.has(fid)) fid += '_';
    seen.add(fid);
    const options = kind === 'choice' ? (Array.isArray(f.options) ? f.options.map((o) => str(o, 100)).filter(Boolean).slice(0, 20) : []) : undefined;
    if (kind === 'choice' && !options?.length) throw new DataError(400, `${label}: add the choices`);
    return { id: fid, label, kind, required: f.required === true, ...(options && { options }) };
  });
}
