// Models answer in Markdown; Telegram renders a small HTML subset (parse_mode: "HTML").
// HTML is used instead of Telegram's MarkdownV2 because MarkdownV2 needs ~20 characters escaped
// and rejects the whole message on a single miss.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = md
    .replace(/```([\w+-]*)[^\S\n]*\n([\s\S]*?)```/g, (_, lang: string, code: string) =>
      hold(
        lang
          ? `<pre><code class="language-${lang}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
          : `<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`,
      ),
    )
    .replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s);

  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
      hold(`<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`),
    )
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '<b>$1</b>')
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    .replace(/^&gt;[ \t]?(.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/<\/blockquote>\n<blockquote>/g, '\n')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<b>$1</b>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    // Letters in any script count as word characters, so snake_case and 2*3*4 stay as they are.
    .replace(/(^|[^\p{L}\p{N}_*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\p{L}\p{N}_*])/gu, '$1<i>$2</i>')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1<i>$2</i>')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '──────────')
    .replace(/\|\|(?=\S)([^|\n]*?\S)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    // ':::details … :::' is our own convention for a collapsed block; Telegram shows it with "show more".
    .replace(/^:::details[^\n]*\n([\s\S]*?)\n:::[ \t]*$/gm, (_, body: string) => `<blockquote expandable>${body.replace(/<\/?blockquote>/g, '')}</blockquote>`)
    // An unmatched marker (e.g. a long answer split across messages) is dropped rather than shown raw.
    .replace(/^:::(?:details)?[^\n]*$\n?/gm, '');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)] ?? '');
}

