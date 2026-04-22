/**
 * Per-issue git worktree lifecycle for cron-driven agent runs. The poller
 * calls {@link resolveWorktreeForItem} at the top of an item's chain to get
 * an isolated checkout, and {@link releaseWorktreeForItem} once the chain
 * terminates cleanly. Everything the agent does during those stages happens
 * inside that worktree rather than the user's live checkout.
 *
 * State files live at `~/.harnext/projects/<hash>/worktree-state/<N>.json`
 * and the actual worktree checkouts live at
 * `~/.harnext/projects/<hash>/worktrees/<kind>-<N>/`, keeping the user's
 * project tree clean.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { getProjectHash, getProjectStateDir } from './config.js';

export const WORKTREES_DIR_NAME = 'worktrees';
export const WORKTREE_STATE_DIR_NAME = 'worktree-state';
/** Default pruning horizon for orphaned worktree state files. */
export const DEFAULT_WORKTREE_STALE_DAYS = 14;

export interface WorktreeRecord {
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  path: string;
  branch: string;
  createdAt: string;
  lastStageAt: string;
}

export interface RunGitResult {
  exit: number;
  stdout: string;
  stderr: string;
}

export type RunGit = (args: string[], cwd: string) => RunGitResult;

export interface ResolveWorktreeOptions {
  /** The user's live checkout (the main git repo). */
  cwd: string;
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  /** Injected for tests. Defaults to a real spawnSync of `git`. */
  runGit?: RunGit;
  /** Override the hash of the project path (tests + multi-root setups). */
  projectHash?: string;
  /** Override the worktree checkout root. Defaults to the project state dir's worktrees/. */
  rootOverride?: string;
  /** Override the branch name. Defaults to `harnext/<kind>-<number>`. */
  branch?: string;
  /** Starting ref for new branches. Defaults to `origin/HEAD`. */
  baseRef?: string;
  /** When true, skip `git fetch origin` — useful in tests and offline reruns. */
  skipFetch?: boolean;
}

export interface PruneResult {
  removed: string[];
  errors: string[];
}

// ── Paths ───────────────────────────────────────────────────────────

export function getWorktreesStateDir(cwd: string): string {
  return join(getProjectStateDir(cwd), WORKTREE_STATE_DIR_NAME);
}

/**
 * Optional global checkout root. When `HARNEXT_WORKTREES_DIR` is set, all
 * worktree checkouts live under `<root>/<projectHash>/`; otherwise they
 * live inside the project state dir alongside the rest of this project's
 * machine state. The override exists for operators who want worktrees on
 * a different filesystem than `~/.harnext/`.
 */
export function getWorktreesGlobalRoot(override?: string): string | undefined {
  if (override) return override;
  return process.env.HARNEXT_WORKTREES_DIR;
}

export function getProjectWorktreeHash(cwd: string): string {
  return getProjectHash(cwd);
}

export function getProjectWorktreeRoot(cwd: string, override?: string): string {
  const root = getWorktreesGlobalRoot(override);
  if (root) return join(root, getProjectWorktreeHash(cwd));
  return join(getProjectStateDir(cwd), WORKTREES_DIR_NAME);
}

function getWorktreeStateFile(cwd: string, itemNumber: number): string {
  return join(getWorktreesStateDir(cwd), `${itemNumber}.json`);
}

function defaultBranchName(itemKind: 'issue' | 'pr', itemNumber: number): string {
  return `harnext/${itemKind}-${itemNumber}`;
}

function defaultWorktreePath(
  cwd: string,
  itemKind: 'issue' | 'pr',
  itemNumber: number,
  override?: string,
): string {
  return join(getProjectWorktreeRoot(cwd, override), `${itemKind}-${itemNumber}`);
}

// ── State I/O ───────────────────────────────────────────────────────

export function loadWorktreeRecord(
  cwd: string,
  itemNumber: number,
): WorktreeRecord | undefined {
  const path = getWorktreeStateFile(cwd, itemNumber);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorktreeRecord;
  } catch {
    return undefined;
  }
}

export function saveWorktreeRecord(cwd: string, record: WorktreeRecord): void {
  const dir = getWorktreesStateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getWorktreeStateFile(cwd, record.itemNumber);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function deleteWorktreeRecord(cwd: string, itemNumber: number): void {
  const path = getWorktreeStateFile(cwd, itemNumber);
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function listWorktreeRecords(cwd: string): WorktreeRecord[] {
  const dir = getWorktreesStateDir(cwd);
  if (!existsSync(dir)) return [];
  const out: WorktreeRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as WorktreeRecord;
      out.push(parsed);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ── Git shim ────────────────────────────────────────────────────────

/** Real-git implementation used when the caller doesn't inject one. */
export const defaultRunGit: RunGit = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return {
    exit: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
};

/** Parse `git worktree list --porcelain` into a set of absolute paths. */
function parseWorktreeList(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.add(line.slice('worktree '.length).trim());
    }
  }
  return paths;
}

function branchExists(runGit: RunGit, cwd: string, branch: string): boolean {
  const res = runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return res.exit === 0;
}

// ── Resolve / release ────────────────────────────────────────────────

/**
 * Return an existing worktree record for the item, or create one. Callers
 * should treat the returned `path` as the cwd for all subsequent agent work
 * on that item until {@link releaseWorktreeForItem} is called.
 */
export async function resolveWorktreeForItem(
  opts: ResolveWorktreeOptions,
): Promise<WorktreeRecord> {
  const runGit = opts.runGit ?? defaultRunGit;
  const nowIso = new Date().toISOString();
  const existing = loadWorktreeRecord(opts.cwd, opts.itemNumber);

  if (existing) {
    const listed = runGit(['worktree', 'list', '--porcelain'], opts.cwd);
    const registered =
      listed.exit === 0 && parseWorktreeList(listed.stdout).has(existing.path);
    if (existsSync(existing.path) && registered) {
      const updated: WorktreeRecord = { ...existing, lastStageAt: nowIso };
      saveWorktreeRecord(opts.cwd, updated);
      return updated;
    }
    // Stale state — the worktree is gone or not registered. Fall through
    // and recreate, but first try to clean up whatever's left.
    if (registered) {
      runGit(['worktree', 'remove', '--force', existing.path], opts.cwd);
    }
    try {
      rmSync(existing.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    deleteWorktreeRecord(opts.cwd, opts.itemNumber);
  }

  const branch = opts.branch ?? defaultBranchName(opts.itemKind, opts.itemNumber);
  const worktreePath = defaultWorktreePath(
    opts.cwd,
    opts.itemKind,
    opts.itemNumber,
    opts.rootOverride,
  );
  mkdirSync(dirname(worktreePath), { recursive: true });

  if (!opts.skipFetch) {
    const fetched = runGit(['fetch', 'origin'], opts.cwd);
    if (fetched.exit !== 0) {
      throw new Error(
        `git fetch origin failed in ${opts.cwd}: ${fetched.stderr.trim() || 'exit ' + fetched.exit}`,
      );
    }
  }

  const baseRef = opts.baseRef ?? 'origin/HEAD';
  const addArgs = branchExists(runGit, opts.cwd, branch)
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseRef];

  const added = runGit(addArgs, opts.cwd);
  if (added.exit !== 0) {
    throw new Error(
      `git worktree add failed for #${opts.itemNumber}: ${added.stderr.trim() || 'exit ' + added.exit}`,
    );
  }

  const record: WorktreeRecord = {
    itemNumber: opts.itemNumber,
    itemKind: opts.itemKind,
    path: worktreePath,
    branch,
    createdAt: nowIso,
    lastStageAt: nowIso,
  };
  saveWorktreeRecord(opts.cwd, record);
  return record;
}

/**
 * Tear down the worktree for an item and drop its state file. The branch is
 * intentionally left in place — the implement stage may have already pushed
 * it, and we don't want to surprise-delete the user's work.
 */
export async function releaseWorktreeForItem(
  opts: Pick<ResolveWorktreeOptions, 'cwd' | 'itemNumber' | 'runGit'>,
): Promise<void> {
  const runGit = opts.runGit ?? defaultRunGit;
  const record = loadWorktreeRecord(opts.cwd, opts.itemNumber);
  if (!record) return;

  const listed = runGit(['worktree', 'list', '--porcelain'], opts.cwd);
  const registered =
    listed.exit === 0 && parseWorktreeList(listed.stdout).has(record.path);
  if (registered) {
    runGit(['worktree', 'remove', '--force', record.path], opts.cwd);
  }
  try {
    rmSync(record.path, { recursive: true, force: true });
  } catch {
    // best-effort — the remove above usually handles this.
  }
  deleteWorktreeRecord(opts.cwd, opts.itemNumber);
}

/**
 * Best-effort pruning: drop state files older than `maxAgeDays` and clean up
 * their worktrees. Does not check whether the item is still open on GitHub —
 * that check is deferred to a future reconciliation pass.
 */
export function pruneStaleWorktrees(
  cwd: string,
  maxAgeDays: number = DEFAULT_WORKTREE_STALE_DAYS,
  now: Date = new Date(),
  runGit: RunGit = defaultRunGit,
): PruneResult {
  const dir = getWorktreesStateDir(cwd);
  const result: PruneResult = { removed: [], errors: [] };
  if (!existsSync(dir)) return result;
  const cutoff = now.getTime() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      const parsed = JSON.parse(readFileSync(full, 'utf-8')) as WorktreeRecord;
      if (parsed?.path) {
        const listed = runGit(['worktree', 'list', '--porcelain'], cwd);
        if (listed.exit === 0 && parseWorktreeList(listed.stdout).has(parsed.path)) {
          runGit(['worktree', 'remove', '--force', parsed.path], cwd);
        }
        try {
          rmSync(parsed.path, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      unlinkSync(full);
      result.removed.push(entry);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}

