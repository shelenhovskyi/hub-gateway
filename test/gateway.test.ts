import { describe, expect, it } from 'vitest';
import * as ai from '../src/ai.ts';
import { buildDigest, due, validateConfig } from '../src/digest.ts';
import { parseFeed } from '../src/feed.ts';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>First &amp; best</title><link>https://ex.com/1</link><description><![CDATA[<p>Hello <b>world</b></p>]]></description><pubDate>Sat, 07 Nov 2026 05:00:00 GMT</pubDate></item>
<item><title>Old news</title><link>https://ex.com/2</link><pubDate>Sat, 01 Nov 2026 05:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom &#8212; item</title><link href="https://ex.com/a"/><summary>Short</summary><updated>2026-11-07T04:00:00Z</updated></entry></feed>`;

const NOW = Date.parse('2026-11-07T06:00:00Z');

describe('parseFeed', () => {
  it('reads RSS with CDATA, entities and HTML', () => {
    expect(parseFeed(RSS)[0]).toEqual({ title: 'First & best', link: 'https://ex.com/1', summary: 'Hello world', published: Date.parse('2026-11-07T05:00:00Z') });
  });

  it('reads Atom links from href and numeric entities', () => {
    expect(parseFeed(ATOM)[0]).toMatchObject({ title: 'Atom — item', link: 'https://ex.com/a', summary: 'Short' });
  });

  it('caps the number of items', () => {
    expect(parseFeed(RSS.repeat(20), 3)).toHaveLength(3);
  });
});

describe('digest', () => {
  it('validates config', () => {
    expect(validateConfig({ feeds: ['https://ex.com/rss'], hourUtc: 7, language: 'uk' })).toEqual({ enabled: true, feeds: ['https://ex.com/rss'], hourUtc: 7, language: 'uk' });
    expect(() => validateConfig({ feeds: ['http://ex.com/rss'] })).toThrow('https');
    expect(() => validateConfig({ feeds: ['file:///etc/passwd'] })).toThrow('https');
    expect(() => validateConfig({ feeds: Array(11).fill('https://ex.com') })).toThrow('at most');
    expect(() => validateConfig({ hourUtc: 24 })).toThrow('0-23');
  });

  it('is due once a day in the configured hour', () => {
    const cfg = validateConfig({ feeds: ['https://ex.com/rss'], hourUtc: 6 });
    expect(due(cfg, NOW, null)).toBe(true);
    expect(due(cfg, NOW + 3600_000, null)).toBe(false);
    expect(due(cfg, NOW, NOW - 3600_000)).toBe(false);
    expect(due(cfg, NOW, NOW - 24 * 3600_000)).toBe(true);
    expect(due({ ...cfg, enabled: false }, NOW, null)).toBe(false);
    expect(due(null, NOW, null)).toBe(false);
  });

  it('keeps fresh items, reports broken feeds, and asks for a summary in the chosen language', async () => {
    let prompt = '';
    const d = await buildDigest(validateConfig({ feeds: ['https://ok', 'https://broken'], language: 'uk' }), {
      now: NOW,
      fetchText: async (u) => {
        if (u === 'https://broken') throw new Error('HTTP 500');
        return RSS;
      },
      summarize: async (p) => {
        prompt = p;
        return ' - Summary ';
      },
    });
    expect(d.items.map((i) => i.title)).toEqual(['First & best']);
    expect(d.errors).toEqual(['https://broken: HTTP 500']);
    expect(d.summary).toBe('- Summary');
    expect(prompt).toContain('in Ukrainian');
  });

  it('skips the model call when there is nothing new', async () => {
    let called = false;
    const d = await buildDigest(validateConfig({ feeds: ['https://ok'] }), {
      now: NOW + 30 * 24 * 3600_000,
      fetchText: async () => RSS,
      summarize: async () => ((called = true), 'x'),
    });
    expect(d.items).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('Workers AI calls', () => {
  it('only lets callers pick @cf/ models', async () => {
    const seen: string[] = [];
    const run = async (m: string) => (seen.push(m), { image: 'b64' });
    await ai.image(run, { prompt: 'cat' });
    await ai.image(run, { prompt: 'cat', model: '@cf/black-forest-labs/flux-1-schnell' });
    await expect(ai.image(run, { prompt: 'cat', model: 'openai/gpt-image' })).rejects.toThrow('@cf/');
    expect(seen).toEqual([ai.MODELS.image, ai.MODELS.image]);
  });

  it('requires input', async () => {
    const run = async () => ({});
    await expect(ai.image(run, {})).rejects.toThrow('prompt required');
    await expect(ai.stt(run, {})).rejects.toThrow('audio');
    await expect(ai.tts(run, { text: ' ' })).rejects.toThrow('text required');
  });
});
