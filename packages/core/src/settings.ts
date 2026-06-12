import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_DIR_NAME, getAgentDir } from './config.js';

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

/**
 * Push each conversation with the harness to a context engine (the harnext
 * cloud backend). Off by default; `harnext connect` runs the device-flow login
 * and flips `enabled` on while storing the endpoint here. The OAuth tokens
 * themselves live separately (see `cloud/tokens.ts`), never in settings.
 */
export interface CloudSyncSettings {
  enabled: boolean;
  /** Base URL of the context engine ingest API, e.g. https://engine.example.com */
  endpoint?: string;
  /** Harness name reported with each session (recommended: "harnext"). */
  harness: string;
}

export interface HarnextSettings {
  compaction: CompactionSettings;
  cloudSync: CloudSyncSettings;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export const DEFAULT_CLOUD_SYNC_SETTINGS: CloudSyncSettings = {
  enabled: false,
  harness: 'harnext',
};

export const DEFAULT_SETTINGS: HarnextSettings = {
  compaction: DEFAULT_COMPACTION_SETTINGS,
  cloudSync: DEFAULT_CLOUD_SYNC_SETTINGS,
};

interface PartialFileSettings {
  compaction?: Partial<CompactionSettings>;
  cloudSync?: Partial<CloudSyncSettings>;
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

function mergeCloudSync(
  base: CloudSyncSettings,
  override: Partial<CloudSyncSettings> | undefined,
): CloudSyncSettings {
  if (!override) return base;
  return {
    enabled: typeof override.enabled === 'boolean' ? override.enabled : base.enabled,
    endpoint:
      typeof override.endpoint === 'string' && override.endpoint.trim().length > 0
        ? override.endpoint.trim()
        : base.endpoint,
    harness:
      typeof override.harness === 'string' && override.harness.trim().length > 0
        ? override.harness.trim()
        : base.harness,
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

  let cloudSync = mergeCloudSync(DEFAULT_CLOUD_SYNC_SETTINGS, user?.cloudSync);
  cloudSync = mergeCloudSync(cloudSync, project?.cloudSync);

  return { compaction, cloudSync };
}

/**
 * Persist a partial `cloudSync` patch into the user-wide settings file,
 * preserving every other field already on disk. Used by `harnext connect` to
 * enable sync and record the endpoint after a successful login.
 */
export function setCloudSyncSettings(patch: Partial<CloudSyncSettings>): void {
  const path = getUserSettingsPath();
  const raw = readJsonIfExists(path) ?? {};
  const next = { ...raw, cloudSync: { ...(raw.cloudSync ?? {}), ...patch } };
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
}
