import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPathCompleter, listRepoPaths, rankPaths } from '../src/cli/file-search.js';

/**
 * `rankPaths` powers the `@`-mention picker: a case-insensitive substring
 * filter that ranks basename-prefix matches above basename-substring above
 * dir-only matches, breaking ties by shorter path. `listRepoPaths` enumerates
 * files + derived directory entries (dirs marked with a trailing '/').
 */
describe('rankPaths', () => {
  const entries = [
    'src/cli/input.ts',
    'src/cli/file-search.ts',
    'src/cli/',
    'packages/input-helpers/index.ts',
    'README.md',
  ];

  it('ranks basename-prefix above basename-substring above dir-only match', () => {
    const out = rankPaths(entries, 'input').map((m) => m.text);
    // basename "input.ts" prefix-matches; "index.ts" lives under a dir whose
    // name contains "input" (dir-only match) so it ranks last.
    expect(out[0]).toBe('src/cli/input.ts');
    expect(out).toContain('packages/input-helpers/index.ts');
    expect(out.indexOf('src/cli/input.ts')).toBeLessThan(
      out.indexOf('packages/input-helpers/index.ts'),
    );
  });

  it('is case-insensitive', () => {
    expect(rankPaths(entries, 'INPUT').map((m) => m.text)).toContain('src/cli/input.ts');
    expect(rankPaths(entries, 'readme').map((m) => m.text)).toContain('README.md');
  });

  it('breaks ties by shorter path', () => {
    const out = rankPaths(['a/file.ts', 'a/b/c/file.ts'], 'file').map((m) => m.text);
    expect(out[0]).toBe('a/file.ts');
  });

  it('marks directories with hint "dir"', () => {
    const dir = rankPaths(entries, 'cli').find((m) => m.text === 'src/cli/');
    expect(dir?.hint).toBe('dir');
    const file = rankPaths(entries, 'input.ts').find((m) => m.text === 'src/cli/input.ts');
    expect(file?.hint).toBeUndefined();
  });

  it('returns nothing for a non-matching query', () => {
    expect(rankPaths(entries, 'zzzznope')).toEqual([]);
  });

  it('respects the result limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => `dir/file${i}.ts`);
    expect(rankPaths(many, 'file', 8)).toHaveLength(8);
  });
});

describe('listRepoPaths / createPathCompleter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-filesearch-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists files and derived directory entries (git repo)', () => {
    mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
    writeFileSync(join(dir, 'src', 'cli', 'input.ts'), 'x');
    writeFileSync(join(dir, 'README.md'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });

    const paths = listRepoPaths(dir);
    expect(paths).toContain('src/cli/input.ts');
    expect(paths).toContain('README.md');
    // Directory entries derived from file prefixes, trailing-slashed.
    expect(paths).toContain('src/');
    expect(paths).toContain('src/cli/');
  });

  it('falls back to a filesystem walk for a non-git directory', () => {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'a.ts'), 'x');
    const paths = listRepoPaths(dir);
    expect(paths).toContain('lib/a.ts');
    expect(paths).toContain('lib/');
  });

  it('skips ignored directories in the walk fallback', () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(dir, 'keep.ts'), 'x');
    const paths = listRepoPaths(dir);
    expect(paths).toContain('keep.ts');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('createPathCompleter returns ranked matches and never throws', () => {
    writeFileSync(join(dir, 'alpha.ts'), 'x');
    const complete = createPathCompleter(dir);
    expect(complete('alpha').map((m) => m.text)).toContain('alpha.ts');
    // A nonexistent cwd must resolve to [] rather than throwing.
    const broken = createPathCompleter(join(dir, 'does-not-exist'));
    expect(broken('x')).toEqual([]);
  });
});
