import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from './config.js';

export interface AuthEntry {
  key?: string;
  baseUrl?: string;
}

export interface AuthData {
  [provider: string]: AuthEntry;
}

function getAuthPath(): string {
  return join(getAgentDir(), 'auth.json');
}

export function loadAuth(): AuthData {
  const path = getAuthPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthData;
  } catch {
    return {};
  }
}

function writeAuth(data: AuthData): void {
  const path = getAuthPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function saveProviderKey(provider: string, key: string): void {
  const data = loadAuth();
  data[provider] = { ...data[provider], key };
  writeAuth(data);
}

export function saveProviderConfig(provider: string, config: AuthEntry): void {
  const data = loadAuth();
  data[provider] = { ...data[provider], ...config };
  writeAuth(data);
}

export function getProviderConfig(provider: string): AuthEntry | undefined {
  return loadAuth()[provider];
}

export function getStoredKey(provider: string): string | undefined {
  return loadAuth()[provider]?.key;
}

export function listStoredProviders(): string[] {
  return Object.keys(loadAuth());
}

/**
 * Remove a provider's stored config (key + baseUrl). No-op when the provider
 * has no entry. Used by the /model picker's "Remove configuration" action so
 * the next pick of the same provider goes through the first-run wizard again.
 *
 * Note: this only clears auth.json; an env var like `NVIDIA_API_KEY` set in
 * the shell still wins over a missing stored key on the next request.
 */
export function removeProviderConfig(provider: string): void {
  const data = loadAuth();
  if (provider in data) {
    delete data[provider];
    writeAuth(data);
  }
}
