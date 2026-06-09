import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSettingSource,
  loadProjectContext,
  resolveContextFiles,
} from '../src/project-context.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'harnext-proj-ctx-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('isSettingSource', () => {
  it('accepts known sources only', () => {
    expect(isSettingSource('project')).toBe(true);
    expect(isSettingSource('user')).toBe(true);
    expect(isSettingSource('local')).toBe(true);
    expect(isSettingSource('nope')).toBe(false);
  });
});

describe('resolveContextFiles', () => {
  it('returns nothing when no sources are selected', () => {
    expect(resolveContextFiles({ cwd })).toEqual([]);
    expect(resolveContextFiles({ cwd, settingSources: [] })).toEqual([]);
  });

  it('includes project CLAUDE.md paths for project/local', () => {
    const files = resolveContextFiles({ cwd, settingSources: ['project'] });
    expect(files).toContain(join(cwd, 'CLAUDE.md'));
    expect(files).toContain(join(cwd, '.claude', 'CLAUDE.md'));
  });
});

describe('loadProjectContext', () => {
  it('returns empty string when project opted in but no file exists', () => {
    expect(loadProjectContext({ cwd, settingSources: ['project'] })).toBe('');
  });

  it('loads ./CLAUDE.md when project source is selected', () => {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# House rules\nBe terse.');
    const ctx = loadProjectContext({ cwd, settingSources: ['project'] });
    expect(ctx).toContain('Be terse.');
    expect(ctx).toContain('Project context');
  });

  it('does not load project context when no source is selected', () => {
    writeFileSync(join(cwd, 'CLAUDE.md'), 'should be ignored');
    expect(loadProjectContext({ cwd })).toBe('');
  });

  it('loads .claude/CLAUDE.md too', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'CLAUDE.md'), 'nested memory');
    const ctx = loadProjectContext({ cwd, settingSources: ['project'] });
    expect(ctx).toContain('nested memory');
  });
});
