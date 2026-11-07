export interface Env {
  AI: Ai;
  STORE: DurableObjectNamespace<import('./store.ts').Store>;
  ADMIN_TOKEN?: string;
  /** Origin of the hub app allowed to call this gateway; `*` is safe only because every call needs the token. */
  ALLOWED_ORIGIN?: string;
}

export function cors(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function json(env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
}

/** Constant-time compare, so the token can't be guessed byte by byte from response timing. */
export function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const a = new TextEncoder().encode(req.headers.get('Authorization') ?? '');
  const b = new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function body<T>(req: Request, maxBytes: number): Promise<T> {
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, 'request too large');
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
