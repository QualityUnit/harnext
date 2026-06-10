/**
 * Main entry point for the harnext CLI.
 *
 * Parses CLI arguments, resolves auth, creates the agent session,
 * and dispatches to the correct mode (interactive or print).
 */

import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import chalk from 'chalk';

import { parseArgs } from './cli/args.js';
import { runConnectGithubCommand } from './cli/github-prompt.js';
import { ensureAuth } from './cli/onboarding.js';
import {
  appendHeartbeatTick,
  createAgentSession,
  getProviderById,
  loadHeartbeatConfig,
  loadPreferences,
  type PermissionMode,
  type SettingSource,
} from '@harnext/core';
import {
  runHeartbeatMode,
  runInteractiveMode,
  runMcpMode,
  runPrintMode,
  runRunnerMode,
  runStatusMode,
  runUpgradeMode,
} from './modes/index.js';

const FALLBACK_PROVIDER = 'anthropic';
const FALLBACK_MODEL = '';

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (
    args.mode === 'print' &&
    args.messages.length === 0 &&
    args.inputFormat !== 'stream-json'
  ) {
    console.error(chalk.red('Error: print mode requires a message'));
    console.error(chalk.dim('Usage: harnext -p "your message"'));
    process.exit(1);
  }

  if (args.mode === 'heartbeat') {
    if (!args.heartbeatName) {
      console.error(chalk.red('Error: --heartbeat requires a name'));
      console.error(chalk.dim('Usage: harnext --heartbeat <name>'));
      process.exit(1);
    }
    const exitCode = await runHeartbeat(
      args.cwd,
      args.heartbeatName,
      args.thinkingLevel as ThinkingLevel,
    );
    process.exit(exitCode);
  }

  if (args.mode === 'mcp') {
    const exitCode = await runMcpMode(args);
    process.exit(exitCode);
  }

  if (args.mode === 'status') {
    const exitCode = await runStatusMode({ cwd: args.cwd });
    process.exit(exitCode);
  }

  if (args.mode === 'upgrade') {
    const exitCode = await runUpgradeMode({
      check: args.upgradeCheck,
      force: args.upgradeForce,
    });
    process.exit(exitCode);
  }

  if (args.mode === 'runner') {
    const exitCode = await runRunnerMode({
      cwd: args.cwd,
      verb: args.runnerVerb,
      logLines: args.runnerLogLines,
      logNoFollow: args.runnerLogNoFollow,
    });
    process.exit(exitCode);
  }

  if (args.mode === 'setup') {
    await runConnectGithubCommand({
      cwd: args.cwd,
      cliPath: process.argv[1] ?? '',
      nodePath: process.execPath,
      setupMode: 'full',
    });
    process.exit(0);
  }

  // Resolve provider/model: CLI flags > saved preferences > provider's built-in default > fallback.
  const prefs = loadPreferences();
  const resolvedProvider = args.provider ?? prefs.defaultProvider ?? FALLBACK_PROVIDER;
  const resolvedModel =
    args.model ??
    prefs.defaultModels?.[resolvedProvider] ??
    getProviderById(resolvedProvider)?.defaultModel ??
    FALLBACK_MODEL;

  // Resolve auth — onboards if no API key is found
  const { provider, model } = await ensureAuth(resolvedProvider, resolvedModel);

  // Interactive sessions own the permission mode dynamically (Shift+Tab cycles
  // plan / acceptEdits / bypassPermissions), so we don't bake a fixed
  // permission_mode hook into the agent — the flag only seeds the starting UI
  // mode. Headless print mode keeps the baked policy hook.
  const permissionMode = args.permissionMode as PermissionMode | undefined;
  const { session } = await createAgentSession({
    provider,
    modelId: model,
    cwd: args.cwd,
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: args.appendSystemPrompt,
    thinkingLevel: args.thinkingLevel as ThinkingLevel,
    allowedTools: args.allowedTools,
    disallowedTools: args.disallowedTools,
    permissionMode: args.mode === 'print' ? permissionMode : undefined,
    maxTurns: args.maxTurns,
    settingSources: args.settingSources as SettingSource[] | undefined,
  });

  if (args.mode === 'print') {
    const initialMessage =
      args.inputFormat === 'stream-json'
        ? await readStreamJsonPrompt()
        : args.messages.join(' ');
    const exitCode = await runPrintMode(session, {
      initialMessage,
      outputFormat: args.outputFormat ?? 'text',
      cwd: args.cwd,
      permissionMode: args.permissionMode,
    });
    process.exit(exitCode);
  } else {
    try {
      await runInteractiveMode(session, {
        provider,
        model,
        initialMode: permissionMode,
      });
    } finally {
      await session.dispose();
    }
  }
}

/**
 * Read a stream-json prompt from stdin (Claude SDK `--input-format stream-json`).
 * Each line is a JSON envelope; we extract the text of every user message and
 * concatenate it into a single prompt. Non-user lines are ignored.
 */
async function readStreamJsonPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const texts: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type !== 'user' && obj.message?.role !== 'user') continue;
      const content = obj.message?.content;
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: string }).text === 'string'
          ) {
            texts.push((block as { text: string }).text);
          }
        }
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return texts.join('\n');
}

/**
 * Cron entry point. Non-interactive, never prompts for auth — if auth isn't
 * already stored, we record a failure record and exit 1.
 */
async function runHeartbeat(
  cwd: string,
  name: string,
  thinkingLevel: ThinkingLevel,
): Promise<number> {
  const config = loadHeartbeatConfig(cwd, name);
  if (!config) {
    appendHeartbeatTick(cwd, name, {
      ts: new Date().toISOString(),
      exit: 1,
      durationMs: 0,
      prompt: '',
      output: '',
      error: `no heartbeat config for "${name}"`,
    });
    return 1;
  }

  const prefs = loadPreferences();
  const resolvedProvider =
    config.provider ?? prefs.defaultProvider ?? FALLBACK_PROVIDER;
  const resolvedModel =
    config.model ??
    prefs.defaultModels?.[resolvedProvider] ??
    getProviderById(resolvedProvider)?.defaultModel ??
    FALLBACK_MODEL;

  try {
    const { session } = await createAgentSession({
      provider: resolvedProvider,
      modelId: resolvedModel,
      cwd,
      thinkingLevel,
      quiet: true,
    });
    return await runHeartbeatMode(session, { cwd, name, prompt: config.prompt });
  } catch (err) {
    appendHeartbeatTick(cwd, name, {
      ts: new Date().toISOString(),
      exit: 1,
      durationMs: 0,
      prompt: config.prompt,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }
}

