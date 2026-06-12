import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'harnext';

/**
 * Resolve the running package's version from its package.json. Walking up from
 * `import.meta.url` covers both layouts the constant is read in:
 *
 *   - npm-published CLI: `<install>/dist/index.js` → `<install>/package.json`
 *     (the bundled CLI's package.json — `harnext`).
 *   - core run from source (tests, vitest): `<core>/src/config.ts` →
 *     `<core>/package.json` (`@harnext/core`).
 *
 * The previous implementation hardcoded "0.1.0" and silently drifted from the
 * package version every release. Reading at runtime keeps a single source of
 * truth.
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', 'package.json'),
      join(here, '..', '..', 'package.json'),
    ];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if ((pkg.name === 'harnext' || pkg.name === '@harnext/core') && pkg.version) {
          return pkg.version;
        }
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Fall through to the placeholder.
  }
  return '0.0.0';
}

export const VERSION = resolveVersion();
export const CONFIG_DIR_NAME = '.harnext';

/** Project-hash length used for deriving per-project state dirs. */
const PROJECT_HASH_LEN = 12;

/**
 * Root for all harnext-managed state on this machine. Defaults to
 * `~/.harnext`, but tests and multi-user setups can redirect the whole
 * subtree by setting `HARNEXT_HOME`.
 */
export function getHarnextHome(): string {
  return process.env.HARNEXT_HOME ?? join(homedir(), CONFIG_DIR_NAME);
}

export function getAgentDir(): string {
  return process.env.HARNEXT_AGENT_DIR ?? join(getHarnextHome(), 'agent');
}

export function getSessionsDir(): string {
  return join(getAgentDir(), 'sessions');
}

/**
 * Project-local skills dir. Intentionally still under `<cwd>/.harnext/` so
 * users can see and edit the SKILL.md files alongside the rest of the
 * project; skills are authored content, not machine state.
 */
export function getProjectSkillsDir(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_DIR_NAME, 'skills');
}

export function getUserSkillsDir(): string {
  return process.env.HARNEXT_USER_SKILLS_DIR ?? join(getHarnextHome(), 'skills');
}

/**
 * Stable hash derived from the absolute project path. Used to scope all
 * per-project state under `~/.harnext/projects/<hash>/` so different
 * projects on the same machine don't collide.
 */
export function getProjectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, PROJECT_HASH_LEN);
}

/**
 * Machine-state dir for this specific project checkout. This is where the
 * GitHub connection config, poller logs, per-run transcripts, heartbeat
 * configs, and worktree bookkeeping live — all the stuff the user never
 * needs to see inside their repo.
 */
export function getProjectStateDir(cwd: string): string {
  return join(getHarnextHome(), 'projects', getProjectHash(cwd));
}

/**
 * Per-project memory dir. Scoped by cwd hash and kept under the machine-state
 * tree (not in the repo), mirroring Claude Code's auto-memory: a different
 * working directory gets a different memory. The agent manages the markdown
 * files here via the `memory` tool; `MEMORY.md` is the index loaded into the
 * system prompt at session start.
 */
export function getProjectMemoryDir(cwd: string = process.cwd()): string {
  return join(getProjectStateDir(cwd), 'memory');
}
