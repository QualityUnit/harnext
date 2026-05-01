import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_DIR_NAME, getAgentDir } from './config.js';

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface HarnextSettings {
  compaction: CompactionSettings;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export const DEFAULT_SETTINGS: HarnextSettings = {
  compaction: DEFAULT_COMPACTION_SETTINGS,
};

interface PartialFileSettings {
  compaction?: Partial<CompactionSettings>;
}

function readJsonIfExists(path: string): PartialFileSettings | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as PartialFileSettings;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function getUserSettingsPath(): string {
  return join(getAgentDir(), 'settings.json');
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, 'settings.json');
}

function mergeCompaction(
  base: CompactionSettings,
  override: Partial<CompactionSettings> | undefined,
): CompactionSettings {
  if (!override) return base;
  return {
    enabled: typeof override.enabled === 'boolean' ? override.enabled : base.enabled,
    reserveTokens:
      typeof override.reserveTokens === 'number' && override.reserveTokens > 0
        ? Math.floor(override.reserveTokens)
        : base.reserveTokens,
    keepRecentTokens:
      typeof override.keepRecentTokens === 'number' && override.keepRecentTokens > 0
        ? Math.floor(override.keepRecentTokens)
        : base.keepRecentTokens,
  };
}

/**
 * Load harnext settings, merging defaults < user-wide < project-local.
 *
 * - User-wide: `~/.harnext/agent/settings.json` (or `$HARNEXT_AGENT_DIR/settings.json`).
 * - Project: `<cwd>/.harnext/settings.json`.
 *
 * Project values override user values; user values override defaults.
 */
export function loadSettings(cwd: string = process.cwd()): HarnextSettings {
  const user = readJsonIfExists(getUserSettingsPath());
  const project = readJsonIfExists(getProjectSettingsPath(cwd));

  let compaction = mergeCompaction(DEFAULT_COMPACTION_SETTINGS, user?.compaction);
  compaction = mergeCompaction(compaction, project?.compaction);

  return { compaction };
}
