import { DurableObject } from 'cloudflare:workers';
import type { BotConfig, ChatRow } from './bot/bot.ts';
import { Data, DataError } from './data.ts';
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
export type DataOp =
  | 'vaultMeta'
  | 'vaultGet'
  | 'vaultPut'
  | 'vaultDelete'
  | 'lists'
  | 'list'
  | 'listCreate'
  | 'listRotate'
  | 'listDelete'
  | 'listChange'
  | 'guestList'
  | 'forms'
  | 'form'
  | 'formSave'
  | 'formDelete'
  | 'formResponses'
  | 'formSubmit';

export class Store extends DurableObject<Env> {
  #hub: Hub;
  readonly #data: Data;

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
    this.#data = new Data(storage.sql, (fn) => storage.transactionSync(fn));
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
    this.#data.prune(now);
    return this.#hub.maintain(now);
  }

  /**
   * The user-data module (vault, lists, forms) behind one RPC method. Errors cross RPC as values,
   * since a thrown DataError would arrive as a plain Error and lose its status.
   */
  async data(op: DataOp, ...args: unknown[]): Promise<{ ok: unknown } | { error: string; status: number }> {
    const d = this.#data;
    const now = Date.now();
    try {
      switch (op) {
        case 'vaultMeta':
          return { ok: d.vaultMeta() };
        case 'vaultGet':
          return { ok: d.vaultGet() };
        case 'vaultPut':
          return { ok: d.vaultPut(args[0] as string, Number(args[1]), String(args[2] ?? ''), now) };
        case 'vaultDelete':
          return { ok: d.vaultDelete() };
        case 'lists':
          return { ok: d.lists() };
        case 'list':
          return { ok: d.list(String(args[0])) };
        case 'listCreate':
          return { ok: await d.listCreate(String(args[0] ?? ''), now) };
        case 'listRotate':
          return { ok: await d.listRotate(String(args[0])) };
        case 'listDelete':
          return { ok: d.listDelete(String(args[0])) };
        case 'listChange':
          return { ok: d.listChange(String(args[0]), args[1], now, false) };
        case 'guestList': {
          if (!(await d.listAuthorized(String(args[0]), String(args[1] ?? '')))) return { error: 'no access', status: 401 };
          return { ok: args[2] === undefined ? d.list(String(args[0])) : d.listChange(String(args[0]), args[2], now, true) };
        }
        case 'forms':
          return { ok: d.forms() };
        case 'form': {
          const f = d.form(String(args[0]));
          return { ok: f && { form: f, state: d.formState(f, now) } };
        }
        case 'formSave':
          return { ok: d.formSave(args[0], now) };
        case 'formDelete':
          return { ok: d.formDelete(String(args[0])) };
        case 'formResponses':
          return { ok: d.formResponses(String(args[0])) };
        case 'formSubmit': {
          const r = d.formSubmit(String(args[0]), (args[1] ?? {}) as Record<string, unknown>, String(args[2] ?? ''), now);
          if (r.form.notify) await this.#notifyForm(r.form.title, r.form.fields, r.answers);
          return { ok: r.form };
        }
      }
    } catch (e) {
      if (e instanceof DataError) return { error: e.message, status: e.status };
      throw e;
    }
  }

  /** Tells the owner through their Telegram bot, if they have one; a failed message never loses the answer. */
  async #notifyForm(title: string, fields: { id: string; label: string }[], answers: Record<string, string>): Promise<void> {
    const bot = this.#hub.db.getBotConfig();
    if (!bot?.ownerId) return;
    const lines = fields.filter((f) => answers[f.id]).map((f) => `${f.label}: ${answers[f.id]!.slice(0, 300)}`);
    const text = `📝 ${title}\n\n${lines.join('\n')}`.slice(0, 4000);
    await new Telegram(bot.token).call('sendMessage', { chat_id: bot.ownerId, text, link_preview_options: { is_disabled: true } }).catch(() => {});
  }

  override alarm(): Promise<void> {
    return this.#hub.alarm();
  }
}
