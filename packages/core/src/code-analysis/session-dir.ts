/**
 * Persistent scratch directory shared across all code-analysis sub-stages.
 *
 * The classic per-stage `mkdtempSync` → `rmSync` pattern means each stage's
 * tmp files are gone before the next stage starts. The new pipeline wants
 * later stages' agent runs to be able to read earlier stages' JSON output
 * without re-invoking the earlier stage, so we allocate one directory at
 * pipeline entry and keep it alive for the whole run.
 *
 * Location: `<cwd>/.harnext/analysis-runs/<ISO-timestamp>-<rand6>/`.
 * In-repo (not OS tmp) so:
 *   - the agent can reference paths relative to cwd,
 *   - the user can inspect a retained session after a failure,
 *   - debugging workflows don't require a system tmpdir crawl.
 *
 * `.gitignore` entries are appended-if-missing to `<cwd>/.harnext/.gitignore`
 * so these derived artifacts never get committed:
 *   - `analysis-runs/` — per-run scratch dirs (retained on failure for
 *     debugging; cleaned on success).
 *   - `tech-stack.json` — durable cache of the code-analysis pipeline's
 *     tech-stack inventory. Only read by the wizard's "reuse existing
 *     analysis" branch; regenerated on demand. Committing it means
 *     teammates reuse a stale map that drifts from reality.
 *
 * `contract.json` and `scripts/*.sh` are intentionally NOT in the
 * ignore list — they're consumed by CI (the generated
 * `risk-policy-gate.sh` reads `contract.json`; every check script is
 * invoked from CI) and must be committed.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_DIR_NAME } from '../config.js';

const SESSION_SUBDIR = 'analysis-runs';
const KEEP_ENV_VAR = 'HARNEXT_KEEP_ANALYSIS_DIR';
/**
 * Derived artifacts the wizard writes under `.harnext/` that should
 * never be committed. Keep this list tight — every entry is a
 * deliberate "this is regenerated and committing it causes drift"
 * call, not a catch-all. Trailing slash marks a directory.
 */
const GITIGNORE_ENTRIES: readonly string[] = [`${SESSION_SUBDIR}/`, 'tech-stack.json'];

export interface ManifestEntry {
  stage: string;
  outputs: string[];
}

export interface SessionDir {
  /** Absolute path to the session root. */
  readonly root: string;
  /** Absolute path to `<root>/manifest.json`. */
  readonly manifestPath: string;
  /**
   * Absolute path under the session for a stage's file. Creates the
   * per-stage subdirectory lazily.
   */
  pathFor(stageId: string, fileName: string): string;
  /** Append an entry to `manifest.json` (rewrites the whole file atomically). */
  appendManifest(entry: ManifestEntry): void;
  /**
   * Remove the session root. No-op if `retain()` was called or
   * `HARNEXT_KEEP_ANALYSIS_DIR=1` was set at construction time.
   */
  cleanup(): void;
  /**
   * Suppress subsequent `cleanup()` calls. Typically called from the
   * orchestrator's error branch so a failed run's intermediates stay
   * around for inspection. `reason` is appended to the manifest for
   * debugging context.
   */
  retain(reason: string): void;
}

export function createSessionDir(cwd: string): SessionDir {
  const parent = join(cwd, CONFIG_DIR_NAME, SESSION_SUBDIR);
  mkdirSync(parent, { recursive: true });
  ensureGitignore(cwd);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(3).toString('hex');
  const root = join(parent, `${stamp}-${suffix}`);
  mkdirSync(root, { recursive: true });

  const manifestPath = join(root, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ createdAt: new Date().toISOString(), entries: [] }, null, 2) +
      '\n',
    'utf-8',
  );

  let retained = process.env[KEEP_ENV_VAR] === '1';
  let retainReason: string | null = null;

  const pathFor = (stageId: string, fileName: string): string => {
    const dir = join(root, stageId);
    mkdirSync(dir, { recursive: true });
    return join(dir, fileName);
  };

  const appendManifest = (entry: ManifestEntry): void => {
    let current: { createdAt: string; entries: ManifestEntry[]; retain?: string };
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      current = JSON.parse(raw) as typeof current;
      if (!Array.isArray(current.entries)) current.entries = [];
    } catch {
      current = { createdAt: new Date().toISOString(), entries: [] };
    }
    current.entries.push(entry);
    if (retainReason) current.retain = retainReason;
    writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  };

  const retain = (reason: string): void => {
    retained = true;
    retainReason = reason;
    // Stamp the manifest so inspectors see why the run was kept.
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const current = JSON.parse(raw) as {
        createdAt: string;
        entries: ManifestEntry[];
        retain?: string;
      };
      current.retain = reason;
      writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    } catch {
      // best effort; manifest stamping isn't load-bearing
    }
  };

  const cleanup = (): void => {
    if (retained) return;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort; a leftover dir in .harnext/analysis-runs is benign
    }
  };

  return {
    root,
    manifestPath,
    pathFor,
    appendManifest,
    cleanup,
    retain,
  };
}

/**
 * Ensures every entry in `GITIGNORE_ENTRIES` is present in
 * `.harnext/.gitignore`. Creates the file when missing; only appends
 * entries that aren't already there so existing user-authored ignores
 * survive (important — `.harnext/` may accumulate handwritten lines
 * across re-runs). For each entry we also accept its non-trailing-slash
 * twin (e.g. `analysis-runs` vs `analysis-runs/`) as already-present
 * so we don't emit a second line that means the same thing.
 */
function ensureGitignore(cwd: string): void {
  const gitignorePath = join(cwd, CONFIG_DIR_NAME, '.gitignore');
  mkdirSync(dirname(gitignorePath), { recursive: true });

  let existing = '';
  if (existsSync(gitignorePath)) {
    try {
      existing = readFileSync(gitignorePath, 'utf-8');
    } catch {
      return;
    }
  }
  const existingLines = new Set(
    existing.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
  );

  const toAppend: string[] = [];
  for (const entry of GITIGNORE_ENTRIES) {
    const twin = entry.endsWith('/') ? entry.slice(0, -1) : `${entry}/`;
    if (existingLines.has(entry) || existingLines.has(twin)) continue;
    toAppend.push(entry);
    existingLines.add(entry);
  }
  if (toAppend.length === 0) return;

  if (existing.length === 0) {
    writeFileSync(gitignorePath, toAppend.join('\n') + '\n', 'utf-8');
    return;
  }
  const prefix = existing.endsWith('\n') ? '' : '\n';
  appendFileSync(gitignorePath, `${prefix}${toAppend.join('\n')}\n`, 'utf-8');
}
