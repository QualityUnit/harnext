import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from './config.js';

export interface Preferences {
  defaultProvider?: string;
  /** Per-provider chosen model id, keyed by provider id. */
  defaultModels?: Record<string, string>;
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

/** Save both defaultProvider and its model in one call. */
export function setDefault(provider: string, model: string): void {
  const prefs = loadPreferences();
  prefs.defaultProvider = provider;
  prefs.defaultModels = { ...prefs.defaultModels, [provider]: model };
  savePreferences(prefs);
}
