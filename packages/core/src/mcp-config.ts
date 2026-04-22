import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir, getProjectStateDir } from './config.js';

export type McpLifecycle = 'lazy' | 'eager' | 'keep-alive';
export type McpToolPrefix = 'server' | 'short' | 'none';
export type McpScope = 'user' | 'project';

export interface McpServerConfig {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /** Runtime behavior */
  lifecycle?: McpLifecycle;
  idleTimeout?: number;
  directTools?: boolean | string[];
  excludeTools?: string[];
  debug?: boolean;
}

export interface McpSettings {
  toolPrefix?: McpToolPrefix;
  idleTimeout?: number;
  directTools?: boolean;
  disableProxyTool?: boolean;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
  settings?: McpSettings;
}

export interface McpMergedConfig {
  merged: McpConfigFile;
  provenance: Map<string, McpScope>;
}

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name) && name.length <= 64;
}

export function getMcpConfigPath(scope: McpScope, cwd?: string): string {
  if (scope === 'user') return join(getAgentDir(), 'mcp.json');
  if (!cwd) throw new Error('project scope requires cwd');
  return join(getProjectStateDir(cwd), 'mcp.json');
}

export function loadMcpConfig(scope: McpScope, cwd?: string): McpConfigFile {
  const path = getMcpConfigPath(scope, cwd);
  if (!existsSync(path)) return { mcpServers: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return normalize(raw);
  } catch {
    return { mcpServers: {} };
  }
}

export function saveMcpConfig(scope: McpScope, config: McpConfigFile, cwd?: string): void {
  const path = getMcpConfigPath(scope, cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function addMcpServer(
  scope: McpScope,
  name: string,
  server: McpServerConfig,
  cwd?: string,
): void {
  if (!isValidServerName(name)) {
    throw new Error(`invalid server name "${name}" (must match ${SERVER_NAME_RE.source})`);
  }
  const config = loadMcpConfig(scope, cwd);
  config.mcpServers = { ...config.mcpServers, [name]: server };
  saveMcpConfig(scope, config, cwd);
}

export function removeMcpServer(scope: McpScope, name: string, cwd?: string): boolean {
  const config = loadMcpConfig(scope, cwd);
  if (!config.mcpServers[name]) return false;
  delete config.mcpServers[name];
  saveMcpConfig(scope, config, cwd);
  return true;
}

/**
 * Merge user and project configs. Project entries win on per-server name
 * collisions; settings shallow-merge with project winning per key.
 */
export function loadMergedConfig(cwd: string): McpMergedConfig {
  const user = loadMcpConfig('user');
  const project = loadMcpConfig('project', cwd);

  const provenance = new Map<string, McpScope>();
  for (const name of Object.keys(user.mcpServers)) provenance.set(name, 'user');
  for (const name of Object.keys(project.mcpServers)) provenance.set(name, 'project');

  const merged: McpConfigFile = {
    mcpServers: { ...user.mcpServers, ...project.mcpServers },
    settings: { ...user.settings, ...project.settings },
  };
  if (merged.settings && Object.keys(merged.settings).length === 0) delete merged.settings;

  // Interpolate ${VAR} in env and headers from process.env.
  for (const [name, cfg] of Object.entries(merged.mcpServers)) {
    merged.mcpServers[name] = interpolateEnvVars(cfg);
  }

  return { merged, provenance };
}

function interpolateEnvVars(cfg: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...cfg };
  if (cfg.env) out.env = mapValues(cfg.env, interpolate);
  if (cfg.headers) out.headers = mapValues(cfg.headers, interpolate);
  return out;
}

function mapValues(rec: Record<string, string>, fn: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = fn(v);
  return out;
}

function interpolate(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
}

function normalize(raw: unknown): McpConfigFile {
  if (!raw || typeof raw !== 'object') return { mcpServers: {} };
  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers;
  const parsedServers =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, McpServerConfig>)
      : {};
  const settings =
    obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)
      ? (obj.settings as McpSettings)
      : undefined;
  return settings ? { mcpServers: parsedServers, settings } : { mcpServers: parsedServers };
}
