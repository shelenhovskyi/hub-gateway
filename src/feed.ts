export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  published?: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1];
}

/** Links end up as an `href` in the hub app, so only web addresses survive. */
function webLink(s: string): string {
  try {
    const p = new URL(s).protocol;
    return p === 'https:' || p === 'http:' ? s : '';
  } catch {
    return '';
  }
}

/**
 * Minimal RSS 2.0 / Atom reader. Workers have no DOMParser, and the free plan allows 10 ms of CPU
 * per invocation, so this is a few regexes over at most `maxBytes` of input rather than an XML parser.
 */
export function parseFeed(xml: string, limit = 10): FeedItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks.slice(0, limit).map((b) => {
    const atomLink = b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const date = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated');
    const published = date ? Date.parse(decode(date)) : NaN;
    return {
      title: decode(tag(b, 'title') ?? ''),
      link: webLink(decode(tag(b, 'link') ?? '') || decode(atomLink ?? '')),
      summary: decode(tag(b, 'description') ?? tag(b, 'summary') ?? tag(b, 'content') ?? '').slice(0, 400),
      ...(Number.isFinite(published) && { published }),
    };
  });
}
