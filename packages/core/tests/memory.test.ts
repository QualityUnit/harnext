import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProjectMemoryDir, getProjectStateDir } from '../src/config.js';
import {
  MEMORY_INDEX_MAX_LINES,
  buildMemorySection,
  loadMemoryIndex,
  memoryIndexPath,
  truncateHead,
} from '../src/memory.js';

describe('getProjectMemoryDir', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-mem-home-'));
    process.env.HARNEXT_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('resolves under the per-project state dir (machine state, not the repo)', () => {
    const cwd = '/some/project/path';
    expect(getProjectMemoryDir(cwd)).toBe(join(getProjectStateDir(cwd), 'memory'));
    expect(getProjectMemoryDir(cwd).startsWith(home)).toBe(true);
  });

  it('gives different working directories different memory dirs', () => {
    expect(getProjectMemoryDir('/project/a')).not.toBe(getProjectMemoryDir('/project/b'));
  });
});

describe('truncateHead', () => {
  it('keeps the head of over-long text', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { content, truncated } = truncateHead(text, 10, 1024 * 1024);
    expect(truncated).toBe(true);
    expect(content.split('\n')).toHaveLength(10);
    expect(content.startsWith('line 0')).toBe(true);
  });

  it('leaves short text untouched', () => {
    const { content, truncated } = truncateHead('a\nb\nc');
    expect(truncated).toBe(false);
    expect(content).toBe('a\nb\nc');
  });
});

describe('loadMemoryIndex / buildMemorySection', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;
  const cwd = '/memory/test/project';

  function writeIndex(body: string) {
    const dir = getProjectMemoryDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(memoryIndexPath(cwd), body);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-mem-idx-'));
    process.env.HARNEXT_HOME = home;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns empty when no index file exists', () => {
    expect(loadMemoryIndex(cwd)).toBe('');
  });

  it('returns the index content when present', () => {
    writeIndex('- [Indent](indent.md) — 2 spaces, ESM-only');
    expect(loadMemoryIndex(cwd)).toContain('2 spaces, ESM-only');
  });

  it('head-truncates an oversized index and flags it', () => {
    const big = Array.from({ length: MEMORY_INDEX_MAX_LINES + 50 }, (_, i) => `- entry ${i}`).join(
      '\n',
    );
    writeIndex(big);
    const loaded = loadMemoryIndex(cwd);
    expect(loaded).toContain('index truncated');
    expect(loaded).toContain('entry 0');
    expect(loaded).not.toContain(`entry ${MEMORY_INDEX_MAX_LINES + 49}`);
  });

  it('buildMemorySection embeds the protocol and an empty-memory note when blank', () => {
    const section = buildMemorySection(cwd);
    expect(section).toContain('# Memory');
    expect(section).toContain(getProjectMemoryDir(cwd));
    expect(section).toContain('Memory is currently empty');
  });

  it('buildMemorySection embeds the current index when present', () => {
    writeIndex('- [Indent](indent.md) — 2 spaces');
    const section = buildMemorySection(cwd);
    expect(section).toContain('Current memory index');
    expect(section).toContain('2 spaces');
  });
});
