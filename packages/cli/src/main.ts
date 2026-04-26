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

  if (args.mode === 'print' && args.messages.length === 0) {
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

  const { session } = await createAgentSession({
    provider,
    modelId: model,
    cwd: args.cwd,
    systemPrompt: args.systemPrompt,
    thinkingLevel: args.thinkingLevel as ThinkingLevel,
  });

  if (args.mode === 'print') {
    const exitCode = await runPrintMode(session, {
      initialMessage: args.messages.join(' '),
    });
    process.exit(exitCode);
  } else {
    try {
      await runInteractiveMode(session, {
        provider,
        model,
      });
    } finally {
      await session.dispose();
    }
  }
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

