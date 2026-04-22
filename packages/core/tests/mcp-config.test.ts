import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAgentDir, getProjectStateDir } from '../src/config.js';
import {
  addMcpServer,
  getMcpConfigPath,
  isValidServerName,
  loadMcpConfig,
  loadMergedConfig,
  removeMcpServer,
  saveMcpConfig,
} from '../src/mcp-config.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-mcp-config-'));
  process.env.HARNEXT_HOME = harnextHome;
});
afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

describe('isValidServerName', () => {
  it('accepts simple names', () => {
    expect(isValidServerName('chrome-devtools')).toBe(true);
    expect(isValidServerName('a')).toBe(true);
    expect(isValidServerName('a1b2')).toBe(true);
  });
  it('rejects invalid names', () => {
    expect(isValidServerName('Chrome')).toBe(false);
    expect(isValidServerName('-leading')).toBe(false);
    expect(isValidServerName('bad name')).toBe(false);
    expect(isValidServerName('')).toBe(false);
    expect(isValidServerName('a'.repeat(65))).toBe(false);
  });
});

describe('loadMcpConfig / saveMcpConfig', () => {
  beforeEach(() => {
    rmSync(getAgentDir(), { recursive: true, force: true });
  });

  it('returns empty config when file is missing', () => {
    expect(loadMcpConfig('user')).toEqual({ mcpServers: {} });
  });

  it('round-trips a config', () => {
    saveMcpConfig('user', {
      mcpServers: { foo: { command: 'echo', args: ['hi'] } },
      settings: { toolPrefix: 'short' },
    });
    const loaded = loadMcpConfig('user');
    expect(loaded.mcpServers.foo).toEqual({ command: 'echo', args: ['hi'] });
    expect(loaded.settings?.toolPrefix).toBe('short');
  });

  it('tolerates malformed JSON by returning empty', () => {
    const path = getMcpConfigPath('user');
    mkdirSync(getAgentDir(), { recursive: true });
    writeFileSync(path, '{ not json');
    expect(loadMcpConfig('user')).toEqual({ mcpServers: {} });
  });
});

describe('addMcpServer / removeMcpServer', () => {
  beforeEach(() => {
    rmSync(getAgentDir(), { recursive: true, force: true });
  });

  it('rejects invalid names', () => {
    expect(() => addMcpServer('user', 'BAD', { command: 'x' })).toThrow(/invalid server name/);
  });

  it('adds and removes', () => {
    addMcpServer('user', 'foo', { command: 'x' });
    expect(loadMcpConfig('user').mcpServers.foo).toBeDefined();
    expect(removeMcpServer('user', 'foo')).toBe(true);
    expect(loadMcpConfig('user').mcpServers.foo).toBeUndefined();
    expect(removeMcpServer('user', 'foo')).toBe(false);
  });
});

describe('loadMergedConfig', () => {
  let cwd: string;
  beforeEach(() => {
    rmSync(getAgentDir(), { recursive: true, force: true });
    cwd = mkdtempSync(join(tmpdir(), 'mcp-merged-cwd-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(getProjectStateDir(cwd), { recursive: true, force: true });
  });

  it('merges user + project with project winning on collisions', () => {
    saveMcpConfig('user', {
      mcpServers: {
        shared: { command: 'user-cmd' },
        onlyUser: { command: 'u' },
      },
      settings: { toolPrefix: 'server', idleTimeout: 5 },
    });
    saveMcpConfig(
      'project',
      {
        mcpServers: {
          shared: { command: 'project-cmd' },
          onlyProject: { command: 'p' },
        },
        settings: { idleTimeout: 20 },
      },
      cwd,
    );
    const { merged, provenance } = loadMergedConfig(cwd);
    expect(merged.mcpServers.shared.command).toBe('project-cmd');
    expect(merged.mcpServers.onlyUser.command).toBe('u');
    expect(merged.mcpServers.onlyProject.command).toBe('p');
    expect(provenance.get('shared')).toBe('project');
    expect(provenance.get('onlyUser')).toBe('user');
    expect(provenance.get('onlyProject')).toBe('project');
    expect(merged.settings?.idleTimeout).toBe(20);
    expect(merged.settings?.toolPrefix).toBe('server');
  });

  it('interpolates ${VAR} in env and headers', () => {
    process.env.__MCP_TEST_TOKEN = 'secret';
    saveMcpConfig('user', {
      mcpServers: {
        s: {
          url: 'https://x',
          headers: { Authorization: 'Bearer ${__MCP_TEST_TOKEN}' },
          env: { T: '${__MCP_TEST_TOKEN}' },
        },
      },
    });
    const { merged } = loadMergedConfig(cwd);
    expect(merged.mcpServers.s.headers?.Authorization).toBe('Bearer secret');
    expect(merged.mcpServers.s.env?.T).toBe('secret');
    delete process.env.__MCP_TEST_TOKEN;
  });
});

describe('getMcpConfigPath', () => {
  it('user scope lives under agent dir', () => {
    expect(getMcpConfigPath('user')).toBe(join(getAgentDir(), 'mcp.json'));
  });
  it('project scope requires cwd', () => {
    expect(() => getMcpConfigPath('project')).toThrow(/cwd/);
    const cwd = mkdtempSync(join(tmpdir(), 'mcp-path-'));
    const path = getMcpConfigPath('project', cwd);
    expect(path.endsWith('/mcp.json')).toBe(true);
    expect(path.startsWith(harnextHome)).toBe(true);
    expect(path).toContain('/projects/');
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('file permissions', () => {
  it('writes with mode 0600', () => {
    rmSync(getAgentDir(), { recursive: true, force: true });
    saveMcpConfig('user', { mcpServers: { a: { command: 'x' } } });
    const content = readFileSync(getMcpConfigPath('user'), 'utf8');
    expect(JSON.parse(content).mcpServers.a.command).toBe('x');
  });
});
