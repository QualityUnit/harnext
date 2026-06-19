/**
 * Lightweight, dependency-free HTML→Markdown conversion for the WebFetch tool.
 *
 * The big harnesses (Claude Code, opencode) use `turndown`, which in Node also
 * pulls in a DOM implementation (jsdom). To keep `@harnext/core` dependency-light
 * and its tests hermetic, we implement a focused converter that handles the tags
 * that matter for agent reading — headings, links, lists, emphasis, code, and
 * block structure — and strips everything else. It is intentionally lossy on
 * exotic markup; the goal is readable text, not a faithful round-trip.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  deg: '°',
  middot: '·',
  bull: '•',
};

/** Decode HTML entities (named + decimal/hex numeric) into plain text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Pull the contents of the first <title> tag, if any. */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const text = decodeEntities(m[1].replace(/\s+/g, ' ')).trim();
  return text.length > 0 ? text : undefined;
}

/** Remove elements whose contents are never useful as reading material. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '');
}

/**
 * Convert an HTML document or fragment to Markdown-ish plain text.
 */
export function htmlToMarkdown(html: string): string {
  let s = stripNonContent(html);

  // Headings.
  for (let level = 1; level <= 6; level++) {
    const hashes = '#'.repeat(level);
    s = s.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi'),
      (_m, inner: string) => `\n\n${hashes} ${collapseInline(inner)}\n\n`,
    );
  }

  // Preformatted / code blocks — preserve internal whitespace, fence them.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>(?=)/gi, '\n')));
    return `\n\n\`\`\`\n${code.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  });

  // Inline code.
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    return '`' + collapseInline(inner) + '`';
  });

  // Links — [text](href).
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _q, href: string, inner: string) => {
      const text = collapseInline(inner);
      const url = decodeEntities(href).trim();
      if (!text) return url;
      if (!url || url.startsWith('javascript:')) return text;
      return `[${text}](${url})`;
    },
  );

  // Emphasis.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${collapseInline(inner)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${collapseInline(inner)}*`);

  // List items.
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${collapseInline(inner)}`);

  // Block boundaries → blank lines.
  s = s.replace(/<\/(p|div|section|article|header|footer|ul|ol|table|tr|blockquote|h[1-6])\s*>/gi, '\n\n');
  s = s.replace(/<br\s*\/?>(?=)/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' \t ');

  // Drop everything else and decode entities.
  s = stripTags(s);
  s = decodeEntities(s);

  // Normalize whitespace: trim trailing spaces, collapse 3+ newlines.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, (m) => (m.length > 0 ? '' : m)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return s;
}

/** Strip all remaining tags. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** Reduce an inline fragment to single-line text (tags removed, entities decoded). */
function collapseInline(inner: string): string {
  return decodeEntities(stripTags(inner))
    .replace(/\s+/g, ' ')
    .trim();
}
