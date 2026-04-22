import {
  McpServerManager,
  addMcpServer,
  computeServerConfigHash,
  isValidServerName,
  loadMcpCache,
  loadMcpConfig,
  loadMergedConfig,
  removeMcpServer,
  saveMcpCache,
  type McpScope,
  type McpServerConfig,
} from '@harnext/core';
import chalk from 'chalk';

import type { Args } from '../cli/args.js';
import { printMcpHelp } from '../cli/args.js';

export async function runMcpMode(args: Args): Promise<number> {
  if (!args.mcpVerb) {
    console.error(chalk.red('Error: mcp requires a verb (add, remove, list, reconnect)'));
    printMcpHelp();
    return 1;
  }

  const scope: McpScope = args.mcpScope ?? 'user';

  switch (args.mcpVerb) {
    case 'add':
      return verbAdd(args, scope);
    case 'remove':
      return verbRemove(args, scope);
    case 'list':
      return verbList(args);
    case 'reconnect':
      return verbReconnect(args);
    default:
      console.error(chalk.red(`Unknown mcp verb: ${args.mcpVerb}`));
      printMcpHelp();
      return 1;
  }
}

function verbAdd(args: Args, scope: McpScope): number {
  const name = args.mcpName;
  if (!name) {
    console.error(chalk.red('Error: `mcp add` requires a server name'));
    return 1;
  }
  if (!isValidServerName(name)) {
    console.error(chalk.red(`Error: invalid server name "${name}" (use lowercase letters, digits, hyphens; max 64 chars)`));
    return 1;
  }

  const cfg: McpServerConfig = {};
  if (args.mcpUrl) {
    cfg.url = args.mcpUrl;
    if (args.mcpHeaders && args.mcpHeaders.length > 0) {
      const headers: Record<string, string> = {};
      for (const h of args.mcpHeaders) {
        const idx = h.indexOf(':');
        if (idx === -1) {
          console.error(chalk.red(`Error: malformed header "${h}" (expected "Key: Value")`));
          return 1;
        }
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
      cfg.headers = headers;
    }
  } else if (args.mcpCommandArgs && args.mcpCommandArgs.length > 0) {
    cfg.command = args.mcpCommandArgs[0];
    if (args.mcpCommandArgs.length > 1) cfg.args = args.mcpCommandArgs.slice(1);
  } else {
    console.error(chalk.red('Error: `mcp add` requires either --url or `-- <command> [args...]`'));
    return 1;
  }
  if (args.mcpLifecycle) cfg.lifecycle = args.mcpLifecycle;
  if (args.mcpDirect) cfg.directTools = true;

  try {
    addMcpServer(scope, name, cfg, args.cwd);
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  console.log(chalk.green(`Added MCP server "${name}" to ${scope} scope.`));
  console.log(chalk.dim('  Run `harnext mcp reconnect ' + name + '` to index its tools.'));
  return 0;
}

function verbRemove(args: Args, scope: McpScope): number {
  const name = args.mcpName;
  if (!name) {
    console.error(chalk.red('Error: `mcp remove` requires a server name'));
    return 1;
  }
  const removed = removeMcpServer(scope, name, args.cwd);
  if (!removed) {
    console.error(chalk.yellow(`Server "${name}" not found in ${scope} scope.`));
    return 1;
  }
  console.log(chalk.green(`Removed MCP server "${name}" from ${scope} scope.`));
  return 0;
}

function verbList(args: Args): number {
  const { merged, provenance } = loadMergedConfig(args.cwd);
  const userCfg = loadMcpConfig('user');
  const projectCfg = loadMcpConfig('project', args.cwd);
  const cache = loadMcpCache();

  const names = Object.keys(merged.mcpServers).sort();
  if (names.length === 0) {
    console.log(chalk.dim('No MCP servers configured.'));
    console.log(chalk.dim('  User scope:    ~/.harnext/agent/mcp.json'));
    console.log(chalk.dim('  Project scope: ~/.harnext/projects/<hash>/mcp.json'));
    return 0;
  }

  console.log(chalk.bold(`MCP servers (${names.length}):`));
  for (const name of names) {
    const cfg = merged.mcpServers[name];
    const src = provenance.get(name) ?? 'user';
    const transport = cfg.url ? 'http' : 'stdio';
    const summary = cfg.url
      ? cfg.url
      : `${cfg.command ?? ''}${cfg.args ? ' ' + cfg.args.join(' ') : ''}`;
    const entry = cache.servers[name];
    const toolsInfo = entry ? `${entry.tools.length} tools cached` : 'not indexed';
    const overridden = src === 'project' && userCfg.mcpServers[name] ? ' (overrides user)' : '';
    const isUserOnly = src === 'user' && !projectCfg.mcpServers[name] ? '' : overridden;
    console.log(
      `  - ${chalk.cyan(name)} ${chalk.dim(`[${transport}, ${src}${isUserOnly}]`)} ${chalk.dim(toolsInfo)}`,
    );
    console.log(`      ${chalk.dim(summary)}`);
  }
  return 0;
}

async function verbReconnect(args: Args): Promise<number> {
  const name = args.mcpName;
  if (!name) {
    console.error(chalk.red('Error: `mcp reconnect` requires a server name'));
    return 1;
  }
  const { merged } = loadMergedConfig(args.cwd);
  const cfg = merged.mcpServers[name];
  if (!cfg) {
    console.error(chalk.red(`Error: unknown server "${name}"`));
    return 1;
  }

  const manager = new McpServerManager();
  try {
    await manager.connect(name, cfg);
    const tools = await manager.listTools(name, cfg);
    saveMcpCache({
      servers: {
        [name]: {
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
    console.log(chalk.green(`Reconnected to "${name}"; cached ${tools.length} tools.`));
    for (const t of tools) {
      const desc = t.description ? ` — ${String(t.description).slice(0, 80)}` : '';
      console.log(`  ${chalk.dim('-')} ${t.name}${chalk.dim(desc)}`);
    }
    return 0;
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  } finally {
    await manager.disconnectAll();
  }
}
