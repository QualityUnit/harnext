import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AgentEvent } from '@mariozechner/pi-agent-core';
import {
  compactNow,
  ensureBundledSkills,
  estimateTotalTokens,
  listAgentRunLogs,
  reconstructMessagesFromRunLog,
  setDefault,
} from '@harnext/core';
import type { AgentRunLogSummary, EnsureResult } from '@harnext/core';
import chalk from 'chalk';

import { runConnectGithubCommand } from '../../cli/github-prompt.js';
import { runHeartbeatCommand } from '../../cli/heartbeat-prompt.js';
import { runMcpPanel } from './mcp-panel.js';
import { createTextarea } from '../../cli/input.js';
import type { Textarea } from '../../cli/input.js';
import { pickModel } from '../../cli/model-picker.js';
import { select } from '../../cli/select.js';
import type { SelectItem } from '../../cli/select.js';
import type { AgentSession, Skill } from '@harnext/core';
import { createMarkdownStreamer } from './markdown-stream.js';
import type { MarkdownStreamer } from './markdown-stream.js';
import * as render from './render.js';

export interface InteractiveModeOptions {
  provider: string;
  model: string;
}

// ── Slash command registry ───────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
  /** If false, the textarea stays live during the action (default true pauses it for interactive prompts). */
  pause?: boolean;
  action: (ctx: CommandContext) => Promise<boolean>; // true = continue, false = exit
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

const SLASH_COMMANDS: SlashCommand[] = [
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
    name: '/compact',
    description: 'Compact conversation history',
    action: async (ctx) => {
      const spinner = render.startSpinner('Compacting...');
      try {
        const result = await compactNow(ctx.session.agent);
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
          console.log(chalk.dim('  Not enough messages to compact.'));
        }
      } catch {
        spinner.stop();
        console.log(chalk.red('  Compaction failed.'));
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
    name: '/help',
    description: 'Show available commands',
    action: async () => {
      console.log();
      console.log(chalk.bold('  Commands:'));
      for (const cmd of SLASH_COMMANDS) {
        const pad = 10 - cmd.name.length;
        console.log(
          chalk.cyan(`  ${cmd.name}`) + ' '.repeat(pad) + chalk.dim(`— ${cmd.description}`),
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

function findSlashCommand(input: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((cmd) => cmd.name === input);
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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
];

function randomMessage(): string {
  return LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
}

// Sum input/output tokens across all assistant turns in the session.
// Each turn's `input` is cumulative context sent to the model — summing
// across turns reflects total tokens consumed, not unique tokens.
function sumSessionUsage(
  messages: ReadonlyArray<{ role: string; usage?: { input?: number; output?: number } }>,
): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const u = msg.usage;
    if (!u) continue;
    input += u.input ?? 0;
    output += u.output ?? 0;
  }
  return { input, output };
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
  const pendingToolArgs: Map<string, Record<string, unknown>> = new Map();
  let currentText = '';
  let markdown: MarkdownStreamer | null = null;
  let agentBusy = false;

  // Assistant-text streaming state. `asstPendingNewlines` holds trailing
  // newlines from recent chunks so we don't emit them yet — if the stream
  // ends with more trailing newlines than we want, we just drop them.
  // `asstAtLineStart` tracks whether the cursor is at column 0 of a fresh
  // row, used by message_end to decide whether to emit a final '\n'.
  let asstPendingNewlines = '';
  let asstAtLineStart = true;

  function processAsstChunk(styled: string): string {
    if (styled.length === 0) return '';
    const combined = asstPendingNewlines + styled;
    const m = combined.match(/\n+$/);
    const toWrite = m ? combined.slice(0, -m[0].length) : combined;
    asstPendingNewlines = m ? m[0] : '';
    if (toWrite.length === 0) return '';
    asstAtLineStart = toWrite.endsWith('\n');
    return toWrite;
  }

  let spinnerPrefix = '';
  let spinnerMsg = '';
  let spinnerFrame = 0;
  let spinnerLastCycle = 0;
  let spinnerTimer: NodeJS.Timeout | null = null;

  // Print the static header before the textarea — it stays above content
  // and scrolls out naturally as the session grows.
  process.stdout.write(render.header());

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
    if (Date.now() - spinnerLastCycle >= CYCLE_MS) {
      let next = randomMessage();
      while (next === spinnerMsg && LOADING_MESSAGES.length > 1) next = randomMessage();
      spinnerMsg = next;
      spinnerLastCycle = Date.now();
    }
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    spinnerFrame++;
    spinnerPrefix = `  ${chalk.cyan(frame)} ${chalk.dim(spinnerMsg)}`;
    textarea.redraw();
  }

  function startSpinner() {
    if (spinnerTimer) return;
    spinnerMsg = randomMessage();
    spinnerLastCycle = Date.now();
    spinnerFrame = 0;
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
      const sep = render.separator(chalk.magenta);
      const body = spinnerPrefix ? `${spinnerPrefix}\n${sep}` : sep;
      return `\n${body}`;
    },
    getBottomBorder: () => {
      const ctxTokens = estimateTotalTokens(session.messages);
      const ctxWindow = session.agent.state.model.contextWindow;
      const ctxPercent = ctxWindow ? (ctxTokens / ctxWindow) * 100 : undefined;
      const { input, output } = sumSessionUsage(session.messages);
      return render.inputFooter(
        activeProvider,
        activeModel,
        cwd,
        ctxPercent,
        input,
        output,
      );
    },
    completions,
  });

  session.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          currentText = '';
          markdown = createMarkdownStreamer();
          asstPendingNewlines = '';
          asstAtLineStart = true;
          // Leading blank separates assistant text from whatever preceded
          // (user msg, tool-end card, or another assistant message).
          textarea.writeAbove('\n');
        }
        break;

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
        if (event.message.role === 'assistant' && currentText.length > 0) {
          const tail = markdown ? markdown.flush() : '';
          const out = processAsstChunk(tail);
          if (out.length > 0) textarea.writeAbove(out);
          // End the block on a fresh row (column 0). Buffered trailing
          // newlines are discarded — the next card's top_pad provides the
          // separator, so extra LLM newlines would just pile on as blank rows.
          if (!asstAtLineStart) textarea.writeAbove('\n');
          asstPendingNewlines = '';
        }
        markdown = null;
        break;

      case 'tool_execution_start': {
        pendingToolArgs.set(event.toolCallId, event.args);
        // The card's own top padding (blank tinted row) supplies the separation
        // from whatever preceded — adding a leading '\n' here would stack a
        // plain blank row on top of that and read as excess whitespace.
        textarea.writeAbove(render.toolStart(event.toolName, event.args) + '\n');
        break;
      }

      case 'tool_execution_end': {
        const args = pendingToolArgs.get(event.toolCallId) ?? {};
        pendingToolArgs.delete(event.toolCallId);
        const resultText = event.result?.content?.[0]?.text ?? '';
        textarea.writeAbove(
          render.toolEnd(event.toolName, args, resultText, event.isError) + '\n',
        );
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

    // Submit `text` to the agent as a user prompt, echoing `echo` above the
    // textarea (defaults to echoing `text` itself). Handles spinner + busy flag.
    const runPrompt = async (text: string, echo?: string): Promise<void> => {
      textarea.writeAbove(render.userMessage(echo ?? text) + '\n');
      agentBusy = true;
      startSpinner();
      try {
        await session.prompt(text);
      } catch (error) {
        textarea.writeAbove(
          chalk.red('  Error: ') +
            (error instanceof Error ? error.message : String(error)) +
            '\n\n',
        );
      } finally {
        agentBusy = false;
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
        pendingToolArgs.clear();
        currentText = '';
        markdown = null;
        asstPendingNewlines = '';
        asstAtLineStart = true;
        // Clear the visible screen (ESC[2J) and move cursor home (ESC[H),
        // then reprint the static header so the session starts fresh.
        process.stdout.write('\x1B[2J\x1B[H');
        process.stdout.write(render.header());
      },
      ensureBundledSkills,
      invokeSkill,
      writeAbove: (text) => textarea.writeAbove(text),
    };

    // Run a command action. Commands with pause:false stay live on the textarea
    // (needed when the action triggers an agent run via invokeSkill); otherwise
    // the textarea is torn down so the command can own stdin for its own UI.
    const runCommand = (cmd: SlashCommand): Promise<boolean> =>
      cmd.pause === false ? cmd.action(cmdCtx) : runWithPause(() => cmd.action(cmdCtx));

    textarea.on('submit', async (input: string) => {
      if (!input) return;

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
            return selected.command.action(cmdCtx);
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
          const cont = await commandToRun.action(cmdCtx);
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
        const cmd = findSlashCommand(input);
        if (cmd) {
          const shouldContinue = await runCommand(cmd);
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

      // Mid-run submit → queue as steering rather than starting a new prompt.
      if (agentBusy) {
        textarea.writeAbove(render.userMessage(input) + '\n');
        try {
          session.agent.steer({
            role: 'user',
            content: input,
            timestamp: Date.now(),
          });
        } catch (err) {
          textarea.writeAbove(
            chalk.red('  Steering failed: ') +
              (err instanceof Error ? err.message : String(err)) +
              '\n\n',
          );
        }
        return;
      }

      await runPrompt(input);
    });
  });

  process.stdin.unref();
}
