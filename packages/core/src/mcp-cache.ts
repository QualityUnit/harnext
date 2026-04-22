import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from './config.js';
import type { McpServerConfig } from './mcp-config.js';

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ServerCacheEntry {
  configHash: string;
  cachedAt: number;
  tools: CachedMcpTool[];
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

export function getMcpCachePath(): string {
  return join(getAgentDir(), 'mcp-cache.json');
}

export function loadMcpCache(): MetadataCache {
  const path = getMcpCachePath();
  if (!existsSync(path)) return { version: CACHE_VERSION, servers: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MetadataCache;
    if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION || !raw.servers) {
      return { version: CACHE_VERSION, servers: {} };
    }
    return raw;
  } catch {
    return { version: CACHE_VERSION, servers: {} };
  }
}

/**
 * Merge the patch into whatever is on disk and write atomically. This is safe
 * for concurrent writers because we read-modify-write on the file, and the
 * rename is atomic on POSIX.
 */
export function saveMcpCache(patch: { servers: Record<string, ServerCacheEntry> }): void {
  const path = getMcpCachePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = loadMcpCache();
  const merged: MetadataCache = {
    version: CACHE_VERSION,
    servers: { ...existing.servers, ...patch.servers },
  };

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function deleteMcpCacheEntry(name: string): void {
  const existing = loadMcpCache();
  if (!existing.servers[name]) return;
  delete existing.servers[name];
  const path = getMcpCachePath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Hash the subset of a server config that affects which tools are exposed.
 * Runtime-only fields (lifecycle, idleTimeout, debug, directTools) are
 * excluded so toggling those doesn't invalidate the cache.
 */
export function computeServerConfigHash(cfg: McpServerConfig): string {
  const identity: Record<string, unknown> = {
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
    cwd: cfg.cwd,
    url: cfg.url,
    headers: cfg.headers,
    excludeTools: cfg.excludeTools,
  };
  return createHash('sha256').update(stableStringify(identity)).digest('hex');
}

export function isServerCacheValid(entry: ServerCacheEntry, cfg: McpServerConfig, now = Date.now()): boolean {
  if (entry.configHash !== computeServerConfigHash(cfg)) return false;
  if (now - entry.cachedAt > CACHE_MAX_AGE_MS) return false;
  return true;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}
