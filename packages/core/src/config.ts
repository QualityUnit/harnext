import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'harnext';
export const VERSION = '0.1.0';
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
