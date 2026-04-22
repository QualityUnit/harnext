import { describe, expect, it } from 'vitest';

import { normalizeMcpContent, prefixedName, wrapMcpToolAsAgentTool } from '../src/mcp-direct-tool.js';
import type { McpServerManager, McpToolResult } from '../src/mcp-server-manager.js';

describe('prefixedName', () => {
  it('server prefix by default', () => {
    expect(prefixedName('chrome-devtools', 'take_screenshot')).toBe('chrome_devtools_take_screenshot');
  });
  it('short strips -mcp suffix', () => {
    expect(prefixedName('foo-mcp', 'bar', 'short')).toBe('foo_bar');
  });
  it('none uses raw tool name', () => {
    expect(prefixedName('whatever', 'bar', 'none')).toBe('bar');
  });
});

describe('normalizeMcpContent', () => {
  it('passes through text blocks', () => {
    expect(normalizeMcpContent([{ type: 'text', text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('falls back to stringified unknown blocks', () => {
    expect(normalizeMcpContent([{ type: 'weird', payload: 1 }])).toEqual([
      { type: 'text', text: '{"type":"weird","payload":1}' },
    ]);
  });
  it('handles non-array input', () => {
    expect(normalizeMcpContent(null)).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('wrapMcpToolAsAgentTool', () => {
  it('calls manager.callTool and returns normalized content', async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const manager = {
      async callTool(_name: string, _cfg: unknown, tool: string, args: unknown): Promise<McpToolResult> {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    } as unknown as McpServerManager;

    const cfg = { command: 'x' };
    const wrapped = wrapMcpToolAsAgentTool(
      'foo',
      { name: 'bar', description: 'demo' },
      () => cfg,
      manager,
    );
    expect(wrapped.name).toBe('foo_bar');
    expect(wrapped.label).toBe('foo/bar');
    const result = await wrapped.execute('id', { x: 1 } as unknown as never);
    expect(calls).toEqual([{ tool: 'bar', args: { x: 1 } }]);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.details.serverName).toBe('foo');
  });

  it('throws when isError is set', async () => {
    const manager = {
      async callTool(): Promise<McpToolResult> {
        return { content: [{ type: 'text', text: 'boom' }], isError: true };
      },
    } as unknown as McpServerManager;
    const wrapped = wrapMcpToolAsAgentTool('foo', { name: 'bar' }, () => ({ command: 'x' }), manager);
    await expect(wrapped.execute('id', {} as never)).rejects.toThrow(/boom/);
  });
});
