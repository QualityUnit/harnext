import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

import {
  computeServerConfigHash,
  isServerCacheValid,
  loadMcpCache,
  saveMcpCache,
  type CachedMcpTool,
  type MetadataCache,
  type ServerCacheEntry,
} from './mcp-cache.js';
import type { McpConfigFile } from './mcp-config.js';
import { normalizeMcpContent } from './mcp-direct-tool.js';
import type { McpServerManager } from './mcp-server-manager.js';

const proxySchema = Type.Object({
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal('list'),
        Type.Literal('search'),
        Type.Literal('describe'),
        Type.Literal('call'),
        Type.Literal('connect'),
        Type.Literal('status'),
      ],
      { description: 'Which sub-action to run. Defaults to "status" when omitted.' },
    ),
  ),
  server: Type.Optional(Type.String({ description: 'Server name (e.g. "chrome-devtools")' })),
  tool: Type.Optional(Type.String({ description: 'MCP tool name to call or describe' })),
  args: Type.Optional(
    Type.String({ description: 'JSON-stringified arguments for the tool call' }),
  ),
  query: Type.Optional(Type.String({ description: 'Search query for action=search' })),
});

export type McpProxyParams = Static<typeof proxySchema>;

export interface McpProxyToolDetails {
  action: string;
  server?: string;
  tool?: string;
}

export interface CreateMcpProxyToolOptions {
  cwd: string;
  manager: McpServerManager;
  getConfig: () => McpConfigFile;
  getCache: () => MetadataCache;
}

export function createMcpProxyTool(
  opts: CreateMcpProxyToolOptions,
): AgentTool<typeof proxySchema, McpProxyToolDetails> {
  return {
    name: 'mcp',
    label: 'MCP',
    description: buildProxyDescription(opts),
    parameters: proxySchema,
    async execute(_toolCallId, params, signal) {
      const action = params.action ?? (params.tool ? 'call' : params.query ? 'search' : 'status');
      switch (action) {
        case 'list':
          return textResult(renderList(opts), { action });
        case 'search':
          return textResult(renderSearch(opts, params.query ?? ''), { action });
        case 'describe':
          if (!params.tool) throw new Error('describe requires "tool"');
          return textResult(renderDescribe(opts, params.server, params.tool), {
            action,
            server: params.server,
            tool: params.tool,
          });
        case 'connect':
          if (!params.server) throw new Error('connect requires "server"');
          return textResult(await runConnect(opts, params.server), {
            action,
            server: params.server,
          });
        case 'call':
          if (!params.tool) throw new Error('call requires "tool"');
          return runCall(opts, params, signal);
        case 'status':
        default:
          return textResult(renderStatus(opts), { action: 'status' });
      }
    },
  };
}

function textResult(
  text: string,
  details: McpProxyToolDetails,
): { content: Array<{ type: 'text'; text: string }>; details: McpProxyToolDetails } {
  return { content: [{ type: 'text', text }], details };
}

function buildProxyDescription(opts: CreateMcpProxyToolOptions): string {
  const cfg = opts.getConfig();
  const cache = opts.getCache();
  const names = Object.keys(cfg.mcpServers);
  const lines = [
    'Call MCP (Model Context Protocol) servers through a single proxy.',
    '',
    'Actions (pass as `action`):',
    '  - list: enumerate configured servers and their tools.',
    '  - search: fuzzy-match tools by name/description (pass `query`).',
    '  - describe: show the JSON schema of a tool (pass `tool`, optionally `server`).',
    '  - connect: spawn a server now and refresh its metadata (pass `server`).',
    '  - call: invoke a tool (pass `tool`, `args` as JSON string, optionally `server`).',
    '  - status: summary of configured servers (default).',
  ];
  if (names.length > 0) {
    lines.push('', 'Configured servers:');
    for (const name of names) {
      const entry = cache.servers[name];
      const count = entry ? entry.tools.length : null;
      const transport = cfg.mcpServers[name].url ? 'http' : 'stdio';
      lines.push(
        `  - ${name} (${transport}): ${count == null ? 'indexing on first use' : `${count} tools cached`}`,
      );
    }
  } else {
    lines.push('', 'No MCP servers configured. Run `harnext mcp add <name> -- <command> [...]`.');
  }
  return lines.join('\n');
}

function renderStatus(opts: CreateMcpProxyToolOptions): string {
  const cfg = opts.getConfig();
  const cache = opts.getCache();
  const names = Object.keys(cfg.mcpServers);
  if (names.length === 0) return 'No MCP servers configured.';
  return names
    .map((n) => {
      const entry = cache.servers[n];
      const transport = cfg.mcpServers[n].url ? 'http' : 'stdio';
      const conn = opts.manager.status(n);
      const count = entry ? `${entry.tools.length} tools` : 'not indexed';
      return `- ${n} [${transport}, ${conn}] ${count}`;
    })
    .join('\n');
}

function renderList(opts: CreateMcpProxyToolOptions): string {
  const cfg = opts.getConfig();
  const cache = opts.getCache();
  const names = Object.keys(cfg.mcpServers);
  if (names.length === 0) return 'No MCP servers configured.';
  const out: string[] = [];
  for (const name of names) {
    const entry = cache.servers[name];
    out.push(`\n# ${name}`);
    if (!entry) {
      out.push('  (not indexed — run action=connect to populate)');
      continue;
    }
    for (const t of entry.tools) {
      const desc = t.description ? ` — ${truncate(t.description, 120)}` : '';
      out.push(`  - ${t.name}${desc}`);
    }
  }
  return out.join('\n').trim();
}

function renderSearch(opts: CreateMcpProxyToolOptions, query: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return 'Provide a `query`.';
  const cache = opts.getCache();
  const hits: Array<{ server: string; tool: CachedMcpTool; score: number }> = [];
  for (const [server, entry] of Object.entries(cache.servers)) {
    for (const tool of entry.tools) {
      const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      let score = 0;
      if (tool.name.toLowerCase().includes(q)) score += 10;
      if (hay.includes(q)) score += 5;
      for (const word of q.split(/\s+/)) {
        if (word && hay.includes(word)) score += 1;
      }
      if (score > 0) hits.push({ server, tool, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) return `No cached matches for "${query}". Try action=connect first.`;
  return hits
    .slice(0, 20)
    .map((h) => `- ${h.server}/${h.tool.name}${h.tool.description ? ` — ${truncate(h.tool.description, 120)}` : ''}`)
    .join('\n');
}

function renderDescribe(
  opts: CreateMcpProxyToolOptions,
  server: string | undefined,
  toolName: string,
): string {
  const cache = opts.getCache();
  const candidates: Array<{ server: string; tool: CachedMcpTool }> = [];
  for (const [s, entry] of Object.entries(cache.servers)) {
    if (server && s !== server) continue;
    for (const tool of entry.tools) {
      if (tool.name === toolName) candidates.push({ server: s, tool });
    }
  }
  if (candidates.length === 0) {
    return `Tool "${toolName}" not found in cache${server ? ` for server "${server}"` : ''}. Try action=connect.`;
  }
  if (candidates.length > 1 && !server) {
    return (
      `Tool "${toolName}" exists on multiple servers: ` +
      candidates.map((c) => c.server).join(', ') +
      '. Specify `server`.'
    );
  }
  const pick = candidates[0];
  const parts = [
    `# ${pick.server}/${pick.tool.name}`,
    pick.tool.description ? `\n${pick.tool.description}` : '',
    '\nSchema:',
    '```json',
    JSON.stringify(pick.tool.inputSchema ?? { type: 'object' }, null, 2),
    '```',
  ];
  return parts.join('\n');
}

async function runConnect(opts: CreateMcpProxyToolOptions, server: string): Promise<string> {
  const cfg = opts.getConfig().mcpServers[server];
  if (!cfg) return `Unknown server "${server}". Configured: ${Object.keys(opts.getConfig().mcpServers).join(', ') || 'none'}.`;
  await opts.manager.connect(server, cfg);
  const tools = await opts.manager.listTools(server, cfg);
  const entry: ServerCacheEntry = {
    configHash: computeServerConfigHash(cfg),
    cachedAt: Date.now(),
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
  saveMcpCache({ servers: { [server]: entry } });
  const fresh = loadMcpCache();
  Object.assign(opts.getCache(), fresh);
  return `Connected to "${server}"; cached ${tools.length} tools.`;
}

async function runCall(
  opts: CreateMcpProxyToolOptions,
  params: McpProxyParams,
  signal?: AbortSignal,
): Promise<{
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  details: McpProxyToolDetails;
}> {
  const cfgs = opts.getConfig().mcpServers;
  const toolName = params.tool!;
  let serverName = params.server;
  if (!serverName) {
    const matches = findServersForTool(opts, toolName);
    if (matches.length === 0) {
      throw new Error(`Tool "${toolName}" not found in cache. Specify "server" or run action=connect.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Tool "${toolName}" exists on multiple servers: ${matches.join(', ')}. Specify "server".`,
      );
    }
    serverName = matches[0];
  }
  const cfg = cfgs[serverName];
  if (!cfg) throw new Error(`Unknown server "${serverName}"`);

  let toolArgs: unknown = {};
  if (params.args) {
    try {
      toolArgs = JSON.parse(params.args);
    } catch (e) {
      throw new Error(`"args" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const result = await opts.manager.callTool(serverName, cfg, toolName, toolArgs, signal);
  const content = normalizeMcpContent(result.content);
  if (result.isError) {
    const text = content
      .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
      .join('\n')
      .trim();
    throw new Error(text || `mcp tool "${toolName}" failed`);
  }

  // Refresh cache opportunistically if stale.
  const cache = opts.getCache();
  const entry = cache.servers[serverName];
  if (!entry || !isServerCacheValid(entry, cfg)) {
    void opts.manager
      .listTools(serverName, cfg)
      .then((tools) => {
        saveMcpCache({
          servers: {
            [serverName!]: {
              configHash: computeServerConfigHash(cfg),
              cachedAt: Date.now(),
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
            },
          },
        });
      })
      .catch(() => {});
  }

  return { content, details: { action: 'call', server: serverName, tool: toolName } };
}

function findServersForTool(opts: CreateMcpProxyToolOptions, toolName: string): string[] {
  const out: string[] = [];
  for (const [server, entry] of Object.entries(opts.getCache().servers)) {
    if (entry.tools.some((t) => t.name === toolName)) out.push(server);
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
