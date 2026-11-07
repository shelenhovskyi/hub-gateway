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

export function authorized(req: Request, env: Env): boolean {
  return !!env.ADMIN_TOKEN && sameSecret(req.headers.get('Authorization'), `Bearer ${env.ADMIN_TOKEN}`);
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

/**
 * Constant-time compare, so a secret can't be guessed byte by byte from response timing. Written out
 * rather than `crypto.subtle.timingSafeEqual`, which exists only on Workers and so not in tests.
 */
export function sameSecret(a: string | null, b: string): boolean {
  const x = new TextEncoder().encode(a ?? '');
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) diff |= (x[i] ?? 0) ^ y[i]!;
  return diff === 0;
}

/**
 * Passes on at most `max` bytes, then cancels the source, so a huge response stops downloading
 * instead of being read to the end and thrown away.
 */
export function capStream(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const { done, value } = await reader.read();
      if (done) return ctl.close();
      const room = max - seen;
      if (value.byteLength < room) {
        seen += value.byteLength;
        return ctl.enqueue(value);
      }
      if (room > 0) ctl.enqueue(value.subarray(0, room));
      seen = max;
      ctl.close();
      await reader.cancel().catch(() => {});
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
