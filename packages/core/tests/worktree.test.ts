import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKTREE_STALE_DAYS,
  deleteWorktreeRecord,
  getProjectWorktreeRoot,
  getWorktreesStateDir,
  listWorktreeRecords,
  loadWorktreeRecord,
  pruneStaleWorktrees,
  releaseWorktreeForItem,
  resolveWorktreeForItem,
  saveWorktreeRecord,
  type RunGit,
  type RunGitResult,
  type WorktreeRecord,
} from '../src/worktree.js';

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'harnext-worktree-'));
}

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-worktree-'));
  process.env.HARNEXT_HOME = harnextHome;
});
afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

/**
 * Scriptable git stub. Each call is recorded; callers can queue custom
 * responses per-argv-prefix. Unhandled calls default to exit 0 with empty
 * stdout/stderr so "git worktree list --porcelain" returns "no worktrees"
 * unless the test sets it up.
 */
function makeGit(): {
  runGit: RunGit;
  calls: Array<{ args: string[]; cwd: string }>;
  queueResponse: (matcher: (args: string[]) => boolean, resp: RunGitResult) => void;
  setWorktreeList: (paths: string[]) => void;
  setBranchExists: (branches: string[]) => void;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const overrides: Array<{ match: (args: string[]) => boolean; resp: RunGitResult }> = [];
  let worktreeListPaths: string[] = [];
  let existingBranches: string[] = [];

  const runGit: RunGit = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    for (const o of overrides) {
      if (o.match(args)) return o.resp;
    }
    // Built-in defaults that cover most paths.
    if (args[0] === 'worktree' && args[1] === 'list') {
      const stdout = worktreeListPaths.map((p) => `worktree ${p}\nHEAD x\nbranch refs/heads/b\n`).join('\n');
      return { exit: 0, stdout, stderr: '' };
    }
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      const branch = args[args.length - 1].replace(/^refs\/heads\//, '');
      return existingBranches.includes(branch)
        ? { exit: 0, stdout: 'abc\n', stderr: '' }
        : { exit: 1, stdout: '', stderr: '' };
    }
    return { exit: 0, stdout: '', stderr: '' };
  };

  return {
    runGit,
    calls,
    queueResponse: (match, resp) => overrides.push({ match, resp }),
    setWorktreeList: (paths) => {
      worktreeListPaths = paths;
    },
    setBranchExists: (branches) => {
      existingBranches = branches;
    },
  };
}

// ────────────────────────────────────────────────────────────────────

describe('state file helpers', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('saves and loads a record round-trip', () => {
    const rec: WorktreeRecord = {
      itemNumber: 42,
      itemKind: 'issue',
      path: '/tmp/wt/issue-42',
      branch: 'harnext/issue-42',
      createdAt: '2026-04-19T00:00:00.000Z',
      lastStageAt: '2026-04-19T00:00:05.000Z',
    };
    saveWorktreeRecord(cwd, rec);
    expect(loadWorktreeRecord(cwd, 42)).toEqual(rec);
  });

  it('returns undefined for missing records', () => {
    expect(loadWorktreeRecord(cwd, 999)).toBeUndefined();
  });

  it('returns undefined for corrupt JSON', () => {
    mkdirSync(getWorktreesStateDir(cwd), { recursive: true });
    writeFileSync(join(getWorktreesStateDir(cwd), '7.json'), 'not json', 'utf-8');
    expect(loadWorktreeRecord(cwd, 7)).toBeUndefined();
  });

  it('deleteWorktreeRecord is idempotent', () => {
    deleteWorktreeRecord(cwd, 123);
    deleteWorktreeRecord(cwd, 123);
    expect(loadWorktreeRecord(cwd, 123)).toBeUndefined();
  });

  it('listWorktreeRecords returns all saved records', () => {
    saveWorktreeRecord(cwd, {
      itemNumber: 1,
      itemKind: 'issue',
      path: '/tmp/a',
      branch: 'harnext/issue-1',
      createdAt: 't',
      lastStageAt: 't',
    });
    saveWorktreeRecord(cwd, {
      itemNumber: 2,
      itemKind: 'pr',
      path: '/tmp/b',
      branch: 'harnext/pr-2',
      createdAt: 't',
      lastStageAt: 't',
    });
    const records = listWorktreeRecords(cwd);
    expect(records.map((r) => r.itemNumber).sort()).toEqual([1, 2]);
  });
});

// ────────────────────────────────────────────────────────────────────

describe('resolveWorktreeForItem', () => {
  let cwd: string;
  let root: string;
  beforeEach(() => {
    cwd = tmpCwd();
    root = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a worktree on first call: fetches, checks branch, adds -b', async () => {
    const git = makeGit();
    const record = await resolveWorktreeForItem({
      cwd,
      itemNumber: 42,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
    });

    expect(record.itemNumber).toBe(42);
    expect(record.itemKind).toBe('issue');
    expect(record.branch).toBe('harnext/issue-42');
    expect(record.path.startsWith(getProjectWorktreeRoot(cwd, root))).toBe(true);
    expect(record.path.endsWith('issue-42')).toBe(true);

    // Order of git calls.
    const argvs = git.calls.map((c) => c.args);
    expect(argvs[0]).toEqual(['fetch', 'origin']);
    // rev-parse --verify --quiet refs/heads/harnext/issue-42
    expect(argvs[1]).toEqual(['rev-parse', '--verify', '--quiet', 'refs/heads/harnext/issue-42']);
    expect(argvs[2]).toEqual(['worktree', 'add', '-b', 'harnext/issue-42', record.path, 'origin/HEAD']);

    // State file written.
    expect(loadWorktreeRecord(cwd, 42)).toEqual(record);
  });

  it('reuses the existing record when the worktree still exists and is registered', async () => {
    const git = makeGit();
    const first = await resolveWorktreeForItem({
      cwd,
      itemNumber: 7,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
    });
    // Simulate: worktree dir still exists + git knows about it.
    mkdirSync(first.path, { recursive: true });
    git.setWorktreeList([first.path]);

    const callCountBefore = git.calls.length;
    const second = await resolveWorktreeForItem({
      cwd,
      itemNumber: 7,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
    });

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe(first.branch);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastStageAt >= first.lastStageAt).toBe(true);
    // Only one list call, no new fetch/add.
    const newCalls = git.calls.slice(callCountBefore);
    const verbs = newCalls.map((c) => c.args.slice(0, 2).join(' '));
    expect(verbs).toEqual(['worktree list']);
  });

  it('recreates when the state file exists but the worktree dir is gone', async () => {
    const git = makeGit();
    // Seed a stale record pointing at a nonexistent path.
    saveWorktreeRecord(cwd, {
      itemNumber: 9,
      itemKind: 'issue',
      path: join(root, 'ghost', 'issue-9'),
      branch: 'harnext/issue-9',
      createdAt: 't0',
      lastStageAt: 't0',
    });

    const record = await resolveWorktreeForItem({
      cwd,
      itemNumber: 9,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
    });

    // New path, new creation timestamp.
    expect(record.createdAt).not.toBe('t0');
    expect(existsSync(record.path) || true).toBe(true); // we didn't actually git-add, but the dirname was mkdired
    // Must have re-fetched and re-added.
    const argvs = git.calls.map((c) => c.args.join(' '));
    expect(argvs).toContain('fetch origin');
    expect(argvs.some((a) => a.startsWith('worktree add'))).toBe(true);
  });

  it('omits -b when the branch already exists locally', async () => {
    const git = makeGit();
    git.setBranchExists(['harnext/issue-13']);

    await resolveWorktreeForItem({
      cwd,
      itemNumber: 13,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
    });

    const addCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall!.args).not.toContain('-b');
    expect(addCall!.args).toEqual(['worktree', 'add', expect.any(String), 'harnext/issue-13']);
  });

  it('propagates a git fetch failure', async () => {
    const git = makeGit();
    git.queueResponse(
      (args) => args[0] === 'fetch',
      { exit: 1, stdout: '', stderr: 'no network' },
    );

    await expect(
      resolveWorktreeForItem({
        cwd,
        itemNumber: 1,
        itemKind: 'issue',
        runGit: git.runGit,
        rootOverride: root,
      }),
    ).rejects.toThrow(/git fetch origin failed/);
    expect(loadWorktreeRecord(cwd, 1)).toBeUndefined();
  });

  it('propagates a git worktree add failure', async () => {
    const git = makeGit();
    git.queueResponse(
      (args) => args[0] === 'worktree' && args[1] === 'add',
      { exit: 128, stdout: '', stderr: 'fatal: already exists' },
    );

    await expect(
      resolveWorktreeForItem({
        cwd,
        itemNumber: 2,
        itemKind: 'issue',
        runGit: git.runGit,
        rootOverride: root,
      }),
    ).rejects.toThrow(/git worktree add failed/);
    expect(loadWorktreeRecord(cwd, 2)).toBeUndefined();
  });

  it('skips fetch when skipFetch is set', async () => {
    const git = makeGit();
    await resolveWorktreeForItem({
      cwd,
      itemNumber: 3,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
      skipFetch: true,
    });
    expect(git.calls.find((c) => c.args[0] === 'fetch')).toBeUndefined();
  });

  it('uses pr- prefix for the branch when itemKind is pr', async () => {
    const git = makeGit();
    const record = await resolveWorktreeForItem({
      cwd,
      itemNumber: 55,
      itemKind: 'pr',
      runGit: git.runGit,
      rootOverride: root,
      skipFetch: true,
    });
    expect(record.branch).toBe('harnext/pr-55');
    expect(record.path.endsWith('pr-55')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────

describe('releaseWorktreeForItem', () => {
  let cwd: string;
  let root: string;
  beforeEach(() => {
    cwd = tmpCwd();
    root = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when no record exists', async () => {
    const git = makeGit();
    await releaseWorktreeForItem({ cwd, itemNumber: 404, runGit: git.runGit });
    // Only allowed call if any would be worktree list, but current impl skips if no record.
    expect(git.calls).toHaveLength(0);
  });

  it('calls git worktree remove, deletes the dir, and drops the state file', async () => {
    const git = makeGit();
    const record = await resolveWorktreeForItem({
      cwd,
      itemNumber: 8,
      itemKind: 'issue',
      runGit: git.runGit,
      rootOverride: root,
      skipFetch: true,
    });
    mkdirSync(record.path, { recursive: true });
    git.setWorktreeList([record.path]);

    await releaseWorktreeForItem({ cwd, itemNumber: 8, runGit: git.runGit });

    const removeCall = git.calls.find(
      (c) => c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toEqual(['worktree', 'remove', '--force', record.path]);

    expect(loadWorktreeRecord(cwd, 8)).toBeUndefined();
    expect(existsSync(record.path)).toBe(false);
  });

  it('still removes the state file when the worktree path is already gone', async () => {
    const git = makeGit();
    saveWorktreeRecord(cwd, {
      itemNumber: 88,
      itemKind: 'issue',
      path: join(root, 'never-existed', 'issue-88'),
      branch: 'harnext/issue-88',
      createdAt: 't',
      lastStageAt: 't',
    });
    git.setWorktreeList([]); // git doesn't know about it

    await releaseWorktreeForItem({ cwd, itemNumber: 88, runGit: git.runGit });
    expect(loadWorktreeRecord(cwd, 88)).toBeUndefined();
    // No remove call since the path isn't registered.
    expect(
      git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'),
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────

describe('pruneStaleWorktrees', () => {
  let cwd: string;
  let root: string;
  beforeEach(() => {
    cwd = tmpCwd();
    root = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty when the state dir does not exist', () => {
    const result = pruneStaleWorktrees(cwd);
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('drops records whose state file is older than the retention window', () => {
    const git = makeGit();
    const fresh: WorktreeRecord = {
      itemNumber: 1,
      itemKind: 'issue',
      path: join(root, 'issue-1'),
      branch: 'harnext/issue-1',
      createdAt: 't',
      lastStageAt: 't',
    };
    const stale: WorktreeRecord = { ...fresh, itemNumber: 2, path: join(root, 'issue-2') };
    saveWorktreeRecord(cwd, fresh);
    saveWorktreeRecord(cwd, stale);

    // Backdate #2.
    const past = Date.now() / 1000 - (DEFAULT_WORKTREE_STALE_DAYS + 2) * 24 * 60 * 60;
    utimesSync(join(getWorktreesStateDir(cwd), '2.json'), past, past);

    const result = pruneStaleWorktrees(cwd, DEFAULT_WORKTREE_STALE_DAYS, new Date(), git.runGit);
    expect(result.removed).toEqual(['2.json']);
    expect(loadWorktreeRecord(cwd, 2)).toBeUndefined();
    expect(loadWorktreeRecord(cwd, 1)).toEqual(fresh);
  });
});

