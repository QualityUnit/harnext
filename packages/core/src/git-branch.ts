import { execFileSync } from 'node:child_process';

export interface GitBranchOk {
  ok: true;
  branch: string;
}

export interface GitBranchError {
  ok: false;
  message: string;
}

export type GitBranchResult = GitBranchOk | GitBranchError;

/**
 * Read the current branch name via `git rev-parse --abbrev-ref HEAD`.
 * Returns `null` when the directory is not a git repo, git isn't installed,
 * or HEAD is detached (`HEAD` is filtered out).
 */
export function getCurrentGitBranch(cwd: string): string | null {
  try {
    const stdout = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const branch = stdout.trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Create and switch to a new branch from the current HEAD.
 * Fails if the branch already exists — caller decides how to react.
 */
export function createAndSwitchBranch(cwd: string, name: string): GitBranchResult {
  try {
    execFileSync('git', ['checkout', '-b', name], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, branch: name };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '';
    const message = stderr.trim() || e.message || 'git checkout failed';
    return { ok: false, message };
  }
}
