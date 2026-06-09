/**
 * Filesystem-based project context, mirroring the Claude Agent SDK's
 * `setting_sources` option. When a caller opts into a source, the matching
 * `CLAUDE.md` memory files are read and appended to the system prompt.
 *
 * Sources:
 *  - `project` / `local` → `<cwd>/CLAUDE.md` and `<cwd>/.claude/CLAUDE.md`
 *  - `user`             → `~/.claude/CLAUDE.md`
 *
 * No source selected (the default) loads nothing, matching the SDK's opt-in
 * behavior: the user passes `setting_sources=["project"]` precisely to pull in
 * `./CLAUDE.md`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SettingSource = 'user' | 'project' | 'local';

export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

export function isSettingSource(value: string): value is SettingSource {
  return (SETTING_SOURCES as readonly string[]).includes(value);
}

export interface LoadProjectContextOptions {
  cwd: string;
  settingSources?: readonly SettingSource[];
}

function readIfExists(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, 'utf8').trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the CLAUDE.md files implied by `settingSources`, in load order, with
 * duplicates removed. Exposed for tests.
 */
export function resolveContextFiles(options: LoadProjectContextOptions): string[] {
  const sources = new Set(options.settingSources ?? []);
  if (sources.size === 0) return [];

  const paths: string[] = [];
  if (sources.has('user')) {
    paths.push(join(homedir(), '.claude', 'CLAUDE.md'));
  }
  if (sources.has('project') || sources.has('local')) {
    paths.push(join(options.cwd, 'CLAUDE.md'));
    paths.push(join(options.cwd, '.claude', 'CLAUDE.md'));
  }
  return [...new Set(paths)];
}

/**
 * Read the selected CLAUDE.md files and format them as a block to append to
 * the system prompt. Returns an empty string when nothing is selected or no
 * file exists.
 */
export function loadProjectContext(options: LoadProjectContextOptions): string {
  const blocks: string[] = [];
  for (const path of resolveContextFiles(options)) {
    const content = readIfExists(path);
    if (content) {
      blocks.push(`# Project context (${path})\n\n${content}`);
    }
  }
  if (blocks.length === 0) return '';
  return `\n\n${blocks.join('\n\n')}`;
}
