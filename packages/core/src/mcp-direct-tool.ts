import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@sinclair/typebox';

import type { McpServerConfig, McpToolPrefix } from './mcp-config.js';
import type { McpServerManager, McpTool } from './mcp-server-manager.js';

export interface DirectToolDetails {
  serverName: string;
}

export function prefixedName(
  serverName: string,
  toolName: string,
  prefix: McpToolPrefix = 'server',
): string {
  if (prefix === 'none') return sanitize(toolName);
  if (prefix === 'short') return sanitize(stripMcpSuffix(serverName)) + '_' + sanitize(toolName);
  return sanitize(serverName) + '_' + sanitize(toolName);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

function stripMcpSuffix(name: string): string {
  return name.replace(/-mcp$/i, '');
}

export function normalizeMcpContent(
  raw: unknown,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (!Array.isArray(raw)) return [{ type: 'text', text: '' }];
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it.type === 'text' && typeof it.text === 'string') {
      out.push({ type: 'text', text: it.text });
    } else if (it.type === 'image' && typeof it.data === 'string' && typeof it.mimeType === 'string') {
      out.push({ type: 'image', data: it.data, mimeType: it.mimeType });
    } else if (typeof it.text === 'string') {
      out.push({ type: 'text', text: it.text });
    } else {
      out.push({ type: 'text', text: JSON.stringify(it) });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

export function wrapMcpToolAsAgentTool(
  serverName: string,
  tool: McpTool,
  getCfg: () => McpServerConfig,
  manager: McpServerManager,
  prefix: McpToolPrefix = 'server',
): AgentTool<TSchema, DirectToolDetails> {
  const name = prefixedName(serverName, tool.name, prefix);
  const inputSchema = (tool.inputSchema as TSchema | undefined) ?? Type.Object({});
  const schema = Type.Unsafe<unknown>(inputSchema as object);

  return {
    name,
    label: `${serverName}/${tool.name}`,
    description: tool.description ?? `Tool "${tool.name}" from MCP server "${serverName}"`,
    parameters: schema,
    async execute(_toolCallId, params, signal) {
      const result = await manager.callTool(serverName, getCfg(), tool.name, params, signal);
      const content = normalizeMcpContent(result.content);
      if (result.isError) {
        const text = content
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('\n')
          .trim();
        throw new Error(text || `mcp tool "${tool.name}" failed`);
      }
      return { content, details: { serverName } };
    },
  };
}
