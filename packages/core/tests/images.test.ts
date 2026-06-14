import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveImage, resolveImages } from '../src/images.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
const PNG_B64 = PNG_BYTES.toString('base64');

describe('resolveImage', () => {
  it('passes through an already-base64 ImageContent', async () => {
    const img = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    expect(await resolveImage(img)).toBe(img);
  });

  it('parses a base64 data: URI', async () => {
    const out = await resolveImage(`data:image/jpeg;base64,${PNG_B64}`);
    expect(out).toEqual({ type: 'image', mimeType: 'image/jpeg', data: PNG_B64 });
  });

  it('rejects a non-base64 data: URI', async () => {
    await expect(resolveImage('data:image/png,notbase64')).rejects.toThrow(/base64/i);
  });

  it('reads a local file path and infers mime from the extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnext-img-'));
    try {
      const p = join(dir, 'pic.jpeg');
      writeFileSync(p, PNG_BYTES);
      const out = await resolveImage(p);
      expect(out).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/jpeg' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors an explicit mimeType hint over inference', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnext-img-'));
    try {
      const p = join(dir, 'noext');
      writeFileSync(p, PNG_BYTES);
      const out = await resolveImage({ url: p, mimeType: 'image/webp' });
      expect(out.mimeType).toBe('image/webp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveImage over http(s)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fakeResponse(bytes: Buffer, contentType: string, ok = true, status = 200): Response {
    return {
      ok,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }

  it('fetches a URL and uses the content-type header for the mime', async () => {
    globalThis.fetch = vi.fn(async () => fakeResponse(PNG_BYTES, 'image/png; charset=binary')) as never;
    const out = await resolveImage('https://example.com/cat.bin');
    expect(out).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' });
  });

  it('falls back to the URL extension when content-type is not an image', async () => {
    globalThis.fetch = vi.fn(async () => fakeResponse(PNG_BYTES, 'application/octet-stream')) as never;
    const out = await resolveImage('https://example.com/photo.webp');
    expect(out.mimeType).toBe('image/webp');
  });

  it('throws on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => fakeResponse(Buffer.alloc(0), 'image/png', false, 404)) as never;
    await expect(resolveImage('https://example.com/missing.png')).rejects.toThrow(/404/);
  });
});

describe('resolveImages', () => {
  it('resolves a mix of base64 + data-URI in order', async () => {
    const base64 = { type: 'image' as const, data: 'ZZZZ', mimeType: 'image/png' };
    const out = await resolveImages([base64, `data:image/gif;base64,${PNG_B64}`]);
    expect(out).toEqual([base64, { type: 'image', mimeType: 'image/gif', data: PNG_B64 }]);
  });
});
