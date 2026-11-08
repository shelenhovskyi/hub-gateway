/**
 * Web Push from a Worker with WebCrypto only: VAPID (RFC 8292) to say who sends, and the
 * aes128gcm content encoding (RFC 8291) so only the subscribed browser can read the message.
 * The push service (Apple, Google, Mozilla) relays ciphertext it cannot open.
 */

export interface Subscription {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** 16 random bytes from the browser, base64url. */
  auth: string;
}

export interface Vapid {
  /** Uncompressed P-256 point, base64url; the app hands it to pushManager.subscribe. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();
/** TextEncoder's output typed as backed by a plain ArrayBuffer, as WebCrypto's parameters want. */
const utf8 = (s: string) => encoder.encode(s) as Uint8Array<ArrayBuffer>;
const enc = { encode: utf8 };
const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export async function newVapid(): Promise<Vapid> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  return { publicKey: b64u(raw), privateJwk: (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey };
}

/** The Authorization header for one push service origin; good for 12 hours. */
export async function vapidHeader(endpoint: string, v: Vapid, subject: string, now: number): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto gives the raw r‖s signature JWS wants, not DER.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * The encrypted body for one subscription (RFC 8291 §3–4): a fresh key pair and salt per message,
 * one record. `fixed` is for tests only.
 */
export async function encrypt(sub: Subscription, payload: Uint8Array, fixed?: { keys: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> }): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const as = fixed?.keys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // The standard name is `public`; workers-types spells it `$public`, workerd accepts the standard one.
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // A single record ends with the 0x02 delimiter.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export type PushResult = 'sent' | 'gone' | { error: string };

/** Sends one message. `gone` means the browser unsubscribed and the subscription should be dropped. */
export async function push(
  sub: Subscription,
  message: { title: string; body: string; url?: string },
  v: Vapid,
  subject: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  now: number,
): Promise<PushResult> {
  const body = await encrypt(sub, enc.encode(JSON.stringify(message).slice(0, 3000)));
  let res: Response;
  try {
    res = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(sub.endpoint, v, subject, now), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
      body,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) return { error: `push service HTTP ${res.status}` };
  return 'sent';
}

/** Push services browsers use; a subscription anywhere else is refused, so the gateway can't be aimed at arbitrary URLs. */
export function knownPushService(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}
