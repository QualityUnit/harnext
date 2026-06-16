import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from './config.js';
import { isPermissionMode, type PermissionMode } from './tool-policy.js';

export interface Preferences {
  defaultProvider?: string;
  /** Per-provider chosen model id, keyed by provider id. */
  defaultModels?: Record<string, string>;
  /**
   * Last permission mode the user selected interactively (cycled with
   * Shift+Tab). Restored as the starting mode of the next interactive session
   * unless overridden by `--permission-mode`.
   */
  defaultMode?: PermissionMode;
}

function getPreferencesPath(): string {
  return join(getAgentDir(), 'preferences.json');
}

export function loadPreferences(): Preferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Preferences;
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Preferences): void {
  const path = getPreferencesPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
}

export function setDefaultProvider(provider: string): void {
  const prefs = loadPreferences();
  prefs.defaultProvider = provider;
  savePreferences(prefs);
}

export function setDefaultModel(provider: string, model: string): void {
  const prefs = loadPreferences();
  prefs.defaultModels = { ...prefs.defaultModels, [provider]: model };
  savePreferences(prefs);
}

export function getDefaultModel(provider: string): string | undefined {
  return loadPreferences().defaultModels?.[provider];
}

/** Persist the interactive permission mode chosen via Shift+Tab. */
export function setDefaultMode(mode: PermissionMode): void {
  const prefs = loadPreferences();
  prefs.defaultMode = mode;
  savePreferences(prefs);
}

/** The saved interactive permission mode, if any (and still valid). */
export function getDefaultMode(): PermissionMode | undefined {
  const mode = loadPreferences().defaultMode;
  return mode && isPermissionMode(mode) ? mode : undefined;
}

/** Save both defaultProvider and its model in one call. */
export function setDefault(provider: string, model: string): void {
  const prefs = loadPreferences();
  prefs.defaultProvider = provider;
  prefs.defaultModels = { ...prefs.defaultModels, [provider]: model };
  savePreferences(prefs);
}
