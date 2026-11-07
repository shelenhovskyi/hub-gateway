import * as ai from './ai.ts';
import { type BotConfig, connect, DEFAULT_SETTINGS, handleUpdate, validateSettings } from './bot/bot.ts';
import { LANGS, type Lang } from './bot/strings.ts';
import { Telegram, TgError } from './bot/telegram.ts';
import { buildDigest, due, fetchFeed, validateConfig } from './digest.ts';
import { authorized, body, cors, type Env, HttpError, json } from './http.ts';

export { Store } from './store.ts';

// The entry module may export only handlers and Durable Object classes; workerd refuses anything else.
const VERSION = '0.3.0';
const MODULES = ['image', 'stt', 'tts', 'digest', 'bot'] as const;
const MAX_BODY = 25_000_000;

const store = (env: Env) => env.STORE.get(env.STORE.idFromName('main'));
const run = (env: Env) => (model: string, input: Record<string, unknown>) => env.AI.run(model as Parameters<Ai['run']>[0], input as never);

async function runDigest(env: Env, now: number) {
  const s = store(env);
  const cfg = await s.getDigestConfig();
  if (!cfg) throw new HttpError(409, 'digest not configured');
  const digest = await buildDigest(cfg, {
    fetchText: fetchFeed,
    now,
    summarize: async (prompt) => {
      const out = (await run(env)(ai.MODELS.summary, { messages: [{ role: 'user', content: prompt }], max_tokens: 400 })) as { response?: string };
      return out.response ?? '';
    },
  });
  await s.saveDigest(digest);
  return digest;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

function sameSecret(a: string | null, b: string): boolean {
  const x = new TextEncoder().encode(a ?? '');
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

/** What the hub app may see: never the bot token or the webhook secret. */
function botStatus(cfg: BotConfig | null) {
  if (!cfg) return null;
  const { token: _t, secret: _s, pairCode, ...rest } = cfg;
  return { ...rest, pairLink: pairCode ? `https://t.me/${cfg.username}?start=${pairCode}` : null };
}

async function botConnect(env: Env, origin: string, input: { token?: unknown; settings?: unknown }) {
  const s = store(env);
  const old = await s.getBotConfig();
  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : old?.token;
  if (!token || !/^\d+:[\w-]{30,}$/.test(token)) throw new HttpError(400, 'bot token looks wrong: copy the whole line BotFather sent, like 123456:ABC…');
  const lang = (input.settings as { language?: unknown } | undefined)?.language;
  const base = old ?? DEFAULT_SETTINGS[LANGS.includes(lang as Lang) ? (lang as Lang) : 'en'];
  const settings = validateSettings(input.settings, base);
  const secret = randomHex(32);
  let me;
  try {
    me = await connect(new Telegram(token), `${origin}/bot/webhook`, secret, settings.language);
  } catch (e) {
    if (e instanceof TgError && (e.code === 401 || e.code === 404)) throw new HttpError(400, 'Telegram did not accept this bot token');
    throw e;
  }
  // The same bot keeps its owner; a different bot starts unclaimed.
  const keep = old?.botId === me.id && old.ownerId !== null;
  const cfg: BotConfig = {
    ...settings,
    token,
    secret,
    botId: me.id,
    username: me.username ?? '',
    ownerId: keep ? old.ownerId : null,
    ownerName: keep ? old.ownerName : null,
    pairCode: keep ? null : randomHex(8),
  };
  if (old && old.botId !== me.id) await s.clearBot();
  await s.setBotConfig(cfg);
  return cfg;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (path === '/health') return json(env, { ok: true, version: VERSION, configured: !!env.ADMIN_TOKEN });
  // Telegram calls this one; it proves itself with the secret registered in setWebhook, not the admin token.
  if (path === '/bot/webhook' && req.method === 'POST') {
    const cfg = await store(env).getBotConfig();
    if (!cfg || !sameSecret(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), cfg.secret)) return new Response('forbidden', { status: 403 });
    const update = await body<Parameters<typeof handleUpdate>[0]>(req, 1_000_000);
    // Answer Telegram at once; a slow reply would make it resend the update.
    ctx.waitUntil(handleUpdate(update, cfg, { tg: new Telegram(cfg.token), store: store(env), run: run(env), now: Date.now() }).catch((e) => console.error('bot', e)));
    return new Response('ok');
  }
  if (!authorized(req, env)) return json(env, { error: 'unauthorized' }, 401);

  const post = req.method === 'POST';
  if (path === '/whoami') return json(env, { ok: true, version: VERSION, modules: MODULES });
  if (path === '/image' && post) return json(env, await ai.image(run(env), await body(req, MAX_BODY)));
  if (path === '/stt' && post) return json(env, await ai.stt(run(env), await body(req, MAX_BODY)));
  if (path === '/tts' && post) return json(env, await ai.tts(run(env), await body(req, MAX_BODY)));
  if (path === '/digest' && !post) return json(env, { digest: await store(env).latestDigest() });
  if (path === '/digest/config' && !post) return json(env, { config: await store(env).getDigestConfig() });
  if (path === '/digest/config' && post) {
    const cfg = validateConfig(await body(req, 50_000));
    await store(env).setDigestConfig(cfg);
    return json(env, { config: cfg });
  }
  if (path === '/bot' && !post) {
    const s = store(env);
    return json(env, { bot: botStatus(await s.getBotConfig()), chats: await s.listChats() });
  }
  if (path === '/bot/connect' && post) return json(env, { bot: botStatus(await botConnect(env, url.origin, await body(req, 50_000))) });
  if (path === '/bot/settings' && post) {
    const s = store(env);
    const cfg = await s.getBotConfig();
    if (!cfg) throw new HttpError(409, 'bot not connected');
    const next = { ...cfg, ...validateSettings(await body(req, 50_000), cfg) };
    if (next.language !== cfg.language) await connect(new Telegram(cfg.token), `${url.origin}/bot/webhook`, cfg.secret, next.language);
    await s.setBotConfig(next);
    return json(env, { bot: botStatus(next) });
  }
  if (path === '/bot/owner/reset' && post) {
    const s = store(env);
    const cfg = await s.getBotConfig();
    if (!cfg) throw new HttpError(409, 'bot not connected');
    const next = { ...cfg, ownerId: null, ownerName: null, pairCode: randomHex(8) };
    await s.setBotConfig(next);
    return json(env, { bot: botStatus(next) });
  }
  if (path === '/bot/chats' && post) {
    const { id, allowed } = await body<{ id?: unknown; allowed?: unknown }>(req, 1000);
    if (!Number.isSafeInteger(id) || typeof allowed !== 'boolean') throw new HttpError(400, 'id and allowed required');
    await store(env).setChatAllowed(id as number, allowed);
    return json(env, { chats: await store(env).listChats() });
  }
  if (path === '/bot/disconnect' && post) {
    const s = store(env);
    const cfg = await s.getBotConfig();
    if (cfg) await new Telegram(cfg.token).call('deleteWebhook', { drop_pending_updates: true }).catch(() => {});
    await s.clearBot();
    return json(env, { bot: null, chats: [] });
  }
  if (path === '/digest/run' && post) return json(env, { digest: await runDigest(env, Date.now()) });
  return json(env, { error: 'not found' }, 404);
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json(env, { error: e.message }, e.status);
      // Workers AI reports exhausted daily neurons as an error; pass a 429 so the hub falls back.
      const msg = e instanceof Error ? e.message : String(e);
      const status = /neuron|quota|limit|capacity/i.test(msg) ? 429 : 502;
      return json(env, { error: msg }, status);
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    const s = store(env);
    if (due(await s.getDigestConfig(), event.scheduledTime, await s.lastDigestAt())) {
      ctx.waitUntil(runDigest(env, event.scheduledTime).then(() => undefined));
    }
  },
} satisfies ExportedHandler<Env>;
