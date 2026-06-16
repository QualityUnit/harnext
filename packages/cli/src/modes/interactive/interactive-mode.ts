import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import {
  classifyInteractive,
  compactNow,
  ensureBundledSkills,
  formatStatus,
  getContextTokens,
  getProjectMemoryDir,
  listAgentRunLogs,
  loadMemoryIndex,
  loadSession,
  normalizeToolName,
  reconstructMessagesFromRunLog,
  resolveGoalModels,
  runtimeSeconds,
  setDefault,
  setDefaultMode,
  toolTargetPath,
} from '@harnext/core';
import type {
  AgentRunLogSummary,
  BackgroundShell,
  BackgroundShellManager,
  EnsureResult,
  ImageContent,
  PermissionMode,
} from '@harnext/core';
import chalk from 'chalk';

import { runSetGoalConfigCommand } from '../../cli/goal-config-prompt.js';
import { runConnectCommand, runDisconnectCommand } from '../../cli/connect-prompt.js';
import { runConnectGithubCommand } from '../../cli/github-prompt.js';
import { runHeartbeatCommand } from '../../cli/heartbeat-prompt.js';
import {
  clipboardInstallHint,
  formatImageSize,
  hasClipboardTool,
  readClipboardImage,
  readClipboardText,
} from '../../cli/clipboard.js';
import { runGoalCommand } from './goal-command.js';
import { runMcpPanel } from './mcp-panel.js';
import { expandAtMentions } from '../../cli/at-mentions.js';
import { createPathCompleter } from '../../cli/file-search.js';
import { createTextarea } from '../../cli/input.js';
import type { Textarea } from '../../cli/input.js';
import { pickModel } from '../../cli/model-picker.js';
import { runResumePicker } from '../../cli/resume.js';
import { select } from '../../cli/select.js';
import type { SelectItem } from '../../cli/select.js';
import type { AgentSession, Skill } from '@harnext/core';
import { createMarkdownStreamer } from './markdown-stream.js';
import type { MarkdownStreamer } from './markdown-stream.js';
import * as render from './render.js';
import { renderTranscript } from './transcript.js';

export interface InteractiveModeOptions {
  provider: string;
  model: string;
  /**
   * Permission mode to start in (Shift+Tab cycles between the three UI modes).
   * Anything outside the three coding-agent modes — `default`, `dontAsk`, or
   * undefined — lands on `acceptEdits`.
   */
  initialMode?: PermissionMode;
}

/** Narrow any PermissionMode to one of the three interactive UI modes. */
export function toUiMode(mode: PermissionMode | undefined): render.Mode {
  return mode === 'plan' || mode === 'bypassPermissions' ? mode : 'acceptEdits';
}

// ── Slash command registry ───────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
  /** If false, the textarea stays live during the action (default true pauses it for interactive prompts). */
  pause?: boolean;
  /** When true, accept arguments after the command name (e.g. `/compact focus on auth`). */
  acceptsArgs?: boolean;
  action: (ctx: CommandContext, args: string) => Promise<boolean>; // true = continue, false = exit
}

interface CommandContext {
  session: AgentSession;
  getProvider: () => string;
  getModel: () => string;
  setModel: (provider: string, modelId: string, model: unknown) => void;
  clearSession: () => void;
  ensureBundledSkills: () => EnsureResult;
  invokeSkill: (skill: Skill, args: string, echoLabel: string) => Promise<void>;
  writeAbove: (text: string) => void;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/model',
    description: 'Switch provider and model',
    action: async (ctx) => {
      const result = await pickModel();
      if (result) {
        ctx.setModel(result.provider, result.model.id, result.model);
        setDefault(result.provider, result.model.id);
        console.log(
          chalk.green('  Switched to ') + chalk.bold(`${result.provider}/${result.model.id}`),
        );
      } else {
        console.log(chalk.dim('  Cancelled.'));
      }
      console.log();
      return true;
    },
  },
  {
    name: '/goal',
    description: 'Run a goal through the planner → generator → evaluator loop',
    acceptsArgs: true,
    action: async (ctx, args) => {
      const goal = args.trim();
      if (!goal) {
        console.log();
        console.log(chalk.yellow('  Usage: /goal <what to build>'));
        console.log(chalk.dim('  Configure phase models with /set-goal-config.'));
        console.log();
        return true;
      }
      const models = resolveGoalModels(ctx.getProvider(), ctx.getModel());
      await runGoalCommand(goal, models);
      return true;
    },
  },
  {
    name: '/set-goal-config',
    description: 'Pick the planner / generator / evaluator models for /goal',
    action: async (ctx) => {
      await runSetGoalConfigCommand(ctx.getProvider(), ctx.getModel());
      return true;
    },
  },
  {
    name: '/compact',
    description: 'Compact conversation history (optional: /compact <focus instructions>)',
    acceptsArgs: true,
    action: async (ctx, args) => {
      const spinner = render.startSpinner('Compacting...');
      try {
        const trimmed = args.trim();
        const result = await compactNow(ctx.session.agent, {
          instructions: trimmed.length > 0 ? trimmed : undefined,
        });
        spinner.stop();
        if (result.compacted) {
          console.log(
            chalk.green('  Compacted: ') +
              chalk.dim(
                `${result.originalMessages} → ${result.newMessages} messages, ` +
                  `~${result.originalTokens} → ~${result.compactedTokens} tokens`,
              ),
          );
        } else {
          console.log(chalk.dim('  Nothing to compact yet.'));
        }
      } catch (err) {
        spinner.stop();
        console.log(
          chalk.red('  Compaction failed: ') +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      console.log();
      return true;
    },
  },
  {
    name: '/clear',
    description: 'Clear conversation and start a new session',
    action: async (ctx) => {
      ctx.clearSession();
      return true;
    },
  },
  {
    name: '/resume',
    description: 'Resume a previous session from this directory',
    action: async (ctx) => {
      // Same per-cwd picker as `harnext --resume`, usable mid-session.
      const target = await runResumePicker(process.cwd());
      if (!target) {
        // Picker cancelled or no saved sessions (it prints its own note).
        console.log();
        return true;
      }
      const stored = loadSession(target.sessionId, process.cwd());
      if (!stored || stored.messages.length === 0) {
        console.log(chalk.yellow('  That session has no messages to resume.'));
        console.log();
        return true;
      }
      // Swap the live conversation in place: abort any run, reset the agent,
      // then seed the stored transcript (mirrors the /runs replay path). The
      // session recorder rewrites the current transcript on the next turn.
      try {
        ctx.session.agent.abort();
      } catch {
        // no active run — nothing to abort
      }
      ctx.session.agent.reset();
      ctx.session.agent.state.messages = stored.messages;
      // Repaint: clear the screen, then print the resumed turns. (The command
      // runs with the textarea torn down, so write straight to stdout — the
      // textarea + header are redrawn when the command returns.)
      process.stdout.write('\x1B[2J\x1B[H');
      process.stdout.write(renderTranscript(stored.messages));
      console.log(
        chalk.green('  Resumed session ') +
          chalk.bold(target.sessionId.slice(0, 8)) +
          chalk.dim(` — ${stored.messages.length} messages.`),
      );
      console.log();
      return true;
    },
  },
  {
    name: '/memory',
    description: 'Show this project’s memory directory and index',
    pause: false,
    action: async (ctx) => {
      const dir = getProjectMemoryDir(process.cwd());
      const index = loadMemoryIndex(process.cwd());
      const lines = [chalk.bold('  Memory'), chalk.dim(`  ${dir}`), ''];
      if (index) {
        lines.push(...index.split('\n').map((l) => `  ${l}`));
      } else {
        lines.push(chalk.dim('  (empty — the agent records durable facts here as it learns them)'));
      }
      ctx.writeAbove(lines.join('\n') + '\n\n');
      return true;
    },
  },
  {
    name: '/init',
    description: 'Seed built-in skills and scaffold a project setup skill',
    pause: false,
    action: async (ctx) => {
      const r = ctx.ensureBundledSkills();
      if (r.added.length > 0) {
        ctx.writeAbove(
          chalk.green(`  Added bundled skills to ${r.target}: ${r.added.join(', ')}`) + '\n',
        );
      }
      for (const d of r.diagnostics) {
        ctx.writeAbove(chalk.yellow(`  ${d.type}: ${d.message}`) + '\n');
      }

      // Prefer the session-loaded copy (honors user edits); fall back to the
      // just-seeded file on disk so /init works even if this is the first run
      // and the session was created before the seed existed.
      let skill: Skill | undefined = ctx.session.skills.find((s) => s.name === 'init');
      if (!skill) {
        const filePath = join(r.target, 'init', 'SKILL.md');
        if (existsSync(filePath)) {
          skill = {
            name: 'init',
            description: '',
            filePath,
            baseDir: dirname(filePath),
            disableModelInvocation: false,
          };
        }
      }
      if (!skill) {
        ctx.writeAbove(
          chalk.red('  init skill not available. Restart harnext and try again.') + '\n\n',
        );
        return true;
      }
      await ctx.invokeSkill(skill, '', '/init');
      return true;
    },
  },
  {
    name: '/heartbeat',
    description: 'Configure a cron-driven heartbeat for this project',
    action: async () => {
      await runHeartbeatCommand({
        cwd: process.cwd(),
        cliPath: process.argv[1] ?? '',
        nodePath: process.execPath,
      });
      return true;
    },
  },
  {
    name: '/connect',
    description: 'Connect this machine to a context engine to push conversations',
    acceptsArgs: true,
    action: async (_ctx, args) => {
      const arg = args.trim();
      if (arg === '--disable' || arg === '--disconnect') {
        runDisconnectCommand();
        return true;
      }
      await runConnectCommand({ cwd: process.cwd(), endpoint: arg || undefined });
      return true;
    },
  },
  {
    name: '/connect-github',
    description: 'Connect this project to a GitHub repo and its issue pipeline',
    action: async () => {
      await runConnectGithubCommand({
        cwd: process.cwd(),
        cliPath: process.argv[1] ?? '',
        nodePath: process.execPath,
      });
      return true;
    },
  },
  {
    name: '/mcp',
    description: 'Manage MCP servers (list, add, remove, reconnect)',
    action: async () => {
      await runMcpPanel(process.cwd());
      return true;
    },
  },
  {
    name: '/skills',
    description: 'List loaded skills and view a skill',
    action: async (ctx) => {
      const skills = ctx.session.skills;
      console.log();
      if (skills.length === 0) {
        console.log(chalk.dim('  No skills loaded.'));
        console.log(chalk.dim('  Add SKILL.md files under <cwd>/.harnext/skills/<skill-name>/'));
        console.log();
        return true;
      }

      console.log(chalk.bold(`  Skills (${skills.length}):`));
      for (const s of skills) {
        const hidden = s.disableModelInvocation ? chalk.yellow(' [hidden from prompt]') : '';
        console.log(chalk.cyan(`  /skill:${s.name}`) + hidden);
        console.log(chalk.dim(`    ${s.description}`));
        console.log(chalk.dim(`    ${s.filePath}`));
      }
      console.log();

      const items: SelectItem<Skill>[] = skills.map((skill) => ({
        label: `/skill:${skill.name}`,
        value: skill,
        hint: skill.description,
      }));
      const selected = await select(items, {
        title: 'View a skill (esc to skip)',
      });
      if (selected) {
        try {
          const content = readFileSync(selected.filePath, 'utf-8');
          console.log();
          console.log(chalk.bold(`  ${selected.filePath}`));
          console.log(chalk.dim('  ' + '─'.repeat(60)));
          for (const line of content.split('\n')) {
            console.log(`  ${line}`);
          }
          console.log();
        } catch (err) {
          console.log(
            chalk.red('  Failed to read skill: ') +
              (err instanceof Error ? err.message : String(err)),
          );
          console.log();
        }
      }
      return true;
    },
  },
  {
    name: '/runs',
    description: 'Replay a saved GitHub poller run into this session',
    action: async (ctx) => {
      const runs = listAgentRunLogs(process.cwd());
      console.log();
      if (runs.length === 0) {
        console.log(chalk.dim('  No runs found for this project.'));
        console.log();
        return true;
      }
      const items: SelectItem<AgentRunLogSummary>[] = runs.map((r) => ({
        label: formatRunLabel(r),
        value: r,
        hint: formatRunHint(r),
      }));
      const selected = await select(items, {
        title: 'Select a run to replay (esc to cancel)',
      });
      if (!selected) {
        console.log(chalk.dim('  Cancelled.'));
        console.log();
        return true;
      }
      try {
        const { record, messages } = reconstructMessagesFromRunLog(selected.path);
        try {
          ctx.session.agent.abort();
        } catch {
          // agent may not be running
        }
        ctx.session.agent.reset();
        ctx.session.agent.state.messages = messages;
        console.log(
          chalk.green('  Loaded ') +
            chalk.bold(`${messages.length} messages`) +
            chalk.dim(
              ` from ${selected.fileName} (${record.itemKind} #${record.itemNumber} · ${record.stageId})`,
            ),
        );
        console.log(chalk.dim('  Type your next prompt to continue the conversation.'));
        console.log();
      } catch (err) {
        console.log(
          chalk.red('  Failed to load run: ') +
            (err instanceof Error ? err.message : String(err)),
        );
        console.log();
      }
      return true;
    },
  },
  {
    name: '/bashes',
    description: 'List, view, or kill background shells',
    action: async (ctx) => {
      await runBashesPanel(ctx.session);
      return true;
    },
  },
  {
    name: '/help',
    description: 'Show available commands',
    action: async () => {
      console.log();
      console.log(chalk.bold('  Commands:'));
      const width = Math.max(...SLASH_COMMANDS.map((cmd) => cmd.name.length)) + 2;
      for (const cmd of SLASH_COMMANDS) {
        console.log(
          chalk.cyan(`  ${cmd.name.padEnd(width)}`) + chalk.dim(`— ${cmd.description}`),
        );
      }
      console.log(chalk.dim('\n  Tip: type / to open the command selector\n'));
      return true;
    },
  },
  {
    name: '/quit',
    description: 'Exit harnext',
    action: async () => false,
  },
];

function formatRunLabel(r: AgentRunLogSummary): string {
  return `${r.itemKind} #${r.itemNumber} · ${r.stageId} · ${r.eventCount} events`;
}

function formatRunHint(r: AgentRunLogSummary): string {
  const status = r.exit === 0 ? 'ok' : r.error ? `err: ${r.error}` : `exit ${r.exit}`;
  const secs = Math.round(r.durationMs / 100) / 10;
  return `${r.ts} · ${secs}s · ${status}`;
}

/**
 * Live, auto-refreshing viewer for one background job's output. Polls the
 * manager on a timer and redraws in place — but only when the frame actually
 * changes, so it doesn't flicker. Output lines are stripped of ANSI and
 * width-clamped so the in-place redraw never miscounts wrapped rows.
 * Keys: esc/b/q (or ⏎) to go back, k to kill a running job. Returns 'exit' on
 * ctrl+c so the caller closes the whole panel.
 */
async function runJobView(mgr: BackgroundShellManager, id: string): Promise<'back' | 'exit'> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  if (stdin.isTTY) stdin.setRawMode(true);
  emitKeypressEvents(stdin);
  stdin.resume();

  let linesRendered = 0;
  let lastFrame = '';

  const buildFrame = (): string => {
    const peek = mgr.peek(id);
    if (!peek) return chalk.dim(`  ${id} is no longer available.`);
    const s = peek.shell;
    const live = s.status === 'running';
    const rows = Math.max(8, process.stdout.rows || 24); // || so 0/undefined → fallback
    const cols = Math.max(20, process.stdout.columns || 80);
    const dot = live ? chalk.green('●') : chalk.dim('○');
    const header =
      '  ' +
      dot +
      ' ' +
      chalk.bold(s.id) +
      chalk.dim(`  ${formatStatus(s)} · ${runtimeSeconds(s)}s · ${s.command}`);
    const hint = chalk.dim(live ? '  live · k kill · ←/esc back' : '  ←/esc back');
    const outLines = (peek.output ?? '').split('\n');
    while (outLines.length > 0 && outLines[outLines.length - 1] === '') outLines.pop();
    // Reserve rows for header + separator + blank + hint and a small margin.
    const maxOut = Math.max(3, rows - 6);
    const shown =
      outLines.length > 0
        ? outLines.slice(-maxOut).map((l) => {
            const clean = render.stripAnsi(l);
            return clean.length > cols ? clean.slice(0, cols - 1) + '…' : clean;
          })
        : [chalk.dim('  (no output yet)')];
    return [header, render.separator(), ...shown, '', hint].join('\n');
  };

  const clearRendered = (): void => {
    if (linesRendered > 0) {
      process.stdout.write(`\x1B[${linesRendered}F\x1B[J`);
      linesRendered = 0;
    }
  };
  const draw = (): void => {
    const frame = buildFrame();
    if (frame === lastFrame && linesRendered > 0) return; // unchanged → no redraw
    clearRendered();
    process.stdout.write(frame + '\n');
    linesRendered = frame.split('\n').length;
    lastFrame = frame;
  };

  draw();
  const timer = setInterval(draw, 400);
  if (typeof timer.unref === 'function') timer.unref();

  return await new Promise<'back' | 'exit'>((resolve) => {
    const cleanup = (r: 'back' | 'exit'): void => {
      clearInterval(timer);
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      clearRendered();
      resolve(r);
    };
    const onKey = (_str: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return cleanup('exit');
      if (['escape', 'left', 'b', 'q', 'return'].includes(key.name ?? '')) return cleanup('back');
      if (key.name === 'k') {
        const cur = mgr.get(id);
        if (cur && cur.status === 'running') {
          mgr.kill(id);
          draw();
        }
      }
    };
    stdin.on('keypress', onKey);
  });
}

/**
 * Interactive background-jobs panel (opened by `/bashes` or ↓ on an empty
 * prompt): pick a job → its output is shown in a live, auto-refreshing view.
 * The list shows id, status, runtime, and the command.
 */
async function runBashesPanel(session: AgentSession): Promise<void> {
  const mgr = session.backgroundShells;
  if (!mgr) {
    console.log(chalk.dim('  Background jobs are disabled.'));
    console.log();
    return;
  }

  for (;;) {
    const shells = mgr.list();
    if (shells.length === 0) {
      console.log(chalk.dim('  No background jobs.'));
      console.log();
      return;
    }

    const items: SelectItem<string>[] = shells.map((s) => ({
      label: `${s.id}  ${formatStatus(s)} · ${runtimeSeconds(s)}s`,
      value: s.id,
      hint: s.command,
    }));
    items.push({ label: 'Close', value: '__close__' });
    const picked = await select(items, {
      title: 'Background jobs — pick one to view its output',
      // Only worth a search bar once the list is long enough to scan-fatigue.
      searchable: shells.length > 5,
    });
    if (!picked || picked === '__close__') {
      console.log();
      return;
    }

    const result = await runJobView(mgr, picked);
    if (result === 'exit') {
      console.log();
      return;
    }
    // 'back' → loop to the list again.
  }
}

type SelectedEntry = { kind: 'command'; command: SlashCommand } | { kind: 'skill'; skill: Skill };

async function selectSlashCommandOrSkill(
  skills: Skill[],
): Promise<SelectedEntry | undefined> {
  const items: SelectItem<SelectedEntry>[] = [
    ...SLASH_COMMANDS.map((cmd) => ({
      label: cmd.name,
      value: { kind: 'command', command: cmd } as SelectedEntry,
      hint: cmd.description,
    })),
    ...skills
      .filter((s) => !s.disableModelInvocation)
      .map((skill) => ({
        label: `/skill:${skill.name}`,
        value: { kind: 'skill', skill } as SelectedEntry,
        hint: skill.description,
      })),
  ];

  return select(items, { title: 'Select a command' });
}

interface SlashCommandMatch {
  cmd: SlashCommand;
  args: string;
}

/**
 * Match a slash-command input. Exact name (`/foo`) always matches.
 * Commands flagged `acceptsArgs: true` also match `/foo <rest>` and
 * return the trimmed remainder as args.
 */
export function findSlashCommand(input: string): SlashCommandMatch | undefined {
  const exact = SLASH_COMMANDS.find((cmd) => cmd.name === input);
  if (exact) return { cmd: exact, args: '' };
  const argCmd = SLASH_COMMANDS.find(
    (cmd) => cmd.acceptsArgs && input.startsWith(cmd.name + ' '),
  );
  if (argCmd) return { cmd: argCmd, args: input.slice(argCmd.name.length + 1) };
  return undefined;
}

function findSkill(skills: Skill[], name: string): Skill | undefined {
  return skills.find((s) => s.name === name);
}

function expandSkillInvocation(skill: Skill, args: string): string {
  const content = readFileSync(skill.filePath, 'utf-8');
  const trimmedArgs = args.trim();
  const parts = [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `References are relative to ${skill.baseDir}.`,
    '',
    content,
    '</skill>',
  ];
  if (trimmedArgs.length > 0) {
    parts.push('');
    parts.push(`User: ${trimmedArgs}`);
  }
  return parts.join('\n');
}

// ── Animated spinner (rendered inline on the info line) ─────────────

const LOADING_MESSAGES = [
  'Working...',
  'Thinking...',
  'Cooking...',
  'Brewing...',
  'Crafting...',
  'Pondering...',
  'Computing...',
  'Conjuring...',
  'Assembling...',
  'Wiring...',
  'Compiling...',
  'Inventing...',
  'Scheming...',
  'Plotting...',
  'Crunching...',
  'Supercalifragilisticexpialidocious-ing...',
  'Discombobulating...',
  'Flibbertigibbeting...',
  'Bamboozling...',
  'Hullabalooing...',
  'Collywobbling...',
  'Lollygagging...',
  'Persnicketing...',
  'Gobbledygooking...',
  'Higgledy-piggledying...',
  'Snickersnacking...',
  'Whippersnappering...',
];

function randomMessage(): string {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
}

// Sum input/output tokens and cost across all assistant turns in the
// session. Each turn's `input` is cumulative context sent to the model —
// summing across turns reflects total tokens consumed, not unique tokens.
function sumSessionUsage(
  messages: ReadonlyArray<{
    role: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
  }>,
): { input: number; output: number; cost: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const u = msg.usage;
    if (!u) continue;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cost += u.cost?.total ?? 0;
  }
  return { input, output, cost };
}

/**
 * Interactive REPL mode with a sticky textarea pinned to the bottom of the
 * terminal via a terminal scroll region. Agent output streams naturally
 * above; the textarea stays visible so the user can keep typing and submit
 * mid-run, which queues as a steering message for the live agent turn.
 */
export async function runInteractiveMode(
  session: AgentSession,
  options: InteractiveModeOptions,
): Promise<void> {
  const cwd = process.cwd();
  let activeProvider = options.provider;
  let activeModel = options.model;
  const pendingTools: Map<
    string,
    { args: Record<string, unknown>; startedAt: number; priorContent?: string | null }
  > = new Map();
  // Tool calls the user denied at the approval prompt. The blocked-call error
  // result still flows through tool_execution_end — these ids suppress its
  // body so the scrollback shows our "✗ denied" line instead of a red error.
  const deniedToolCalls = new Set<string>();
  let currentText = '';
  let markdown: MarkdownStreamer | null = null;
  let agentBusy = false;
  // Images pasted with Ctrl+V, attached to the next submitted prompt (base64).
  let pendingImages: ImageContent[] = [];
  // Show the "install a clipboard tool" hint only once per session.
  let clipboardHintShown = false;
  // Steering messages submitted mid-run that the agent has not yet consumed.
  // Each is shown as a gray "queued" line above the prompt; the live `message`
  // reference is what we passed to agent.steer(), used to match the
  // message_start the loop emits when it injects the message — at which point
  // the entry is committed to the scrollback as a normal user message.
  let pendingSteers: { message: AgentMessage; rawText: string }[] = [];

  // ── Permission mode (cycled with shift+tab) ───────────────────────
  // Three coding-agent modes, mirroring Claude Code:
  //   plan              — read-only; the agent drafts a plan via the exit_plan
  //                       tool and waits for the user to approve before editing.
  //   acceptEdits       — edits inside cwd run automatically; out-of-cwd edits
  //                       and every bash command ask first.
  //   bypassPermissions — dangerously approve all; nothing is gated.
  // Held in a one-field object so the approval-gate closure can both read the
  // live value and switch it (plan→acceptEdits on approval) without tripping
  // TypeScript's control-flow narrowing.
  const MODES: render.Mode[] = ['plan', 'acceptEdits', 'bypassPermissions'];
  const perm: { mode: render.Mode } = { mode: toUiMode(options.initialMode) };
  // When set, the spinner shows this fixed label instead of the cycling
  // whimsical word — used to surface "waiting for your approval…" while a
  // permission prompt is open.
  let spinnerOverride: string | null = null;

  // Assistant-text streaming state. `asstPendingNewlines` holds trailing
  // newlines from recent chunks so we don't emit them yet — if the stream
  // ends with more trailing newlines than we want, we just drop them.
  // `asstAtLineStart` tracks whether the cursor is at column 0 of a fresh
  // row, used by message_end to decide whether to emit a final '\n'.
  // `asstNeedsLead` defers the blank line that separates prose from the
  // previous block until the message actually produces text — an assistant
  // message that goes straight to a tool call must not emit a blank that
  // would stack with the tool block's own separator.
  let asstPendingNewlines = '';
  let asstAtLineStart = true;
  let asstNeedsLead = false;

  function processAsstChunk(styled: string): string {
    if (styled.length === 0) return '';
    const combined = asstPendingNewlines + styled;
    const m = combined.match(/\n+$/);
    let toWrite = m ? combined.slice(0, -m[0].length) : combined;
    asstPendingNewlines = m ? m[0] : '';
    if (asstNeedsLead) {
      // Drop model-emitted leading newlines, then open the block with
      // exactly one blank line of our own.
      toWrite = toWrite.replace(/^\n+/, '');
      if (toWrite.length === 0) return '';
      toWrite = '\n' + toWrite;
      asstNeedsLead = false;
    }
    if (toWrite.length === 0) return '';
    asstAtLineStart = toWrite.endsWith('\n');
    return toWrite;
  }

  let spinnerPrefix = '';
  let spinnerMsg = '';
  let spinnerFrame = 0;
  let spinnerLastCycle = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerStartedAt = 0;

  // Print the static header before the textarea — it stays above content
  // and scrolls out naturally as the session grows.
  process.stdout.write(
    render.header({ provider: activeProvider, model: activeModel, cwd }),
  );

  // Resumed session: replay the prior transcript so the user can see the
  // conversation they're continuing, not a blank screen.
  if (session.messages.length > 0) {
    process.stdout.write(renderTranscript(session.messages));
  }

  const completions = [
    ...SLASH_COMMANDS.map((cmd) => ({
      text: cmd.name,
      hint: cmd.description,
    })),
    ...session.skills
      .filter((s) => !s.disableModelInvocation)
      .map((skill) => ({
        text: `/skill:${skill.name}`,
        hint: skill.description,
      })),
  ];

  // eslint-disable-next-line prefer-const
  let textarea: Textarea;

  function tickSpinner() {
    const CYCLE_MS = 3000;
    // spinnerOverride pins a fixed label (e.g. download progress) and skips
    // the random-message cycling for as long as it's set.
    let label: string;
    if (spinnerOverride != null) {
      label = spinnerOverride;
    } else {
      if (Date.now() - spinnerLastCycle >= CYCLE_MS) {
        let next = randomMessage();
        while (next === spinnerMsg && LOADING_MESSAGES.length > 1) next = randomMessage();
        spinnerMsg = next;
        spinnerLastCycle = Date.now();
      }
      label = spinnerMsg;
    }
    const { input, output, cost } = sumSessionUsage(session.messages);
    spinnerPrefix = render.thinkLine({
      frame: spinnerFrame,
      label,
      elapsedMs: Date.now() - spinnerStartedAt,
      inputTokens: input,
      outputTokens: output,
      cost,
    });
    spinnerFrame++;
    textarea.redraw();
  }

  function startSpinner() {
    if (spinnerTimer) return;
    spinnerMsg = randomMessage();
    spinnerLastCycle = Date.now();
    spinnerFrame = 0;
    spinnerStartedAt = Date.now();
    tickSpinner();
    spinnerTimer = setInterval(tickSpinner, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerPrefix = '';
    if (textarea) textarea.redraw();
  }

  textarea = createTextarea({
    prompt: render.prompt(),
    getTopBorder: () => {
      const sep = render.separator();
      const steers = render.queuedSteers(pendingSteers.map((s) => s.rawText));
      const parts: string[] = [];
      if (spinnerPrefix) parts.push(spinnerPrefix);
      parts.push(sep);
      if (steers) parts.push(steers);
      return `\n${parts.join('\n')}`;
    },
    getBottomBorder: ({ footerFocused }) => {
      const ctxTokens = getContextTokens(session.messages);
      const ctxWindow = session.agent.state.model.contextWindow;
      const ctxPercent = ctxWindow ? (ctxTokens / ctxWindow) * 100 : undefined;
      const { input, output, cost } = sumSessionUsage(session.messages);
      const runningJobs =
        session.backgroundShells?.list().filter((s) => s.status === 'running').length ?? 0;
      return render.inputFooter({
        provider: activeProvider,
        model: activeModel,
        cwd,
        contextPercent: ctxPercent,
        inputTokens: input,
        outputTokens: output,
        cost,
        mode: perm.mode,
        backgroundJobs: runningJobs,
        backgroundJobsFocused: footerFocused,
        attachedImages: pendingImages.length,
      });
    },
    onShiftTab: () => {
      const idx = MODES.indexOf(perm.mode);
      perm.mode = MODES[(idx + 1) % MODES.length];
      // Persist the choice so the next session starts in the same mode (unless
      // --permission-mode overrides). Best-effort; a write failure is ignored.
      try {
        setDefaultMode(perm.mode);
      } catch {
        // ignore — persistence is non-critical
      }
      // Surface the new mode + a one-line reminder of what it gates, above the
      // input. The footer pill updates on the redraw that follows this handler.
      textarea.writeAbove('\n' + render.modeSwitchLine(perm.mode) + '\n');
    },
    // ↓ on an empty prompt focuses the background-jobs chip — but only when idle
    // (a live run owns the screen via the spinner/streaming) and only if there
    // is at least one shell to show.
    footerCanFocus: () => {
      if (agentBusy) return false;
      return (session.backgroundShells?.list().length ?? 0) > 0;
    },
    // ⏎ while the chip is focused opens the viewer. Pause the textarea so the
    // viewer's select widget owns stdin, then resume when the user closes it.
    onFooterActivate: () => {
      textarea.pause();
      void runBashesPanel(session).finally(() => textarea.resume());
    },
    // Ctrl+V: attach a clipboard image to the next prompt (base64); if there's
    // no image, fall back to pasting clipboard text into the input.
    onPaste: async () => {
      const result = await readClipboardImage();
      if (result.kind === 'image') {
        pendingImages.push({
          type: 'image',
          data: result.image.data,
          mimeType: result.image.mimeType,
        });
        textarea.writeAbove(
          '\n  ' +
            chalk.cyan('🖼 attached ') +
            chalk.dim(`${result.image.mimeType} · ${formatImageSize(result.image.bytes)}`) +
            chalk.dim(' — sends with your next message') +
            '\n',
        );
        return null; // handled; redraw shows the footer indicator
      }
      if (result.kind === 'too-large') {
        textarea.writeAbove(
          '\n  ' +
            chalk.yellow('🖼 image too large ') +
            chalk.dim(`(${formatImageSize(result.bytes)}; max 15 MB)`) +
            '\n',
        );
        return null;
      }
      // No image in the clipboard — paste text instead.
      const text = await readClipboardText();
      if (text) return text;
      // Nothing pasteable: if no clipboard tool is installed, hint once.
      if (!clipboardHintShown && !(await hasClipboardTool())) {
        clipboardHintShown = true;
        textarea.writeAbove('\n  ' + chalk.dim(`(${clipboardInstallHint()})`) + '\n');
      }
      return null;
    },
    // Esc on an empty prompt pulls the most recently queued steering message
    // back into the input for editing. We dequeue it from our UI list and
    // re-sync the runtime queue: clear it, then re-queue the survivors in order
    // (their message references are preserved, so future commits still match).
    onSteerDequeue: () => {
      const popped = pendingSteers.pop();
      if (!popped) return null;
      try {
        session.agent.clearSteeringQueue();
        for (const s of pendingSteers) session.agent.steer(s.message);
      } catch {
        // Re-queue failed; the UI list stays authoritative for display.
      }
      return popped.rawText;
    },
    completions,
    getPathCompletions: createPathCompleter(cwd),
  });

  // Surface background-shell completions above the prompt as they happen, so the
  // user sees a dev server crash or a build finishing without polling /bashes.
  session.backgroundShells?.on('exit', (shell: BackgroundShell) => {
    // Skip while a modal viewer (the /bashes panel or job viewer) owns the
    // screen — it shows the change itself; writing here would corrupt it.
    if (!textarea.isActive()) return;
    const icon = shell.status === 'completed' ? chalk.green('✓') : chalk.yellow('●');
    const cmd = shell.command.length > 60 ? shell.command.slice(0, 57) + '…' : shell.command;
    textarea.writeAbove(
      '\n  ' + icon + ' ' + chalk.dim(`${shell.id} ${formatStatus(shell)} — ${cmd}`) + '\n',
    );
  });

  session.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_start': {
        // A queued steering message just got injected into the agent's context
        // — the loop emits message_start with the exact object we handed to
        // steer(). Move it out of the gray "queued" stack and into the
        // scrollback as a real user message (writeAbove redraws, so the stack
        // shrinks too).
        const sIdx = pendingSteers.findIndex((s) => s.message === event.message);
        if (sIdx !== -1) {
          const [committed] = pendingSteers.splice(sIdx, 1);
          textarea.writeAbove('\n' + render.userMessage(committed.rawText) + '\n');
        }
        if (event.message.role === 'assistant') {
          currentText = '';
          markdown = createMarkdownStreamer();
          asstPendingNewlines = '';
          asstAtLineStart = true;
          // The blank that separates prose from the previous block is
          // emitted lazily by processAsstChunk on the first text chunk.
          asstNeedsLead = true;
        }
        break;
      }

      case 'message_update': {
        if (event.message.role !== 'assistant') break;
        const fullText = event.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { type: string; text?: string }) => (c as { text: string }).text)
          .join('');
        if (fullText.length > currentText.length) {
          const delta = fullText.slice(currentText.length);
          const styled = markdown ? markdown.feed(delta) : delta;
          const out = processAsstChunk(styled);
          if (out.length > 0) textarea.writeAbove(out);
          currentText = fullText;
        }
        break;
      }

      case 'message_end':
        if (event.message.role === 'assistant') {
          if (currentText.length > 0) {
            const tail = markdown ? markdown.flush() : '';
            const out = processAsstChunk(tail);
            if (out.length > 0) textarea.writeAbove(out);
            // End the block on a fresh row (column 0). Buffered trailing
            // newlines are discarded — the next card's top_pad provides the
            // separator, so extra LLM newlines would just pile on as blank rows.
            if (!asstAtLineStart) textarea.writeAbove('\n');
            asstPendingNewlines = '';
          }
          // A provider/transport failure ends the turn with stopReason
          // "error" instead of throwing, so the runPrompt catch never fires.
          // Surface it here in themed red so it isn't silently swallowed.
          const msg = event.message as { stopReason?: string; errorMessage?: string };
          if (msg.stopReason === 'error') {
            const detail = (msg.errorMessage ?? '').trim() || session.state.errorMessage || '';
            textarea.writeAbove('\n' + render.errorBlock(detail) + '\n');
          }
        }
        markdown = null;
        break;

      case 'tool_execution_start': {
        // Snapshot the file the write tool is about to overwrite so the
        // tool-end renderer can diff against it instead of dumping the
        // whole new content as additions. null = file didn't exist.
        let priorContent: string | null | undefined;
        if (event.toolName === 'write') {
          try {
            priorContent = readFileSync(
              resolvePath(cwd, String(event.args.path ?? '')),
              'utf-8',
            );
          } catch {
            priorContent = null;
          }
        }
        pendingTools.set(event.toolCallId, {
          args: event.args,
          startedAt: Date.now(),
          priorContent,
        });
        // Blank line above each tool header keeps blocks visually separated
        // without padding inside the block itself (single-spaced bodies).
        textarea.writeAbove('\n' + render.toolStart(event.toolName, event.args) + '\n');
        break;
      }

      case 'tool_execution_end': {
        if (deniedToolCalls.delete(event.toolCallId)) {
          pendingTools.delete(event.toolCallId);
          break;
        }
        const pending = pendingTools.get(event.toolCallId);
        pendingTools.delete(event.toolCallId);
        const args = pending?.args ?? {};
        const resultText = event.result?.content?.[0]?.text ?? '';
        const body = render.toolEnd(event.toolName, args, resultText, event.isError, {
          durationMs: pending ? Date.now() - pending.startedAt : undefined,
          priorContent: pending?.priorContent,
        });
        if (body.length > 0) textarea.writeAbove(body + '\n');
        break;
      }
    }
  });

  await new Promise<void>((resolve) => {
    // Run a command with full terminal control: tear down the sticky textarea,
    // let the command's own UI (select menus, prompts) own stdin, then restore.
    // Returns true if the session should continue, false if it should exit.
    const runWithPause = async (fn: () => Promise<boolean>): Promise<boolean> => {
      textarea.pause();
      try {
        return await fn();
      } finally {
        textarea.resume();
      }
    };

    textarea.on('exit', () => {
      stopSpinner();
      textarea.close();
      resolve();
    });

    // Esc aborts the in-flight run. `prompt()` resolves cleanly on abort (the
    // runtime records an `aborted` stop), so runPrompt's finally clears the
    // busy flag and spinner on its own — we just trigger the abort and note it.
    textarea.on('interrupt', () => {
      if (!agentBusy) return;
      try {
        session.agent.abort();
      } catch {
        // no active run — nothing to abort
      }
      textarea.writeAbove(chalk.yellow('\n  ⎋ Interrupted\n\n'));
    });

    // ── Permission gate ─────────────────────────────────────────────────
    // Runs before every tool call and enforces the active mode:
    //   bypassPermissions — allow everything.
    //   plan              — read-only; mutating tools are blocked, and the
    //                       agent's exit_plan call opens the plan-approval
    //                       prompt (approving switches to acceptEdits).
    //   acceptEdits       — in-cwd edits run silently; out-of-cwd edits and
    //                       every bash command pause on a y/a/n prompt.
    // The SDK policy hook (disallowed_tools) still runs first, so a policy
    // block never reaches a prompt. The pure decision lives in core's
    // classifyInteractive; this layer only owns the prompting + session
    // allow-lists.
    const canPrompt = !!process.stdin.isTTY;
    const alwaysAllowedPrograms = new Set<string>(); // bash first-tokens, "a"-approved
    let allowOutsideEdits = false; // set by "a" on an out-of-cwd write prompt
    const policyHook = session.agent.beforeToolCall;

    // Open an approval box, pin the spinner label while it's up, and return the
    // resolved y/a/n decision (esc/anything-else → 'n').
    const askApproval = async (
      box: string,
      keys: readonly string[] = ['y', 'a', 'n', 'escape'],
    ): Promise<render.ApproveDecision> => {
      textarea.writeAbove('\n' + box + '\n');
      const prevOverride = spinnerOverride;
      spinnerOverride = 'waiting for your approval…';
      let pressed: string;
      try {
        pressed = await textarea.captureKey(keys);
      } finally {
        spinnerOverride = prevOverride;
      }
      return pressed === 'y' || pressed === 'a' ? pressed : 'n';
    };

    session.agent.beforeToolCall = async (ctx, signal) => {
      // disallowed_tools (and any baked policy) always wins.
      const policyResult = policyHook ? await policyHook(ctx, signal) : undefined;
      if (policyResult?.block) return policyResult;

      const args = ctx.args as Record<string, unknown> | null | undefined;
      const decision = classifyInteractive(ctx.toolCall.name, args, {
        mode: perm.mode,
        cwd,
      });

      switch (decision.action) {
        case 'allow':
          return policyResult;

        case 'deny':
          // Plan mode tried to run a mutating tool. Suppress the raw error body
          // and show a concise note; the model sees `reason` as the result.
          deniedToolCalls.add(ctx.toolCall.id);
          textarea.writeAbove(
            '  ' + chalk.yellow('✗ blocked') + chalk.dim(' — plan mode is read-only') + '\n',
          );
          return { block: true, reason: decision.reason };

        case 'approve-plan': {
          const plan = typeof args?.plan === 'string' ? args.plan : '';
          if (!canPrompt) {
            perm.mode = 'acceptEdits';
            return policyResult;
          }
          const pressed = await askApproval(render.planApprovalPrompt(plan), [
            'y',
            'n',
            'escape',
          ]);
          const approved = pressed !== 'n';
          textarea.writeAbove(render.planDecision(approved) + '\n');
          if (approved) {
            // Drop out of plan mode so the implementation the agent runs next
            // (in this same turn) flows through acceptEdits.
            perm.mode = 'acceptEdits';
            return policyResult;
          }
          deniedToolCalls.add(ctx.toolCall.id);
          return {
            block: true,
            reason:
              'User did not approve the plan. Stay in plan mode: do not edit, write, ' +
              'or run commands. Wait for the user to say what to change, then present ' +
              'a revised plan with exit_plan.',
          };
        }

        case 'ask': {
          // No TTY → no keypress can arrive; fall back to allowing.
          if (!canPrompt) return policyResult;

          if (decision.kind === 'bash') {
            const command = String(args?.command ?? '').trim();
            const program = command.split(/\s+/)[0] ?? '';
            if (!command || alwaysAllowedPrograms.has(program)) return policyResult;
            const d = await askApproval(render.approvePrompt({ command, program }));
            textarea.writeAbove(render.approveDecision(d, program) + '\n');
            if (d === 'a') alwaysAllowedPrograms.add(program);
            if (d !== 'n') return policyResult;
            deniedToolCalls.add(ctx.toolCall.id);
            return {
              block: true,
              reason:
                `User denied "$ ${command}" at the approval prompt. Do not retry it ` +
                'verbatim — adjust your approach, or wait for the user to explain.',
            };
          }

          // kind === 'edit-outside': an edit/write targeting a path outside cwd.
          if (allowOutsideEdits) return policyResult;
          const path = toolTargetPath(ctx.toolCall.name, args) ?? String(args?.path ?? '');
          const tool = normalizeToolName(ctx.toolCall.name);
          const d = await askApproval(render.approveWritePrompt({ tool, path }));
          textarea.writeAbove(render.approveWriteDecision(d) + '\n');
          if (d === 'a') allowOutsideEdits = true;
          if (d !== 'n') return policyResult;
          deniedToolCalls.add(ctx.toolCall.id);
          return {
            block: true,
            reason:
              `User denied ${tool} to "${path}" (outside the working directory). ` +
              'Do not retry it — adjust your approach or ask the user.',
          };
        }

        default:
          return policyResult;
      }
    };

    // Submit `text` to the agent as a user prompt, echoing `echo` above the
    // textarea (defaults to echoing `text` itself). Handles spinner + busy flag.
    //
    // In plan mode we prepend a system-reminder of the current mode so the
    // model reliably stays read-only and routes through exit_plan — the base
    // system prompt documents the modes, but only the live reminder tells it
    // which one is active right now.
    const runPrompt = async (
      text: string,
      echo?: string,
      images?: ImageContent[],
    ): Promise<void> => {
      // Leading blank separates the echo from the previous block.
      const imgNote = images && images.length > 0 ? chalk.dim(` 🖼 ${images.length}`) : '';
      textarea.writeAbove('\n' + render.userMessage(echo ?? text) + imgNote + '\n');

      agentBusy = true;
      startSpinner();
      try {
        const payload =
          perm.mode === 'plan'
            ? `<system-reminder>You are in PLAN MODE (read-only). Investigate with read; ` +
              `do not edit, write, or run shell commands. When you have a concrete plan, ` +
              `call the exit_plan tool with it and wait for the user to approve.` +
              `</system-reminder>\n\n${text}`
            : text;
        await session.prompt(payload, images);
      } catch (error) {
        // Most provider failures surface as a stopReason "error" message
        // (handled above); this catches the rarer case where prompt() itself
        // throws (e.g. a transport error before the stream opens).
        const detail = error instanceof Error ? error.message : String(error);
        textarea.writeAbove('\n' + render.errorBlock(detail) + '\n');
      } finally {
        agentBusy = false;
        // Steering messages still queued when the run ends (aborted, errored,
        // or max-turns before the next drain point) were never delivered.
        // Surface them so the text isn't lost, then clear both the UI stack and
        // the runtime queue so they don't linger or leak into the next run.
        if (pendingSteers.length > 0) {
          const undelivered = pendingSteers.map((s) => s.rawText);
          pendingSteers = [];
          try {
            session.agent.clearSteeringQueue();
          } catch {
            // no active queue — nothing to clear
          }
          textarea.writeAbove('\n' + render.undeliveredSteers(undelivered) + '\n');
        }
        stopSpinner();
      }
    };

    const invokeSkill = async (skill: Skill, args: string, echoLabel: string): Promise<void> => {
      let expanded: string;
      try {
        expanded = expandSkillInvocation(skill, args);
      } catch (err) {
        textarea.writeAbove(
          chalk.red('  Failed to load skill: ') +
            (err instanceof Error ? err.message : String(err)) +
            '\n\n',
        );
        return;
      }
      await runPrompt(expanded, echoLabel);
    };

    const cmdCtx: CommandContext = {
      session,
      getProvider: () => activeProvider,
      getModel: () => activeModel,
      setModel: (provider, modelId, model) => {
        activeProvider = provider;
        activeModel = modelId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session.agent.state.model = model as any;
      },
      clearSession: () => {
        try {
          session.agent.abort();
        } catch {
          // no active run — nothing to abort
        }
        session.agent.reset();
        pendingTools.clear();
        pendingImages = [];
        // reset() clears the runtime steering queue; drop the matching UI stack.
        pendingSteers = [];
        currentText = '';
        markdown = null;
        asstPendingNewlines = '';
        asstAtLineStart = true;
        asstNeedsLead = false;
        // Clear the visible screen (ESC[2J) and move cursor home (ESC[H),
        // then reprint the static header so the session starts fresh.
        process.stdout.write('\x1B[2J\x1B[H');
        process.stdout.write(
          render.header({ provider: activeProvider, model: activeModel, cwd }),
        );
      },
      ensureBundledSkills,
      invokeSkill,
      writeAbove: (text) => textarea.writeAbove(text),
    };

    // Run a command action. Commands with pause:false stay live on the textarea
    // (needed when the action triggers an agent run via invokeSkill); otherwise
    // the textarea is torn down so the command can own stdin for its own UI.
    const runCommand = (match: SlashCommandMatch): Promise<boolean> =>
      match.cmd.pause === false
        ? match.cmd.action(cmdCtx, match.args)
        : runWithPause(() => match.cmd.action(cmdCtx, match.args));

    textarea.on('submit', async (input: string) => {
      // Allow an image-only submit (empty text) when an image is attached.
      if (!input && pendingImages.length === 0) return;

      if (input === '/' && !agentBusy) {
        let skillToInvoke: Skill | undefined;
        let commandToRun: SlashCommand | undefined;
        const shouldContinue = await runWithPause(async () => {
          const selected = await selectSlashCommandOrSkill(session.skills);
          if (!selected) return true;
          if (selected.kind === 'command') {
            // If the command wants to stay live (e.g. /init), defer its action
            // until after we've resumed the textarea.
            if (selected.command.pause === false) {
              commandToRun = selected.command;
              return true;
            }
            return selected.command.action(cmdCtx, '');
          }
          skillToInvoke = selected.skill;
          return true;
        });
        if (!shouldContinue) {
          stopSpinner();
          textarea.close();
          resolve();
          return;
        }
        if (commandToRun) {
          const cont = await commandToRun.action(cmdCtx, '');
          if (!cont) {
            stopSpinner();
            textarea.close();
            resolve();
            return;
          }
        }
        if (skillToInvoke) {
          await invokeSkill(skillToInvoke, '', `/skill:${skillToInvoke.name}`);
        }
        return;
      }

      if (input.startsWith('/skill:') && !agentBusy) {
        const rest = input.slice('/skill:'.length);
        const spaceIdx = rest.search(/\s/);
        const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
        const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
        const skill = findSkill(session.skills, name);
        if (!skill) {
          textarea.writeAbove(
            chalk.red(`  Unknown skill: ${name}`) +
              '\n' +
              chalk.dim('  Type / to see available skills') +
              '\n\n',
          );
          return;
        }
        await invokeSkill(skill, args, input);
        return;
      }

      if (input.startsWith('/') && !agentBusy) {
        const match = findSlashCommand(input);
        if (match) {
          const shouldContinue = await runCommand(match);
          if (!shouldContinue) {
            stopSpinner();
            textarea.close();
            resolve();
          }
        } else {
          textarea.writeAbove(
            chalk.yellow(`  Unknown command: ${input}`) +
              '\n' +
              chalk.dim('  Type /help to see available commands') +
              '\n\n',
          );
        }
        return;
      }

      // Mid-run submit → queue as a steering message for the live turn rather
      // than starting a new prompt. It shows as a gray "queued" line above the
      // input (it is not yet part of the agent's context) until the agent
      // consumes it at the next turn boundary, at which point message_start
      // commits it to the scrollback as a normal user message. Esc on an empty
      // input peels the most recent queued message back for editing.
      if (agentBusy) {
        const message: AgentMessage = {
          role: 'user',
          content: expandAtMentions(input, cwd),
          timestamp: Date.now(),
        };
        try {
          session.agent.steer(message);
        } catch (err) {
          textarea.writeAbove(
            chalk.red('  Steering failed: ') +
              (err instanceof Error ? err.message : String(err)) +
              '\n\n',
          );
          return;
        }
        pendingSteers.push({ message, rawText: input });
        textarea.redraw();
        return;
      }

      // Expand @-mentions into the agent payload; keep the raw text as the echo.
      // Attach (and clear) any Ctrl+V-pasted images.
      const images = pendingImages;
      pendingImages = [];
      await runPrompt(
        expandAtMentions(input, cwd),
        input || chalk.dim('🖼 (image)'),
        images.length > 0 ? images : undefined,
      );
    });
  });

  process.stdin.unref();
}
