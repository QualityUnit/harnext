/**
 * Main entry point for the harnext CLI.
 *
 * Parses CLI arguments, resolves auth, creates the agent session,
 * and dispatches to the correct mode (interactive or print).
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import chalk from 'chalk';

import { parseArgs } from './cli/args.js';
import { runConnectCommand, runDisconnectCommand } from './cli/connect-prompt.js';
import { runConnectGithubCommand } from './cli/github-prompt.js';
import { ensureAuth } from './cli/onboarding.js';
import { offerSummarizeOnResume, resolveResumeTarget, runResumePicker } from './cli/resume.js';
import { attachSessionRecorder } from './cli/session-recorder.js';
import { attachConversationUploader } from './cloud/uploader.js';
import {
  appendHeartbeatTick,
  createAgentSession,
  getDefaultMode,
  getProviderById,
  loadHeartbeatConfig,
  loadPreferences,
  type PermissionMode,
  type SessionSummary,
  type SettingSource,
} from '@harnext/core';
import {
  runHeartbeatMode,
  runInteractiveMode,
  runMcpMode,
  runPrintMode,
  runRunnerMode,
  runStatusMode,
  runStreamingPrintMode,
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

  if (args.mode === 'connect') {
    const exitCode = args.connectDisable
      ? runDisconnectCommand()
      : await runConnectCommand({ cwd: args.cwd, endpoint: args.connectEndpoint });
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

  // ── Resume resolution ───────────────────────────────────────────────
  // `--resume <id>` resolves directly; bare `--resume` opens the per-cwd
  // picker (TTY interactive only). A miss/cancel falls through to a fresh
  // session so the flag is never a dead end.
  let resumeTarget: SessionSummary | undefined;
  if (args.resumeSessionId) {
    resumeTarget = resolveResumeTarget(args.cwd, args.resumeSessionId);
    if (!resumeTarget) {
      console.error(
        chalk.red(`Error: no saved session "${args.resumeSessionId}" for this directory.`),
      );
      process.exit(1);
    }
  } else if (args.resume) {
    if (args.mode === 'print') {
      console.error(
        chalk.red('Error: --resume needs a session id in print mode (harnext -p --resume <id>).'),
      );
      process.exit(1);
    }
    if (!process.stdin.isTTY) {
      console.error(chalk.red('Error: --resume needs an interactive terminal to show the picker.'));
      process.exit(1);
    }
    resumeTarget = await runResumePicker(args.cwd);
    if (!resumeTarget) console.log(chalk.dim('Starting a new session.'));
  }

  // Resolve provider/model: CLI flags > resumed session > saved preferences >
  // provider's built-in default > fallback. The resumed session's provider/model
  // are only preferred when the user gave neither --provider nor --model.
  const prefs = loadPreferences();
  const preferStored = !!resumeTarget && !args.provider && !args.model;
  const resolvedProvider =
    args.provider ??
    (preferStored ? resumeTarget!.provider : undefined) ??
    prefs.defaultProvider ??
    FALLBACK_PROVIDER;
  const resolvedModel =
    args.model ??
    (preferStored ? resumeTarget!.model : undefined) ??
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
  // Interactive sessions restore the last Shift+Tab mode from preferences when
  // the user didn't pass an explicit --permission-mode. Headless print mode
  // ignores the saved mode and uses only the flag (its policy is baked once).
  const interactiveInitialMode = permissionMode ?? getDefaultMode();
  const { session, resumed } = await createAgentSession({
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
    resumeSessionId: resumeTarget?.sessionId,
    fallback: args.fallbackModel
      ? { provider: args.fallbackProvider, modelId: args.fallbackModel }
      : undefined,
  });

  // Persist this conversation locally so `harnext --resume` can continue it.
  const recorder = attachSessionRecorder(session, { cwd: args.cwd, provider, model });

  if (args.mode === 'print') {
    // `--input-format stream-json` keeps stdin open and streams NDJSON user
    // messages in: the first starts the run, later ones steer it mid-flight.
    // The plain path reads the single prompt from argv.
    const streamingInput = args.inputFormat === 'stream-json';
    const initialMessage = streamingInput ? '' : args.messages.join(' ');
    // Stream this conversation to the context engine (no-op unless connected).
    const uploader = attachConversationUploader(session, {
      cwd: args.cwd,
      permissionMode: args.permissionMode,
      title: initialMessage,
    });
    const printOptions = {
      outputFormat: args.outputFormat ?? 'text',
      cwd: args.cwd,
      permissionMode: args.permissionMode,
    } as const;
    const exitCode = streamingInput
      ? await runStreamingPrintMode(session, printOptions)
      : await runPrintMode(session, { initialMessage, ...printOptions });
    await uploader.finalize();
    recorder.flush();
    process.exit(exitCode);
  } else {
    const uploader = attachConversationUploader(session, {
      cwd: args.cwd,
      permissionMode,
    });
    if (resumed) {
      console.log(
        chalk.dim(`Resumed session ${session.sessionId.slice(0, 8)} — ${session.messages.length} messages.`),
      );
      // Near the context limit? Offer to compact before the user types.
      await offerSummarizeOnResume(session, args.cwd);
    }
    try {
      await runInteractiveMode(session, {
        provider,
        model,
        initialMode: interactiveInitialMode,
      });
    } finally {
      recorder.flush();
      await uploader.finalize();
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
    const uploader = attachConversationUploader(session, { cwd, title: config.prompt });
    try {
      return await runHeartbeatMode(session, { cwd, name, prompt: config.prompt });
    } finally {
      await uploader.finalize();
    }
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

