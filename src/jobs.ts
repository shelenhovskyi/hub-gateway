import { HttpError } from './http.ts';

/**
 * Scheduled jobs. They run from a Durable Object alarm rather than the hourly cron: each alarm is
 * its own invocation with its own CPU and subrequest budget, and fires at the exact minute.
 */
export type JobKind = 'watch' | 'remind' | 'weather';
export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface WatchConfig {
  url: string;
  /** `text`: tell me when this part of the page changes; `price`: tell me the price, or when it drops below `below`. */
  mode: 'text' | 'price';
  /** CSS selector for the part to watch; the whole page text without it. */
  selector?: string;
  below?: number;
  intervalMin: number;
}

export interface RemindConfig {
  text: string;
  /** Local date (YYYY-MM-DD) of the first or only time. */
  date: string;
  /** Local time, HH:MM. */
  time: string;
  repeat: Repeat;
}

export interface WeatherConfig {
  place: string;
  lat: number;
  lon: number;
  /** Local time of the morning check, HH:MM. */
  time: string;
  /** Send the forecast every day, or only when one of the alerts below triggers. */
  daily: boolean;
  rainAtLeast: number;
  frostBelow: number | null;
  heatAbove: number | null;
}

export type JobConfig = { kind: 'watch'; config: WatchConfig } | { kind: 'remind'; config: RemindConfig } | { kind: 'weather'; config: WeatherConfig };

export interface JobState {
  lastAt?: number;
  lastOk?: boolean;
  /** What the last run found, in words, for the app to show. */
  lastResult?: string;
  /** Watch: fingerprint of the watched text, or the last price. */
  value?: string;
  etag?: string;
  failures?: number;
}

export type Job = JobConfig & {
  id: string;
  title: string;
  timezone: string;
  /** Language of the notification text. */
  language: 'en' | 'uk';
  enabled: boolean;
  /** Telegram chat to notify; the bot's owner when absent. */
  chatId?: number;
  nextAt: number;
  createdAt: number;
  state: JobState;
};

export const MAX_JOBS = 50;
export const MIN_WATCH_MIN = 15;
/** After this many failures in a row a watch pauses itself instead of hammering a site that blocks it. */
export const MAX_FAILURES = 6;

const isTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function validTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    throw new HttpError(400, `unknown time zone: ${tz}`);
  }
}

/** Builds a job from what the app (or the bot) sends; ids and timing are ours. */
export function validateJob(x: unknown, now: number, existing?: Job): Job {
  const j = (x ?? {}) as Record<string, unknown>;
  const kind = j.kind;
  const c = (j.config ?? {}) as Record<string, unknown>;
  const timezone = validTimezone(j.timezone ?? existing?.timezone);
  const language = j.language === 'uk' ? 'uk' : 'en';
  let jc: JobConfig;
  if (kind === 'watch') {
    if (typeof c.url !== 'string' || !/^https:\/\/[^\s]+$/.test(c.url)) throw new HttpError(400, 'url must be an https address');
    const mode = c.mode === 'price' ? 'price' : 'text';
    const selector = typeof c.selector === 'string' && c.selector.trim() ? c.selector.trim().slice(0, 200) : undefined;
    const below = c.below === undefined || c.below === null || c.below === '' ? undefined : Number(c.below);
    if (below !== undefined && !(below > 0)) throw new HttpError(400, 'below must be a positive number');
    const intervalMin = Math.max(MIN_WATCH_MIN, Math.min(24 * 60, Math.round(Number(c.intervalMin ?? 60)) || 60));
    jc = { kind, config: { url: c.url, mode, intervalMin, ...(selector && { selector }), ...(below !== undefined && { below }) } };
  } else if (kind === 'remind') {
    if (typeof c.text !== 'string' || !c.text.trim()) throw new HttpError(400, 'reminder text required');
    if (!isDate(c.date) || !isTime(c.time)) throw new HttpError(400, 'date (YYYY-MM-DD) and time (HH:MM) required');
    const repeat = (['none', 'daily', 'weekdays', 'weekly', 'monthly'] as const).find((r) => r === c.repeat) ?? 'none';
    jc = { kind, config: { text: c.text.trim().slice(0, 1000), date: c.date, time: c.time, repeat } };
  } else if (kind === 'weather') {
    const lat = Number(c.lat);
    const lon = Number(c.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || typeof c.place !== 'string') throw new HttpError(400, 'place with lat and lon required');
    if (!isTime(c.time)) throw new HttpError(400, 'time (HH:MM) required');
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    jc = {
      kind,
      config: {
        place: c.place.slice(0, 100),
        lat,
        lon,
        time: c.time,
        daily: c.daily !== false,
        rainAtLeast: Math.max(0, Math.min(100, Number(c.rainAtLeast ?? 60) || 60)),
        frostBelow: num(c.frostBelow),
        heatAbove: num(c.heatAbove),
      },
    };
  } else throw new HttpError(400, 'kind must be watch, remind or weather');

  const job = {
    ...jc,
    id: existing?.id ?? crypto.randomUUID(),
    title: typeof j.title === 'string' && j.title.trim() ? j.title.trim().slice(0, 100) : defaultTitle(jc),
    timezone,
    language,
    enabled: j.enabled !== false,
    ...(Number.isSafeInteger(j.chatId) ? { chatId: j.chatId as number } : existing?.chatId !== undefined ? { chatId: existing.chatId } : {}),
    createdAt: existing?.createdAt ?? now,
    // A changed config starts fresh: an old price or fingerprint would compare against the wrong thing.
    state: existing && JSON.stringify(existing.config) === JSON.stringify(jc.config) ? existing.state : {},
    nextAt: 0,
  } as Job;
  job.nextAt = firstRun(job, now);
  return job;
}

function defaultTitle(j: JobConfig): string {
  if (j.kind === 'watch') return new URL(j.config.url).hostname;
  if (j.kind === 'remind') return j.config.text.slice(0, 60);
  return j.config.place;
}

/** Year, month, day, weekday (0 = Sunday), hour and minute of `ts` on the wall clock in `tz`. */
export function wallClock(ts: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(ts)
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
  };
}

/** The instant a wall-clock time happens in `tz`. Two passes settle the offset across a DST change. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(ts, tz);
    ts += want - Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  }
  return ts;
}

const hm = (t: string) => t.split(':').map(Number) as [number, number];

/** Next local `time` on a day that `ok` accepts, strictly after `after`. */
function nextLocal(after: number, time: string, tz: string, ok: (day: { y: number; m: number; d: number; wd: number }) => boolean): number {
  const [hh, mm] = hm(time);
  const start = wallClock(after, tz);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const parts = { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), wd: day.getUTCDay() };
    if (!ok(parts)) continue;
    const ts = zonedTime(parts.y, parts.m, parts.d, hh, mm, tz);
    if (ts > after) return ts;
  }
  return Number.POSITIVE_INFINITY;
}

function firstRun(job: Job, now: number): number {
  if (job.kind === 'watch') return now + 60_000;
  if (job.kind === 'weather') return nextLocal(now, job.config.time, job.timezone, () => true);
  const [y, m, d] = job.config.date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hm(job.config.time);
  const first = zonedTime(y, m, d, hh, mm, job.timezone);
  return first > now ? first : nextAfter(job, now);
}

/** When to run next after a run at `now`; infinity ends the job. */
export function nextAfter(job: Job, now: number): number {
  if (job.kind === 'watch') return now + job.config.intervalMin * 60_000;
  if (job.kind === 'weather') return nextLocal(now, job.config.time, job.timezone, () => true);
  const c = job.config;
  const [, , day] = c.date.split('-').map(Number) as [number, number, number];
  const startWd = new Date(`${c.date}T12:00:00Z`).getUTCDay();
  switch (c.repeat) {
    case 'none':
      return Number.POSITIVE_INFINITY;
    case 'daily':
      return nextLocal(now, c.time, job.timezone, () => true);
    case 'weekdays':
      return nextLocal(now, c.time, job.timezone, (p) => p.wd >= 1 && p.wd <= 5);
    case 'weekly':
      return nextLocal(now, c.time, job.timezone, (p) => p.wd === startWd);
    case 'monthly':
      // A 31st falls on the last day of shorter months.
      return nextLocal(now, c.time, job.timezone, (p) => p.d === Math.min(day, new Date(Date.UTC(p.y, p.m, 0)).getUTCDate()));
  }
}

const NOTE = {
  en: {
    changed: (t: string, url: string, snippet: string) => `🔔 “${t}” changed:\n${snippet}\n\n${url}`,
    price: (t: string, p: string, url: string) => `💸 ${t}: the price is now ${p}\n${url}`,
    priceBelow: (t: string, p: string, below: number, url: string) => `💸 ${t}: ${p}, below your ${below}!\n${url}`,
    noPrice: 'No price found on the page',
    unchanged: 'No change',
    blocked: (status: number) => `The site refused the check (HTTP ${status}). Many shops block automated checks.`,
    missing: 'The page is gone (HTTP 404). Check the address.',
    paused: (t: string) => `⏸ I paused watching “${t}”: the site kept refusing. Open the hub app to change or resume it.`,
    reminder: (text: string) => `⏰ ${text}`,
    weather: (place: string, min: number, max: number, rain: number) => `🌤 Today in ${place}: ${Math.round(min)}…${Math.round(max)}°C, chance of rain ${rain}%.`,
    umbrella: 'Take an umbrella.',
    frost: (t: number) => `Frost: down to ${Math.round(t)}°C.`,
    heat: (t: number) => `Heat: up to ${Math.round(t)}°C.`,
    quiet: 'Nothing to warn about',
  },
  uk: {
    changed: (t: string, url: string, snippet: string) => `🔔 «${t}» змінилось:\n${snippet}\n\n${url}`,
    price: (t: string, p: string, url: string) => `💸 ${t}: ціна тепер ${p}\n${url}`,
    priceBelow: (t: string, p: string, below: number, url: string) => `💸 ${t}: ${p}, нижче твоїх ${below}!\n${url}`,
    noPrice: 'Ціну на сторінці не знайдено',
    unchanged: 'Без змін',
    blocked: (status: number) => `Сайт відмовив у перевірці (HTTP ${status}). Багато магазинів блокують автоматичні перевірки.`,
    missing: 'Сторінки більше немає (HTTP 404). Перевір адресу.',
    paused: (t: string) => `⏸ Я призупинив стеження за «${t}»: сайт постійно відмовляє. Відкрий застосунок hub, щоб змінити чи відновити.`,
    reminder: (text: string) => `⏰ ${text}`,
    weather: (place: string, min: number, max: number, rain: number) => `🌤 Сьогодні в ${place}: ${Math.round(min)}…${Math.round(max)}°C, імовірність дощу ${rain}%.`,
    umbrella: 'Візьми парасольку.',
    frost: (t: number) => `Мороз: до ${Math.round(t)}°C.`,
    heat: (t: number) => `Спека: до ${Math.round(t)}°C.`,
    quiet: 'Попереджати нема про що',
  },
};

export interface RunResult {
  state: JobState;
  /** Text to send, if this run has something to tell. */
  notify?: string;
  /** Turn the job off (a site that keeps refusing). */
  disable?: boolean;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_PAGE_BYTES = 2_000_000;
const UA = 'Mozilla/5.0 (compatible; hub-gateway/0.4; personal page watch)';

export async function runJob(job: Job, deps: { fetch: Fetch; now: number }): Promise<RunResult> {
  const n = NOTE[job.language];
  const base: JobState = { ...job.state, lastAt: deps.now };
  try {
    if (job.kind === 'remind') return { state: { ...base, lastOk: true, lastResult: job.config.text }, notify: n.reminder(job.config.text) };
    if (job.kind === 'weather') return await runWeather(job, base, deps);
    return await runWatch(job, base, deps);
  } catch (e) {
    const failures = (job.state.failures ?? 0) + 1;
    const message = e instanceof Error ? e.message : String(e);
    const state = { ...base, lastOk: false, lastResult: message, failures };
    if (job.kind === 'watch' && failures >= MAX_FAILURES) return { state, notify: n.paused(job.title), disable: true };
    return { state };
  }
}

async function runWatch(job: Job & { kind: 'watch' }, base: JobState, deps: { fetch: Fetch }): Promise<RunResult> {
  const n = NOTE[job.language];
  const c = job.config;
  const res = await deps.fetch(c.url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', ...(job.state.etag && { 'If-None-Match': job.state.etag }) },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 304) return { state: { ...base, lastOk: true, lastResult: n.unchanged, failures: 0 } };
  if (!res.ok) throw new Error(res.status === 404 || res.status === 410 ? n.missing : n.blocked(res.status));
  const etag = res.headers.get('ETag') ?? undefined;
  const page = await extract(res, c.selector);
  const ok = { ...base, lastOk: true, failures: 0, ...(etag && { etag }) };

  if (c.mode === 'price') {
    const price = findPrice(page.jsonLd, page.meta, page.text);
    if (!price) return { state: { ...ok, lastResult: n.noPrice } };
    const shown = `${price.amount}${price.currency ? ` ${price.currency}` : ''}`;
    const prev = job.state.value === undefined ? undefined : Number(job.state.value);
    const state = { ...ok, value: String(price.amount), lastResult: shown };
    if (c.below !== undefined) {
      const crossed = price.amount < c.below && !(prev !== undefined && prev < c.below);
      return crossed ? { state, notify: n.priceBelow(job.title, shown, c.below, c.url) } : { state };
    }
    return prev !== undefined && prev !== price.amount ? { state, notify: n.price(job.title, shown, c.url) } : { state };
  }

  const text = page.text.replace(/\s+/g, ' ').trim().slice(0, 50_000);
  const hash = await sha256(text);
  const state = { ...ok, value: hash, lastResult: text.slice(0, 200) };
  // The first run only learns what the page looks like.
  if (job.state.value === undefined || job.state.value === hash) return { state: { ...state, lastResult: job.state.value === undefined ? text.slice(0, 200) : n.unchanged } };
  return { state, notify: n.changed(job.title, c.url, text.slice(0, 300)) };
}

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Streams the page through HTMLRewriter and keeps only what a watch needs, so a large page never
 * sits in memory as a DOM (the free plan allows 10 ms of CPU per run).
 */
async function extract(res: Response, selector?: string): Promise<{ text: string; jsonLd: string[]; meta: Record<string, string> }> {
  let text = '';
  let depth = 0;
  let skip = 0;
  const jsonLd: string[] = [];
  let ld = '';
  const meta: Record<string, string> = {};
  const target = selector ?? 'body';
  const rw = new HTMLRewriter()
    .on(target, {
      element(el) {
        depth++;
        el.onEndTag(() => void (depth--, (text += '\n')));
      },
      text(t) {
        if (depth > 0 && skip === 0 && text.length < 200_000) text += t.text;
      },
    })
    .on('script, style, noscript, svg', {
      element(el) {
        skip++;
        el.onEndTag(() => void skip--);
      },
    })
    .on('script[type="application/ld+json"]', {
      text(t) {
        ld += t.text;
        if (t.lastInTextNode) (jsonLd.push(ld), (ld = ''));
      },
    })
    .on('meta', {
      element(el) {
        const key = el.getAttribute('property') ?? el.getAttribute('itemprop') ?? el.getAttribute('name');
        const value = el.getAttribute('content');
        if (key && value && /price|currency/i.test(key)) meta[key.toLowerCase()] = value;
      },
    });
  const body = res.body ? limit(res.body, MAX_PAGE_BYTES) : null;
  await rw.transform(new Response(body, { headers: res.headers })).arrayBuffer();
  return { text, jsonLd, meta };
}

function limit(stream: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (seen >= max) return;
        seen += chunk.byteLength;
        ctl.enqueue(chunk);
      },
    }),
  );
}

/**
 * The price of the page's Product: JSON-LD `offers` (most shops), then price meta tags. Offers that
 * aren't a product's (shipping, a bundle of other items) are ignored, and so is any price in the
 * text: guessing from text gets the wrong number too often.
 */
export function findPrice(jsonLd: string[], meta: Record<string, string>, _text: string): { amount: number; currency?: string } | null {
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const isType = (o: Record<string, unknown>, t: string) => o['@type'] === t || (Array.isArray(o['@type']) && o['@type'].includes(t));
  const products: Record<string, unknown>[] = [];
  for (const raw of jsonLd) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const x = stack.shift();
      if (Array.isArray(x)) stack.push(...x);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (isType(o, 'Product') || isType(o, 'ProductGroup')) products.push(o);
        else stack.push(...Object.values(o).filter((v) => v && typeof v === 'object'));
      }
    }
  }
  for (const p of products) {
    const offers = ([] as unknown[]).concat(p.offers ?? [], (p.hasVariant as Record<string, unknown>[] | undefined)?.map((v) => v.offers) ?? []).flat();
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object') continue;
      const o = offer as Record<string, unknown>;
      const spec = (o.priceSpecification ?? {}) as Record<string, unknown>;
      const amount = num(o.price ?? o.lowPrice ?? spec.price);
      const currency = o.priceCurrency ?? spec.priceCurrency;
      if (amount) return { amount, ...(typeof currency === 'string' && { currency }) };
    }
  }
  const amount = num(meta['product:price:amount'] ?? meta['og:price:amount']);
  if (amount) {
    const currency = meta['product:price:currency'] ?? meta['og:price:currency'];
    return { amount, ...(currency && { currency }) };
  }
  return null;
}

/** Open-Meteo: free and keyless for non-commercial use, which a person's own gateway is. */
async function runWeather(job: Job & { kind: 'weather' }, base: JobState, deps: { fetch: Fetch }): Promise<RunResult> {
  const n = NOTE[job.language];
  const c = job.config;
  const q = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lon),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: job.timezone,
    forecast_days: '1',
  });
  const res = await deps.fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const d = ((await res.json()) as { daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] } }).daily;
  const max = d.temperature_2m_max[0]!;
  const min = d.temperature_2m_min[0]!;
  const rain = d.precipitation_probability_max[0] ?? 0;
  const alerts = [
    rain >= c.rainAtLeast ? n.umbrella : '',
    c.frostBelow !== null && min < c.frostBelow ? n.frost(min) : '',
    c.heatAbove !== null && max > c.heatAbove ? n.heat(max) : '',
  ].filter(Boolean);
  const summary = n.weather(c.place, min, max, rain);
  const state = { ...base, lastOk: true, failures: 0, lastResult: [summary, ...alerts].join(' ') };
  if (!c.daily && alerts.length === 0) return { state: { ...state, lastResult: `${summary} ${n.quiet}` } };
  return { state, notify: [summary, ...alerts].join('\n') };
}
