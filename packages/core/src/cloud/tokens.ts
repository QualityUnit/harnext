import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from '../config.js';

/**
 * OAuth tokens for the context engine, stored separately from `settings.json`
 * (which holds non-secret config) and from `auth.json` (LLM provider keys). The
 * file is written `0600` like provider auth — it carries a long-lived refresh
 * token.
 */
export interface CloudTokens {
  /** The context engine this grant is for; tokens are endpoint-scoped. */
  endpoint: string;
  /** OAuth public client id the grant was issued to. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds the access token expires at. */
  accessExpiresAt: number;
}

function getTokensPath(): string {
  return join(getAgentDir(), 'context-engine.json');
}

export function loadCloudTokens(): CloudTokens | undefined {
  const path = getTokensPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CloudTokens>;
    if (
      typeof parsed.endpoint === 'string' &&
      typeof parsed.clientId === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.accessExpiresAt === 'number'
    ) {
      return parsed as CloudTokens;
    }
  } catch {
    // fall through — treated as no stored tokens
  }
  return undefined;
}

export function saveCloudTokens(tokens: CloudTokens): void {
  const path = getTokensPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
}

export function clearCloudTokens(): void {
  const path = getTokensPath();
  if (existsSync(path)) rmSync(path, { force: true });
}
