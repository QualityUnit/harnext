import { describe, expect, it } from 'vitest';

import {
  createWebSearchTool,
  filterByDomains,
  formatResults,
  NO_BACKEND_MESSAGE,
  parseBrave,
  parseSearxng,
  parseSerper,
  parseTavily,
  selectBackend,
  type SearchResult,
} from '../src/tools/web-search.js';

describe('selectBackend', () => {
  it('returns undefined when nothing is configured', () => {
    expect(selectBackend({})).toBeUndefined();
  });

  it('prefers tavily, then searxng, then serper, then brave', () => {
    expect(selectBackend({ BRAVE_API_KEY: 'b', SERPER_API_KEY: 's', TAVILY_API_KEY: 't' })?.kind).toBe(
      'tavily',
    );
    expect(selectBackend({ BRAVE_API_KEY: 'b', SEARXNG_URL: 'http://s' })?.kind).toBe('searxng');
    expect(selectBackend({ BRAVE_API_KEY: 'b', SERPER_API_KEY: 's' })?.kind).toBe('serper');
    expect(selectBackend({ BRAVE_API_KEY: 'b' })?.kind).toBe('brave');
  });

  it('honors HARNEXT_SEARCH_BACKEND override', () => {
    const env = { TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b', HARNEXT_SEARCH_BACKEND: 'brave' };
    expect(selectBackend(env)?.kind).toBe('brave');
  });

  it('returns undefined when the forced backend is unconfigured', () => {
    expect(selectBackend({ TAVILY_API_KEY: 't', HARNEXT_SEARCH_BACKEND: 'brave' })).toBeUndefined();
  });
});

describe('result parsers', () => {
  it('parses tavily', () => {
    const r = parseTavily({ results: [{ title: 'T', url: 'https://a.com', content: 'snip' }] });
    expect(r).toEqual([{ title: 'T', url: 'https://a.com', snippet: 'snip' }]);
  });
  it('parses searxng', () => {
    const r = parseSearxng({ results: [{ title: 'T', url: 'https://a.com', content: 'snip' }] });
    expect(r[0].url).toBe('https://a.com');
  });
  it('parses serper organic with link field', () => {
    const r = parseSerper({ organic: [{ title: 'T', link: 'https://a.com', snippet: 'snip' }] });
    expect(r[0].url).toBe('https://a.com');
  });
  it('parses brave nested web.results', () => {
    const r = parseBrave({ web: { results: [{ title: 'T', url: 'https://a.com', description: 'd' }] } });
    expect(r[0].snippet).toBe('d');
  });
  it('tolerates missing/garbage shapes', () => {
    expect(parseTavily({})).toEqual([]);
    expect(parseSerper(null)).toEqual([]);
    expect(parseBrave({ web: {} })).toEqual([]);
  });
});

describe('filterByDomains', () => {
  const results: SearchResult[] = [
    { title: 'a', url: 'https://docs.example.com/x', snippet: '' },
    { title: 'b', url: 'https://evil.test/y', snippet: '' },
    { title: 'c', url: 'not-a-url', snippet: '' },
  ];

  it('keeps only allowed domains (subdomain match)', () => {
    const r = filterByDomains(results, ['example.com']);
    expect(r.map((x) => x.title)).toEqual(['a']);
  });

  it('removes blocked domains', () => {
    const r = filterByDomains(results, undefined, ['evil.test']);
    expect(r.map((x) => x.title)).toEqual(['a']);
  });

  it('drops unparseable urls', () => {
    const r = filterByDomains(results);
    expect(r.map((x) => x.title)).toEqual(['a', 'b']);
  });
});

describe('formatResults', () => {
  it('formats a numbered list', () => {
    const text = formatResults('q', [{ title: 'T', url: 'https://a.com', snippet: 'snip' }]);
    expect(text).toContain('1. T');
    expect(text).toContain('https://a.com');
    expect(text).toContain('snip');
  });
  it('handles empty results', () => {
    expect(formatResults('q', [])).toContain('No results');
  });
});

describe('web_search tool', () => {
  it('returns the setup message when no backend is configured', async () => {
    const tool = createWebSearchTool({ env: {} });
    const res = await tool.execute('id', { query: 'hi' });
    expect(res.content[0].text).toBe(NO_BACKEND_MESSAGE);
    expect(res.details.error).toBe('no backend configured');
  });

  it('errors on empty query', async () => {
    const tool = createWebSearchTool({ env: { TAVILY_API_KEY: 't' } });
    const res = await tool.execute('id', { query: '   ' });
    expect(res.details.error).toBe('empty query');
  });

  it('runs the selected backend and formats results', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ results: [{ title: 'Doc', url: 'https://docs.example.com', content: 'hi' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const tool = createWebSearchTool({ env: { TAVILY_API_KEY: 't' }, fetchImpl });
    const res = await tool.execute('id', { query: 'docs' });
    expect(res.details.backend).toBe('tavily');
    expect(res.details.resultCount).toBe(1);
    expect(res.content[0].text).toContain('https://docs.example.com');
  });

  it('applies allowed_domains filtering to results', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'Keep', url: 'https://docs.example.com', content: '' },
            { title: 'Drop', url: 'https://other.test', content: '' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const tool = createWebSearchTool({ env: { TAVILY_API_KEY: 't' }, fetchImpl });
    const res = await tool.execute('id', { query: 'q', allowed_domains: ['example.com'] });
    expect(res.details.resultCount).toBe(1);
    expect(res.content[0].text).toContain('Keep');
    expect(res.content[0].text).not.toContain('Drop');
  });

  it('reports backend HTTP errors', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const tool = createWebSearchTool({ env: { TAVILY_API_KEY: 't' }, fetchImpl });
    const res = await tool.execute('id', { query: 'q' });
    expect(res.details.error).toContain('401');
  });
});
