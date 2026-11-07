import { type FeedItem, parseFeed } from './feed.ts';
import { HttpError } from './http.ts';

export interface DigestConfig {
  enabled: boolean;
  feeds: string[];
  /** ISO 639 code the summary is written in. */
  language: string;
  /** UTC hour at which the hourly cron builds the digest. */
  hourUtc: number;
}

export interface Digest {
  createdAt: number;
  summary: string;
  items: (FeedItem & { feed: string })[];
  errors: string[];
}

export const MAX_FEEDS = 10;
const MAX_FEED_BYTES = 1_000_000;
const DAY_MS = 24 * 3600_000;

export function validateConfig(x: unknown): DigestConfig {
  const c = (x ?? {}) as Partial<Record<keyof DigestConfig, unknown>>;
  const feeds = Array.isArray(c.feeds) ? c.feeds : [];
  if (feeds.length > MAX_FEEDS) throw new HttpError(400, `at most ${MAX_FEEDS} feeds`);
  for (const f of feeds) {
    if (typeof f !== 'string' || !/^https:\/\/[^\s]+$/.test(f)) throw new HttpError(400, `feed must be an https URL: ${String(f)}`);
  }
  const hour = Number(c.hourUtc ?? 6);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new HttpError(400, 'hourUtc must be 0-23');
  const language = typeof c.language === 'string' && /^[a-z]{2,3}$/.test(c.language) ? c.language : 'en';
  return { enabled: c.enabled !== false, feeds: feeds as string[], language, hourUtc: hour };
}

/** Builds at most once per day, in the configured hour; a missed hour (deploy, outage) waits for the next day. */
export function due(cfg: DigestConfig | null, now: number, lastRunAt: number | null): boolean {
  if (!cfg?.enabled || cfg.feeds.length === 0) return false;
  if (new Date(now).getUTCHours() !== cfg.hourUtc) return false;
  return lastRunAt === null || now - lastRunAt > DAY_MS - 3600_000;
}

export async function fetchFeed(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'application/rss+xml, application/atom+xml, text/xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, MAX_FEED_BYTES);
}

export async function buildDigest(
  cfg: DigestConfig,
  deps: { fetchText: (url: string) => Promise<string>; summarize: (prompt: string) => Promise<string>; now: number },
): Promise<Digest> {
  const errors: string[] = [];
  const perFeed = await Promise.all(
    cfg.feeds.map(async (feed) => {
      try {
        const items = parseFeed(await deps.fetchText(feed));
        // Feeds without dates still contribute their newest few entries.
        const fresh = items.filter((i) => i.published === undefined || deps.now - i.published < DAY_MS);
        return fresh.slice(0, 5).map((i) => ({ ...i, feed }));
      } catch (e) {
        errors.push(`${feed}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );
  const items = perFeed.flat().slice(0, 30);
  const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(cfg.language) ?? 'English';
  const summary = items.length
    ? await deps.summarize(
        `Write a short morning digest in ${language} of these headlines. Group related ones, 4-6 short lines starting with "- ", no preamble.\n\n` +
          items.map((i) => `- ${i.title}: ${i.summary}`).join('\n'),
      )
    : '';
  return { createdAt: deps.now, summary: summary.trim(), items, errors };
}
