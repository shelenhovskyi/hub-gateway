import type { Db } from './db.ts';
import { knownPushService, newVapid, push, type Subscription, type Vapid } from './webpush.ts';

/**
 * Where the owner hears from their gateway, besides the Telegram bot: push notifications to the
 * browsers they allowed, and email through their own Resend key. Every channel is optional and
 * one failing never stops the others.
 */

export interface EmailConfig {
  apiKey: string;
  to: string;
  from: string;
}

interface PushSub extends Subscription {
  label: string;
  at: number;
}

export const MAX_PUSH = 10;
const DEFAULT_FROM = 'hub <onboarding@resend.dev>';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class NotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly fetchFn: Fetch,
    private readonly now: () => number,
  ) {}

  #email(): EmailConfig | null {
    return this.db.get<EmailConfig>('notify:email');
  }

  #subs(): PushSub[] {
    return this.db.get<PushSub[]>('notify:push') ?? [];
  }

  async vapid(): Promise<Vapid> {
    const have = this.db.get<Vapid>('notify:vapid');
    if (have) return have;
    const v = await newVapid();
    this.db.set('notify:vapid', v);
    return v;
  }

  /** What the app may see: never the Resend key. */
  async status(telegram: boolean): Promise<{ telegram: boolean; email: { to: string; from: string } | null; push: { count: number; labels: string[]; publicKey: string } }> {
    const e = this.#email();
    const subs = this.#subs();
    return { telegram, email: e && { to: e.to, from: e.from }, push: { count: subs.length, labels: subs.map((s) => s.label), publicKey: (await this.vapid()).publicKey } };
  }

  /** Saves email settings after a test message gets through, so a wrong key or address shows up now. */
  async setEmail(input: { apiKey?: unknown; to?: unknown; from?: unknown }): Promise<void> {
    const old = this.#email();
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : old?.apiKey;
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    const from = typeof input.from === 'string' && input.from.trim() ? input.from.trim().slice(0, 200) : DEFAULT_FROM;
    if (!apiKey || !/^re_[\w-]{10,}$/.test(apiKey)) throw new NotifyError(400, 'that does not look like a Resend API key (it starts with re_)');
    if (!EMAIL_RE.test(to)) throw new NotifyError(400, 'that is not an email address');
    const cfg = { apiKey, to, from };
    const err = await this.#sendEmail(cfg, 'hub: email notifications are on', 'This is a test from your hub gateway. From now on reminders, watches and form answers can reach you here.');
    if (err) throw new NotifyError(400, err);
    this.db.set('notify:email', cfg);
  }

  clearEmail(): void {
    this.db.set('notify:email', null);
  }

  addPush(input: { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; label?: unknown }): void {
    const s = input.subscription;
    const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : '';
    const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : '';
    const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : '';
    if (!knownPushService(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,30}$/.test(auth)) throw new NotifyError(400, 'not a browser push subscription');
    const label = typeof input.label === 'string' ? input.label.slice(0, 40) : '';
    const rest = this.#subs().filter((x) => x.endpoint !== endpoint);
    if (rest.length >= MAX_PUSH) throw new NotifyError(409, `at most ${MAX_PUSH} devices`);
    this.db.set('notify:push', [...rest, { endpoint, p256dh, auth, label, at: this.now() }]);
  }

  removePush(endpoint: unknown): void {
    this.db.set(
      'notify:push',
      this.#subs().filter((x) => x.endpoint !== endpoint),
    );
  }

  async #sendEmail(cfg: EmailConfig, subject: string, text: string): Promise<string | null> {
    try {
      const res = await this.fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject: subject.slice(0, 200), text }),
      });
      if (res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      return `Resend: ${j.message ?? `HTTP ${res.status}`}`;
    } catch (e) {
      return `Resend: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Sends to email and every push device; returns the failures, worded for the owner. */
  async send(title: string, text: string): Promise<string[]> {
    const failures: string[] = [];
    const email = this.#email();
    if (email) {
      const err = await this.#sendEmail(email, title, text);
      if (err) failures.push(err);
    }
    const subs = this.#subs();
    if (subs.length) {
      const v = await this.vapid();
      const subject = email ? `mailto:${email.to}` : 'https://github.com/shelenhovskyi/hub-gateway';
      const gone: string[] = [];
      for (const s of subs) {
        const r = await push(s, { title, body: text.slice(0, 1000) }, v, subject, this.fetchFn, this.now());
        if (r === 'gone') gone.push(s.endpoint);
        else if (r !== 'sent') failures.push(`push (${s.label || 'device'}): ${r.error}`);
      }
      if (gone.length) this.db.set('notify:push', this.#subs().filter((x) => !gone.includes(x.endpoint)));
    }
    return failures;
  }

  /** Whether anything besides Telegram is set up. */
  any(): boolean {
    return !!this.#email() || this.#subs().length > 0;
  }
}
