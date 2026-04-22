import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAgentDir } from '../src/config.js';
import { saveMcpCache, loadMcpCache } from '../src/mcp-cache.js';
import type { McpConfigFile } from '../src/mcp-config.js';
import { createMcpProxyTool } from '../src/mcp-proxy-tool.js';
import type { McpServerManager, McpTool, McpToolResult } from '../src/mcp-server-manager.js';

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;
beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-mcp-proxy-'));
  process.env.HARNEXT_HOME = harnextHome;
});
afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(getAgentDir(), { recursive: true, force: true });
});

class FakeManager {
  public connectedServers = new Set<string>();
  public calls: Array<{ name: string; tool: string; args: unknown }> = [];
  public tools: Record<string, McpTool[]> = {};
  public toolResults: Record<string, McpToolResult> = {};

  async connect(name: string): Promise<void> {
    this.connectedServers.add(name);
  }
  async listTools(name: string): Promise<McpTool[]> {
    return this.tools[name] ?? [];
  }
  async callTool(name: string, _cfg: unknown, tool: string, args: unknown): Promise<McpToolResult> {
    this.calls.push({ name, tool, args });
    return this.toolResults[`${name}:${tool}`] ?? { content: [{ type: 'text', text: 'ok' }] };
  }
  async disconnect(): Promise<void> {}
  async disconnectAll(): Promise<void> {}
  setGlobalIdleTimeout(): void {}
  status(name: string): 'connected' | 'closed' {
    return this.connectedServers.has(name) ? 'connected' : 'closed';
  }
}

function makeConfig(): McpConfigFile {
  return {
    mcpServers: {
      foo: { command: 'echo', args: ['hi'] },
    },
  };
}

describe('mcp proxy tool', () => {
  it('status lists configured servers', async () => {
    const manager = new FakeManager();
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    const result = await tool.execute('id', { action: 'status' });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('foo');
  });

  it('search finds cached tools by name', async () => {
    saveMcpCache({
      servers: {
        foo: {
          configHash: 'h',
          cachedAt: Date.now(),
          tools: [{ name: 'take_screenshot', description: 'capture a screenshot' }],
        },
      },
    });
    const manager = new FakeManager();
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    const result = await tool.execute('id', { action: 'search', query: 'screenshot' });
    expect((result.content[0] as { text: string }).text).toContain('take_screenshot');
  });

  it('describe returns the tool schema from cache', async () => {
    saveMcpCache({
      servers: {
        foo: {
          configHash: 'h',
          cachedAt: Date.now(),
          tools: [
            {
              name: 'do_thing',
              description: 'does a thing',
              inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
            },
          ],
        },
      },
    });
    const manager = new FakeManager();
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    const result = await tool.execute('id', { action: 'describe', tool: 'do_thing' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('do_thing');
    expect(text).toContain('"x"');
  });

  it('call invokes the manager and returns its content', async () => {
    saveMcpCache({
      servers: {
        foo: {
          configHash: 'h',
          cachedAt: Date.now(),
          tools: [{ name: 'greet' }],
        },
      },
    });
    const manager = new FakeManager();
    manager.toolResults['foo:greet'] = { content: [{ type: 'text', text: 'hello world' }] };
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    const result = await tool.execute('id', { action: 'call', tool: 'greet', args: '{"name":"x"}' });
    expect(manager.calls).toEqual([{ name: 'foo', tool: 'greet', args: { name: 'x' } }]);
    expect((result.content[0] as { text: string }).text).toBe('hello world');
  });

  it('call throws when args is malformed JSON', async () => {
    saveMcpCache({
      servers: {
        foo: {
          configHash: 'h',
          cachedAt: Date.now(),
          tools: [{ name: 'greet' }],
        },
      },
    });
    const manager = new FakeManager();
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    await expect(
      tool.execute('id', { action: 'call', tool: 'greet', args: 'not json' }),
    ).rejects.toThrow(/valid JSON/);
  });

  it('connect populates the cache and reports count', async () => {
    const manager = new FakeManager();
    manager.tools.foo = [{ name: 't1' }, { name: 't2' }];
    const cfg = makeConfig();
    const tool = createMcpProxyTool({
      cwd: process.cwd(),
      manager: manager as unknown as McpServerManager,
      getConfig: () => cfg,
      getCache: () => loadMcpCache(),
    });
    const result = await tool.execute('id', { action: 'connect', server: 'foo' });
    expect((result.content[0] as { text: string }).text).toContain('2 tools');
    const cached = loadMcpCache().servers.foo;
    expect(cached.tools.map((t) => t.name)).toEqual(['t1', 't2']);
  });
});
