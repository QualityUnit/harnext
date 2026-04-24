/**
 * Utilities for the `.harnext/scripts/` directory — the shell scripts
 * referenced by each tier's `requiredChecks` in the risk contract.
 *
 * These helpers are split out from the stage so tests can exercise
 * slug/path rules directly and so the wizard (or future introspection
 * tools) can read/list scripts without pulling the whole pipeline.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR_NAME } from '../../config.js';

export const SCRIPTS_SUBDIR = 'scripts';

/** `<cwd>/.harnext/scripts/` — committed, user-editable. */
export function getScriptsDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, SCRIPTS_SUBDIR);
}

/**
 * Normalize a free-form check id (`"Browser Evidence"`) into a portable
 * file-name slug (`"browser-evidence"`). Lowercase, non-alnum → `-`,
 * collapse runs, trim leading/trailing `-`.
 */
export function slugifyCheckId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CheckScriptEntry {
  id: string;
  slug: string;
  fileName: string;
  /** Absolute path `<cwd>/.harnext/scripts/<slug>.sh`. */
  filePath: string;
}

export function checkScriptEntry(cwd: string, id: string): CheckScriptEntry {
  const slug = slugifyCheckId(id);
  const fileName = `${slug}.sh`;
  return {
    id,
    slug,
    fileName,
    filePath: join(getScriptsDir(cwd), fileName),
  };
}

/**
 * Names of the `.sh` files currently in `.harnext/scripts/`. Used to
 * compute which checks the agent needs to write anew (missing) vs which
 * already exist (preserve user edits).
 */
export function listExistingScriptFiles(cwd: string): string[] {
  const dir = getScriptsDir(cwd);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(
      (name) => name.endsWith('.sh') && statSync(join(dir, name)).isFile(),
    );
  } catch {
    return [];
  }
}

/**
 * Given a list of required check ids, partition them into
 * `{ existing, missing }` based on whether `<slug>.sh` is already on
 * disk. Used by the check-scripts stage to decide whether to invoke
 * the agent at all.
 */
export function partitionChecks(
  cwd: string,
  checkIds: string[],
): { existing: CheckScriptEntry[]; missing: CheckScriptEntry[] } {
  const present = new Set(listExistingScriptFiles(cwd));
  const existing: CheckScriptEntry[] = [];
  const missing: CheckScriptEntry[] = [];
  for (const id of checkIds) {
    const entry = checkScriptEntry(cwd, id);
    if (present.has(entry.fileName)) {
      existing.push(entry);
    } else {
      missing.push(entry);
    }
  }
  return { existing, missing };
}

/** Ensures the scripts directory exists. Idempotent. */
export function ensureScriptsDir(cwd: string): string {
  const dir = getScriptsDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}
