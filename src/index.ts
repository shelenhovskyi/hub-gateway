import * as ai from './ai.ts';
import { buildDigest, due, fetchFeed, validateConfig } from './digest.ts';
import { authorized, body, cors, type Env, HttpError, json } from './http.ts';

export { Store } from './store.ts';

// The entry module may export only handlers and Durable Object classes; workerd refuses anything else.
const VERSION = '0.1.0';
const MODULES = ['image', 'stt', 'tts', 'digest'] as const;
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

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (path === '/health') return json(env, { ok: true, version: VERSION, configured: !!env.ADMIN_TOKEN });
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
  if (path === '/digest/run' && post) return json(env, { digest: await runDigest(env, Date.now()) });
  return json(env, { error: 'not found' }, 404);
}

export default {
  async fetch(req, env): Promise<Response> {
    try {
      return await route(req, env);
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
