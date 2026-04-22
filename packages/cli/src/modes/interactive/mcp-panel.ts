import { createInterface } from 'node:readline';

import {
  McpServerManager,
  addMcpServer,
  computeServerConfigHash,
  isValidServerName,
  loadMcpCache,
  loadMergedConfig,
  removeMcpServer,
  saveMcpCache,
  type McpScope,
  type McpServerConfig,
} from '@harnext/core';
import chalk from 'chalk';

import { select } from '../../cli/select.js';
import type { SelectItem } from '../../cli/select.js';

type Action = 'list' | 'add' | 'remove' | 'reconnect' | 'cancel';

export async function runMcpPanel(cwd: string): Promise<void> {
  const action = await select<Action>(
    [
      { label: 'List servers', value: 'list' },
      { label: 'Add server', value: 'add' },
      { label: 'Remove server', value: 'remove' },
      { label: 'Reconnect server (refresh tools)', value: 'reconnect' },
      { label: 'Cancel', value: 'cancel' },
    ] as SelectItem<Action>[],
    { title: 'MCP — what do you want to do?' },
  );
  if (!action || action === 'cancel') {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  switch (action) {
    case 'list':
      listServers(cwd);
      return;
    case 'add':
      await addServer(cwd);
      return;
    case 'remove':
      await removeServer(cwd);
      return;
    case 'reconnect':
      await reconnectServer(cwd);
      return;
  }
}

function listServers(cwd: string): void {
  const { merged, provenance } = loadMergedConfig(cwd);
  const cache = loadMcpCache();
  const names = Object.keys(merged.mcpServers).sort();
  console.log();
  if (names.length === 0) {
    console.log(chalk.dim('  No MCP servers configured.'));
    console.log();
    return;
  }
  console.log(chalk.bold(`  MCP servers (${names.length}):`));
  for (const name of names) {
    const cfg = merged.mcpServers[name];
    const src = provenance.get(name) ?? 'user';
    const transport = cfg.url ? 'http' : 'stdio';
    const entry = cache.servers[name];
    const toolsInfo = entry ? `${entry.tools.length} tools cached` : 'not indexed';
    const summary = cfg.url
      ? cfg.url
      : `${cfg.command ?? ''}${cfg.args ? ' ' + cfg.args.join(' ') : ''}`;
    console.log(
      `  - ${chalk.cyan(name)} ${chalk.dim(`[${transport}, ${src}]`)} ${chalk.dim(toolsInfo)}`,
    );
    console.log(`      ${chalk.dim(summary)}`);
  }
  console.log();
}

async function addServer(cwd: string): Promise<void> {
  const name = (await promptLine('Server name (lowercase, digits, hyphens):')).trim();
  if (!name) return cancel();
  if (!isValidServerName(name)) {
    console.log(chalk.red(`  Invalid name "${name}". Use lowercase letters, digits, hyphens.`));
    console.log();
    return;
  }

  const scope = await select<McpScope>(
    [
      { label: 'User (~/.harnext/agent/mcp.json)', value: 'user' },
      { label: 'Project (~/.harnext/projects/<hash>/mcp.json)', value: 'project' },
    ] as SelectItem<McpScope>[],
    { title: 'Scope?' },
  );
  if (!scope) return cancel();

  const transport = await select<'stdio' | 'http'>(
    [
      { label: 'stdio (local command)', value: 'stdio' },
      { label: 'http (streamable / SSE)', value: 'http' },
    ] as SelectItem<'stdio' | 'http'>[],
    { title: 'Transport?' },
  );
  if (!transport) return cancel();

  const cfg: McpServerConfig = {};
  if (transport === 'stdio') {
    const line = (await promptLine('Command and args (e.g. `npx -y some-mcp@latest`):')).trim();
    if (!line) return cancel();
    const parts = line.split(/\s+/);
    cfg.command = parts[0];
    if (parts.length > 1) cfg.args = parts.slice(1);
  } else {
    const url = (await promptLine('URL:')).trim();
    if (!url) return cancel();
    cfg.url = url;
    const headerBlob = (await promptLine('Headers (one per line as "Key: Value", blank to skip):')).trim();
    if (headerBlob) {
      const headers: Record<string, string> = {};
      for (const line of headerBlob.split(/\n+/)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (Object.keys(headers).length > 0) cfg.headers = headers;
    }
  }

  try {
    addMcpServer(scope, name, cfg, cwd);
    console.log(chalk.green(`  Added MCP server "${name}" to ${scope} scope.`));
    console.log(
      chalk.dim('  The proxy tool will pick it up on the next prompt. Run reconnect now to index its tools.'),
    );
    console.log();
  } catch (err) {
    console.log(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    console.log();
  }
}

async function removeServer(cwd: string): Promise<void> {
  const { merged, provenance } = loadMergedConfig(cwd);
  const names = Object.keys(merged.mcpServers).sort();
  if (names.length === 0) {
    console.log(chalk.dim('  No servers to remove.'));
    console.log();
    return;
  }
  const items: SelectItem<{ name: string; scope: McpScope }>[] = names.map((n) => ({
    label: `${n} (${provenance.get(n) ?? 'user'})`,
    value: { name: n, scope: provenance.get(n) ?? 'user' },
  }));
  const picked = await select(items, { title: 'Remove which server?' });
  if (!picked) return cancel();
  const ok = removeMcpServer(picked.scope, picked.name, cwd);
  console.log(
    ok
      ? chalk.green(`  Removed "${picked.name}" from ${picked.scope} scope.`)
      : chalk.yellow(`  "${picked.name}" not found in ${picked.scope} scope.`),
  );
  console.log();
}

async function reconnectServer(cwd: string): Promise<void> {
  const { merged } = loadMergedConfig(cwd);
  const names = Object.keys(merged.mcpServers).sort();
  if (names.length === 0) {
    console.log(chalk.dim('  No servers to reconnect.'));
    console.log();
    return;
  }
  const picked = await select(
    names.map((n) => ({ label: n, value: n })),
    { title: 'Reconnect which server?' },
  );
  if (!picked) return cancel();
  const cfg = merged.mcpServers[picked];
  const manager = new McpServerManager();
  try {
    console.log(chalk.dim(`  Connecting to "${picked}"...`));
    await manager.connect(picked, cfg);
    const tools = await manager.listTools(picked, cfg);
    saveMcpCache({
      servers: {
        [picked]: {
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
    console.log(chalk.green(`  Cached ${tools.length} tools from "${picked}".`));
    console.log();
  } catch (err) {
    console.log(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}`));
    console.log();
  } finally {
    await manager.disconnectAll();
  }
}

function cancel(): void {
  console.log(chalk.dim('  Cancelled.'));
  console.log();
}

async function promptLine(title: string): Promise<string> {
  console.log();
  console.log(chalk.bold('  ' + title));
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  > ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
