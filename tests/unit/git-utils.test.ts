import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getCurrentBranch,
  getHeadSha,
  hasUncommittedChanges,
  snapshotUntrackedFiles,
  snapshotModifiedFiles,
  diffWorkingTree,
} from '../../src/utils/git.js';

const execAsync = promisify(exec);

describe('git utility functions', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'codefactory-git-test-'));
    await execAsync('git init', { cwd: repoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
    await execAsync('git config user.name "Test"', { cwd: repoDir });
    // Create initial commit so HEAD exists
    await execAsync('git commit --allow-empty -m "initial"', { cwd: repoDir });
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('getCurrentBranch', () => {
    it('should return the current branch name', async () => {
      const branch = await getCurrentBranch(repoDir);
      // Default branch is typically 'main' or 'master'
      expect(typeof branch).toBe('string');
      expect(branch.length).toBeGreaterThan(0);
    });

    it('should detect a newly created branch', async () => {
      await execAsync('git checkout -b test-branch', { cwd: repoDir });
      const branch = await getCurrentBranch(repoDir);
      expect(branch).toBe('test-branch');
    });
  });

  describe('getHeadSha', () => {
    it('should return a 40-character hex SHA', async () => {
      const sha = await getHeadSha(repoDir);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  describe('hasUncommittedChanges', () => {
    it('should return false for clean repo', async () => {
      const result = await hasUncommittedChanges(repoDir);
      expect(result).toBe(false);
    });

    it('should return true when there are untracked files', async () => {
      await execAsync('touch newfile.txt', { cwd: repoDir });
      const result = await hasUncommittedChanges(repoDir);
      expect(result).toBe(true);
    });

    it('should return true when there are staged changes', async () => {
      await execAsync('touch staged.txt && git add staged.txt', { cwd: repoDir });
      const result = await hasUncommittedChanges(repoDir);
      expect(result).toBe(true);
    });
  });

  describe('snapshotUntrackedFiles', () => {
    it('should return empty set for clean repo', () => {
      const result = snapshotUntrackedFiles(repoDir);
      expect(result.size).toBe(0);
    });

    it('should detect untracked files', async () => {
      await execAsync('touch newfile.txt', { cwd: repoDir });
      const result = snapshotUntrackedFiles(repoDir);
      expect(result.has('newfile.txt')).toBe(true);
    });

    it('should not include tracked files', async () => {
      await execAsync('touch tracked.txt && git add tracked.txt && git commit -m "add"', {
        cwd: repoDir,
      });
      const result = snapshotUntrackedFiles(repoDir);
      expect(result.has('tracked.txt')).toBe(false);
    });
  });

  describe('snapshotModifiedFiles', () => {
    it('should return empty set for clean repo', () => {
      const result = snapshotModifiedFiles(repoDir);
      expect(result.size).toBe(0);
    });

    it('should detect modified tracked files', async () => {
      await execAsync(
        'echo "original" > tracked.txt && git add tracked.txt && git commit -m "add"',
        { cwd: repoDir },
      );
      await execAsync('echo "changed" > tracked.txt', { cwd: repoDir });
      const result = snapshotModifiedFiles(repoDir);
      expect(result.has('tracked.txt')).toBe(true);
    });

    it('should return empty set for repo with no commits', async () => {
      const freshRepo = await mkdtemp(join(tmpdir(), 'codefactory-no-head-mod-'));
      await execAsync('git init', { cwd: freshRepo });

      try {
        const result = snapshotModifiedFiles(freshRepo);
        expect(result.size).toBe(0);
      } finally {
        await rm(freshRepo, { recursive: true, force: true });
      }
    });
  });

  describe('diffWorkingTree', () => {
    it('should detect newly created files', async () => {
      const before = snapshotUntrackedFiles(repoDir);
      await execAsync('touch brand-new.txt', { cwd: repoDir });
      const { created, modified } = diffWorkingTree(before, repoDir);
      expect(created).toContain('brand-new.txt');
      expect(modified).toEqual([]);
    });

    it('should detect modified tracked files', async () => {
      await execAsync(
        'echo "original" > tracked.txt && git add tracked.txt && git commit -m "add"',
        { cwd: repoDir },
      );
      const before = snapshotUntrackedFiles(repoDir);
      await execAsync('echo "changed" > tracked.txt', { cwd: repoDir });
      const { created, modified } = diffWorkingTree(before, repoDir);
      expect(modified).toContain('tracked.txt');
      expect(created).toEqual([]);
    });

    it('should detect staged modifications', async () => {
      await execAsync('echo "original" > staged.txt && git add staged.txt && git commit -m "add"', {
        cwd: repoDir,
      });
      const before = snapshotUntrackedFiles(repoDir);
      await execAsync('echo "changed" > staged.txt && git add staged.txt', { cwd: repoDir });
      const { modified } = diffWorkingTree(before, repoDir);
      expect(modified).toContain('staged.txt');
    });

    it('should return empty lists for clean repo', () => {
      const before = snapshotUntrackedFiles(repoDir);
      const { created, modified } = diffWorkingTree(before, repoDir);
      expect(created).toEqual([]);
      expect(modified).toEqual([]);
    });

    it('should filter pre-existing modifications when beforeModified is provided', async () => {
      // Create two tracked files
      await execAsync(
        'echo "a" > pre-existing.txt && echo "b" > new-change.txt && git add . && git commit -m "add"',
        { cwd: repoDir },
      );
      // Modify both files before "CLI run"
      await execAsync('echo "changed-a" > pre-existing.txt', { cwd: repoDir });
      const beforeModified = snapshotModifiedFiles(repoDir);
      const beforeUntracked = snapshotUntrackedFiles(repoDir);

      // Simulate CLI modifying only new-change.txt (both are now modified in git diff)
      await execAsync('echo "changed-b" > new-change.txt', { cwd: repoDir });

      const { modified } = diffWorkingTree(beforeUntracked, repoDir, beforeModified);
      expect(modified).toContain('new-change.txt');
      expect(modified).not.toContain('pre-existing.txt');
    });

    it('should handle repo with no commits (no HEAD)', async () => {
      // Create a fresh repo without any commits
      const freshRepo = await mkdtemp(join(tmpdir(), 'codefactory-no-head-'));
      await execAsync('git init', { cwd: freshRepo });
      await execAsync('git config user.email "test@test.com"', { cwd: freshRepo });
      await execAsync('git config user.name "Test"', { cwd: freshRepo });

      try {
        const before = snapshotUntrackedFiles(freshRepo);
        await execAsync('touch newfile.txt', { cwd: freshRepo });
        const { created, modified } = diffWorkingTree(before, freshRepo);
        expect(created).toContain('newfile.txt');
        expect(modified).toEqual([]);
      } finally {
        await rm(freshRepo, { recursive: true, force: true });
      }
    });
  });
});
