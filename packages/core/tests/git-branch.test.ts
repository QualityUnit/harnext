import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAndSwitchBranch, getCurrentGitBranch } from '../src/git-branch.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('git-branch helpers', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-git-branch-'));
    git(cwd, ['init', '-q', '-b', 'main']);
    git(cwd, ['commit', '-q', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns the current branch name', () => {
    expect(getCurrentGitBranch(cwd)).toBe('main');
  });

  it('returns null outside of a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'harnext-not-repo-'));
    try {
      expect(getCurrentGitBranch(notRepo)).toBeNull();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('creates and switches to a new branch', () => {
    const result = createAndSwitchBranch(cwd, 'feat/setup-harnext');
    expect(result.ok).toBe(true);
    expect(getCurrentGitBranch(cwd)).toBe('feat/setup-harnext');
  });

  it('fails when the branch already exists', () => {
    expect(createAndSwitchBranch(cwd, 'feat/setup-harnext').ok).toBe(true);
    git(cwd, ['checkout', '-q', 'main']);

    const result = createAndSwitchBranch(cwd, 'feat/setup-harnext');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/already exists/i);
    }
    expect(getCurrentGitBranch(cwd)).toBe('main');
  });
});
