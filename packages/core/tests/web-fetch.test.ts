import { describe, expect, it } from 'vitest';

import { createWebFetchTool } from '../src/tools/web-fetch.js';

const publicResolver = async () => ['93.184.216.34'];

/** Build a fetch mock from a url→Response factory map. */
function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

function tool(routes: Record<string, () => Response>) {
  return createWebFetchTool({ fetchImpl: mockFetch(routes), resolver: publicResolver });
}

describe('web_fetch SSRF', () => {
  it('blocks localhost before any fetch', async () => {
    const t = createWebFetchTool({
      fetchImpl: (async () => {
        throw new Error('should not be called');
      }) as unknown as typeof fetch,
      resolver: publicResolver,
    });
    const res = await t.execute('id', { url: 'http://localhost:8080/' });
    expect(res.content[0].text).toMatch(/^Blocked/);
    expect(res.details.error).toBeDefined();
  });

  it('blocks the cloud metadata IP', async () => {
    const t = createWebFetchTool({ resolver: publicResolver });
    const res = await t.execute('id', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(res.content[0].text).toMatch(/^Blocked/);
  });

  it('rejects unsupported schemes', async () => {
    const t = createWebFetchTool({ resolver: publicResolver });
    const res = await t.execute('id', { url: 'file:///etc/passwd' });
    expect(res.content[0].text).toMatch(/^Blocked/);
  });
});

describe('web_fetch content handling', () => {
  it('converts HTML to markdown and includes the title', async () => {
    const t = tool({
      'https://example.com/': () =>
        new Response('<html><head><title>Hi</title></head><body><h1>Heading</h1><p>Body</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const res = await t.execute('id', { url: 'https://example.com/' });
    expect(res.content[0].text).toContain('Title: Hi');
    expect(res.content[0].text).toContain('# Heading');
    expect(res.content[0].text).toContain('Body');
    expect(res.details.title).toBe('Hi');
  });

  it('passes through plain text', async () => {
    const t = tool({
      'https://example.com/robots.txt': () =>
        new Response('User-agent: *\nDisallow:', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    });
    const res = await t.execute('id', { url: 'https://example.com/robots.txt' });
    expect(res.content[0].text).toContain('User-agent: *');
  });

  it('does not render binary content', async () => {
    const t = tool({
      'https://example.com/img.png': () =>
        new Response('\x89PNG', { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    const res = await t.execute('id', { url: 'https://example.com/img.png' });
    expect(res.content[0].text).toContain('non-text content');
  });

  it('truncates very large pages', async () => {
    const big = '<p>' + 'x'.repeat(400 * 1024) + '</p>';
    const t = tool({
      'https://example.com/big': () =>
        new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const res = await t.execute('id', { url: 'https://example.com/big' });
    expect(res.details.truncated).toBe(true);
    expect(res.content[0].text).toContain('truncated');
  });

  it('reports HTTP error status', async () => {
    const t = tool({
      'https://example.com/missing': () => new Response('nope', { status: 404 }),
    });
    const res = await t.execute('id', { url: 'https://example.com/missing' });
    expect(res.content[0].text).toContain('HTTP 404');
    expect(res.details.status).toBe(404);
  });

  it('echoes the extraction prompt in the header', async () => {
    const t = tool({
      'https://example.com/': () =>
        new Response('<p>content</p>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const res = await t.execute('id', { url: 'https://example.com/', prompt: 'find the pricing' });
    expect(res.content[0].text).toContain('Requested: find the pricing');
  });
});

describe('web_fetch redirects', () => {
  it('follows same-host redirects', async () => {
    const t = tool({
      'https://example.com/a': () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/b' } }),
      'https://example.com/b': () =>
        new Response('<p>final</p>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    const res = await t.execute('id', { url: 'https://example.com/a' });
    expect(res.content[0].text).toContain('final');
    expect(res.details.finalUrl).toBe('https://example.com/b');
  });

  it('does not follow cross-host redirects, returns the new URL', async () => {
    const t = tool({
      'https://example.com/a': () =>
        new Response(null, { status: 302, headers: { location: 'https://other.com/x' } }),
    });
    const res = await t.execute('id', { url: 'https://example.com/a' });
    expect(res.content[0].text).toContain('different host');
    expect(res.details.finalUrl).toBe('https://other.com/x');
  });
});
