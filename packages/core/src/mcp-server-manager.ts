import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpServerConfig } from './mcp-config.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
}

interface Connection {
  client: Client;
  transport: { close(): Promise<void> } & Record<string, unknown>;
}

const DEFAULT_IDLE_MINUTES = 10;
const CLIENT_INFO = { name: 'harnext', version: '0.1.0' } as const;

export class McpServerManager {
  private connections = new Map<string, Connection>();
  private connectPromises = new Map<string, Promise<Connection>>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private globalIdleMinutes = DEFAULT_IDLE_MINUTES;

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleMinutes = Math.max(1, minutes);
  }

  status(name: string): 'connected' | 'closed' {
    return this.connections.has(name) ? 'connected' : 'closed';
  }

  async connect(name: string, cfg: McpServerConfig): Promise<Connection> {
    const existing = this.connections.get(name);
    if (existing) return existing;

    const pending = this.connectPromises.get(name);
    if (pending) return pending;

    const promise = this.doConnect(name, cfg).finally(() => {
      this.connectPromises.delete(name);
    });
    this.connectPromises.set(name, promise);
    return promise;
  }

  private async doConnect(name: string, cfg: McpServerConfig): Promise<Connection> {
    const client = new Client(CLIENT_INFO, { capabilities: {} });

    let transport: Connection['transport'];
    if (cfg.url) {
      transport = await connectHttp(client, cfg);
    } else if (cfg.command) {
      transport = await connectStdio(client, cfg);
    } else {
      throw new Error(`mcp server "${name}" has neither command nor url`);
    }

    const conn: Connection = { client, transport };
    this.connections.set(name, conn);

    if (cfg.lifecycle === 'keep-alive') {
      (client as unknown as { onclose?: () => void }).onclose = () => {
        if (this.connections.get(name) === conn) {
          this.connections.delete(name);
          void this.connect(name, cfg).catch(() => {});
        }
      };
    } else {
      (client as unknown as { onclose?: () => void }).onclose = () => {
        if (this.connections.get(name) === conn) this.connections.delete(name);
      };
    }

    return conn;
  }

  async listTools(name: string, cfg: McpServerConfig): Promise<McpTool[]> {
    const { client } = await this.connect(name, cfg);
    const res = await client.listTools();
    const tools = (res.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>;
    this.resetIdleTimer(name, cfg);
    const exclude = new Set(cfg.excludeTools ?? []);
    return tools
      .filter((t) => !exclude.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async callTool(
    name: string,
    cfg: McpServerConfig,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const { client } = await this.connect(name, cfg);
    const params = { name: tool, arguments: (args ?? {}) as Record<string, unknown> };
    const options = signal ? { signal } : undefined;
    const result = (await client.callTool(params, undefined, options)) as {
      content?: unknown[];
      isError?: boolean;
    };
    this.resetIdleTimer(name, cfg);
    return { content: result.content ?? [], isError: result.isError };
  }

  async disconnect(name: string): Promise<void> {
    const timer = this.idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(name);
    }
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      /* swallow */
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  private resetIdleTimer(name: string, cfg: McpServerConfig): void {
    const prev = this.idleTimers.get(name);
    if (prev) clearTimeout(prev);
    if (cfg.lifecycle === 'keep-alive') return;
    const minutes = cfg.idleTimeout ?? this.globalIdleMinutes;
    const ms = minutes * 60 * 1000;
    const timer = setTimeout(() => {
      this.idleTimers.delete(name);
      void this.disconnect(name).catch(() => {});
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this.idleTimers.set(name, timer);
  }
}

async function connectStdio(client: Client, cfg: McpServerConfig): Promise<Connection['transport']> {
  if (!cfg.command) throw new Error('stdio transport requires command');
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env ? { ...process.env, ...cfg.env } as Record<string, string> : undefined,
    cwd: cfg.cwd,
    stderr: cfg.debug ? 'inherit' : 'ignore',
  });
  await client.connect(transport);
  return transport as unknown as Connection['transport'];
}

async function connectHttp(client: Client, cfg: McpServerConfig): Promise<Connection['transport']> {
  if (!cfg.url) throw new Error('http transport requires url');
  const url = new URL(cfg.url);
  const requestInit = cfg.headers ? { headers: { ...cfg.headers } } : undefined;

  try {
    const transport = new StreamableHTTPClientTransport(url, { requestInit });
    await client.connect(transport);
    return transport as unknown as Connection['transport'];
  } catch (streamErr) {
    try {
      const sse = new SSEClientTransport(url, { requestInit });
      await client.connect(sse);
      return sse as unknown as Connection['transport'];
    } catch (sseErr) {
      const streamMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      const sseMsg = sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(`http connect failed: streamable=${streamMsg}; sse=${sseMsg}`);
    }
  }
}
