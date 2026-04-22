import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAgentDir } from '../src/config.js';
import {
  computeServerConfigHash,
  deleteMcpCacheEntry,
  isServerCacheValid,
  loadMcpCache,
  saveMcpCache,
} from '../src/mcp-cache.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-mcp-cache-'));
  process.env.HARNEXT_HOME = harnextHome;
});
afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(getAgentDir(), { recursive: true, force: true });
});

describe('computeServerConfigHash', () => {
  it('is stable across equal configs', () => {
    expect(
      computeServerConfigHash({ command: 'npx', args: ['a', 'b'], env: { X: '1' } }),
    ).toBe(computeServerConfigHash({ command: 'npx', args: ['a', 'b'], env: { X: '1' } }));
  });
  it('ignores runtime-only fields', () => {
    const a = computeServerConfigHash({ command: 'npx', args: ['a'] });
    const b = computeServerConfigHash({ command: 'npx', args: ['a'], lifecycle: 'eager', idleTimeout: 30, debug: true });
    expect(a).toBe(b);
  });
  it('changes when identity fields change', () => {
    const a = computeServerConfigHash({ command: 'npx', args: ['a'] });
    const b = computeServerConfigHash({ command: 'npx', args: ['a', 'b'] });
    expect(a).not.toBe(b);
  });
});

describe('loadMcpCache / saveMcpCache', () => {
  it('returns empty cache when missing', () => {
    const cache = loadMcpCache();
    expect(cache).toEqual({ version: 1, servers: {} });
  });
  it('round-trips and merges patches', () => {
    saveMcpCache({
      servers: {
        a: { configHash: 'h1', cachedAt: 1, tools: [{ name: 't' }] },
      },
    });
    saveMcpCache({
      servers: {
        b: { configHash: 'h2', cachedAt: 2, tools: [] },
      },
    });
    const cache = loadMcpCache();
    expect(cache.servers.a.configHash).toBe('h1');
    expect(cache.servers.b.configHash).toBe('h2');
  });
});

describe('deleteMcpCacheEntry', () => {
  it('removes one server without affecting others', () => {
    saveMcpCache({
      servers: {
        a: { configHash: 'ha', cachedAt: 1, tools: [] },
        b: { configHash: 'hb', cachedAt: 1, tools: [] },
      },
    });
    deleteMcpCacheEntry('a');
    const cache = loadMcpCache();
    expect(cache.servers.a).toBeUndefined();
    expect(cache.servers.b).toBeDefined();
  });
});

describe('isServerCacheValid', () => {
  it('valid when hash matches and fresh', () => {
    const cfg = { command: 'x' };
    const hash = computeServerConfigHash(cfg);
    expect(
      isServerCacheValid({ configHash: hash, cachedAt: Date.now(), tools: [] }, cfg),
    ).toBe(true);
  });
  it('invalid when hash differs', () => {
    const cfg = { command: 'x' };
    expect(
      isServerCacheValid({ configHash: 'other', cachedAt: Date.now(), tools: [] }, cfg),
    ).toBe(false);
  });
  it('invalid when too old', () => {
    const cfg = { command: 'x' };
    const hash = computeServerConfigHash(cfg);
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    expect(
      isServerCacheValid({ configHash: hash, cachedAt: weekAgo, tools: [] }, cfg),
    ).toBe(false);
  });
});
