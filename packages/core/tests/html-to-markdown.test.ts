import { describe, expect, it } from 'vitest';

import { decodeEntities, extractTitle, htmlToMarkdown } from '../src/tools/html-to-markdown.js';

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex entities', () => {
    expect(decodeEntities('a &amp; b &lt; c &gt; d')).toBe('a & b < c > d');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('caf&eacute;')).toBe('caf&eacute;'); // unknown named left as-is
    expect(decodeEntities('&nbsp;')).toBe(' ');
  });
});

describe('extractTitle', () => {
  it('pulls the title text', () => {
    expect(extractTitle('<html><head><title>Hello &amp; Bye</title></head></html>')).toBe(
      'Hello & Bye',
    );
  });
  it('returns undefined when absent', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBeUndefined();
  });
});

describe('htmlToMarkdown', () => {
  it('strips scripts and styles entirely', () => {
    const html = '<p>keep</p><script>alert(1)</script><style>.x{}</style>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('keep');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('.x{}');
  });

  it('converts headings', () => {
    expect(htmlToMarkdown('<h1>Title</h1><h2>Sub</h2>')).toContain('# Title');
    expect(htmlToMarkdown('<h2>Sub</h2>')).toContain('## Sub');
  });

  it('converts links to markdown', () => {
    expect(htmlToMarkdown('<a href="https://x.com">click</a>')).toContain('[click](https://x.com)');
  });

  it('drops javascript: links but keeps text', () => {
    expect(htmlToMarkdown('<a href="javascript:evil()">text</a>')).toBe('text');
  });

  it('converts emphasis and list items', () => {
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
    expect(htmlToMarkdown('<em>it</em>')).toBe('*it*');
    const list = htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(list).toContain('- one');
    expect(list).toContain('- two');
  });

  it('preserves preformatted code', () => {
    const md = htmlToMarkdown('<pre>line1\nline2</pre>');
    expect(md).toContain('```');
    expect(md).toContain('line1\nline2');
  });

  it('collapses excessive blank lines', () => {
    const md = htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>');
    expect(md).not.toMatch(/\n{3,}/);
  });
});
