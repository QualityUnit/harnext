import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export async function isGitRepo(dir?: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function getRemoteUrl(dir?: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getRepoRoot(dir?: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: dir });
  return stdout.trim();
}

export async function getCurrentBranch(dir?: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dir });
  return stdout.trim();
}

export async function getHeadSha(dir?: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse HEAD', { cwd: dir });
  return stdout.trim();
}

export async function hasUncommittedChanges(dir?: string): Promise<boolean> {
  const { stdout } = await execAsync('git status --porcelain', { cwd: dir });
  return stdout.trim().length > 0;
}

export function snapshotUntrackedFiles(cwd: string): Set<string> {
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf-8',
  });
  return new Set(output.split('\n').filter(Boolean));
}

export function snapshotModifiedFiles(cwd: string): Set<string> {
  try {
    const output = execFileSync('git', ['diff', 'HEAD', '--name-only'], {
      cwd,
      encoding: 'utf-8',
    });
    return new Set(output.split('\n').filter(Boolean));
  } catch {
    // HEAD doesn't exist (no commits yet) — no tracked files to modify
    return new Set();
  }
}

/**
 * Compares the working tree against a pre-run snapshot to detect created/modified files.
 *
 * Note: There is an inherent TOCTOU window between the CLI run finishing and
 * this function executing. In practice this is acceptable because the working
 * directory is under our control during harness generation.
 */
export function diffWorkingTree(
  beforeUntracked: Set<string>,
  cwd: string,
  beforeModified?: Set<string>,
): { created: string[]; modified: string[] } {
  // Use HEAD to catch both staged and unstaged modifications.
  // On a fresh repo with no commits, HEAD doesn't exist — treat as no modifications.
  let modified: string[] = [];
  try {
    const diffOutput = execFileSync('git', ['diff', 'HEAD', '--name-only'], {
      cwd,
      encoding: 'utf-8',
    });
    const allModified = diffOutput.split('\n').filter(Boolean);
    modified = beforeModified ? allModified.filter((f) => !beforeModified.has(f)) : allModified;
  } catch {
    // HEAD doesn't exist (no commits yet) — all files are new, none modified
  }

  const afterUntracked = snapshotUntrackedFiles(cwd);
  const created = [...afterUntracked].filter((f) => !beforeUntracked.has(f));

  return { created, modified };
}
