import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import chalk from 'chalk';
import { z } from 'zod';

import { logger } from '../ui/logger.js';
import { printBanner } from '../ui/banner.js';
import { withSpinner } from '../ui/spinner.js';
import { confirmPrompt, selectPrompt, inputPrompt } from '../ui/prompts.js';
import { borderedInput } from '../ui/bordered-input.js';
import type { SlashCommand } from '../ui/bordered-input.js';
import { isGitRepo, getRepoRoot, hasUncommittedChanges } from '../utils/git.js';
import { readFileIfExists } from '../utils/fs.js';
import { NotAGitRepoError } from '../utils/errors.js';
import { validatePlatformCLI } from '../core/runner-factory.js';
import { generateBranchName, createWorktree } from '../core/worktree.js';
import { openInNewTerminal } from '../core/terminal.js';
import type { PromptEntry } from '../core/prompt-store.js';
import { PromptStore } from '../core/prompt-store.js';

type ReplAction =
  | { type: 'prompt'; name: string }
  | { type: 'command'; name: string }
  | { type: 'task'; task: string };

const packageJsonSchema = z.object({
  scripts: z
    .object({
      test: z.string().optional(),
      build: z.string().optional(),
      lint: z.string().optional(),
      typecheck: z.string().optional(),
    })
    .optional(),
});

/**
 * Escape a string for safe embedding in a single-quoted bash string.
 * Wraps the value in single quotes, escaping any embedded single quotes
 * so that command substitution ($(), backticks) cannot fire.
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function extractHarnessCommands(
  worktreePath: string,
): Promise<{ test: string; build: string; lint: string; typeCheck: string } | null> {
  const raw = await readFileIfExists(join(worktreePath, 'package.json'));
  if (!raw) return null;

  try {
    const parsed = packageJsonSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const s = parsed.data.scripts;
    if (!s) return null;

    return {
      test: s.test ? 'npm test' : '',
      build: s.build ? 'npm run build' : '',
      lint: s.lint ? 'npm run lint' : '',
      typeCheck: s.typecheck ? 'npm run typecheck' : '',
    };
  } catch {
    return null;
  }
}

function buildQualityGates(
  commands: { test: string; build: string; lint: string; typeCheck: string } | null,
): string {
  if (!commands) {
    return '- Check package.json for available scripts (test, lint, build, typecheck)';
  }

  const gates: string[] = [];
  let i = 1;

  if (commands.lint) {
    gates.push(`${i}. \`${commands.lint}\``);
    i++;
  }
  if (commands.typeCheck) {
    gates.push(`${i}. \`${commands.typeCheck}\``);
    i++;
  }
  if (commands.test) {
    gates.push(`${i}. \`${commands.test}\``);
    i++;
  }
  if (commands.build) {
    gates.push(`${i}. \`${commands.build}\``);
    i++;
  }

  return gates.length > 0
    ? gates.join('\n')
    : '- Check package.json for available scripts (test, lint, build, typecheck)';
}

function buildCommandChoices(prompts: PromptEntry[]) {
  return [
    ...prompts.map((p) => ({
      name: `/${p.name}`,
      value: { type: 'prompt' as const, name: p.name },
      description: p.description,
    })),
    {
      name: '/init',
      value: { type: 'command' as const, name: 'init' },
      description: 'Run harness engineering setup',
    },
    {
      name: '/help',
      value: { type: 'command' as const, name: 'help' },
      description: 'Show help',
    },
    {
      name: '/exit',
      value: { type: 'command' as const, name: 'exit' },
      description: 'Exit CodeFactory',
    },
  ];
}

function showHelp(): void {
  console.log();
  console.log(chalk.bold('Usage:'));
  console.log('  Type a task description and press Enter to spawn Claude in a worktree.');
  console.log('  Type / to browse agent prompts and commands.');
  console.log('  Arrow keys to navigate, Enter to select.');
  console.log();
  console.log(chalk.bold('Prompts:'));
  console.log('  Select a prompt to view, edit in $EDITOR, or reset to default.');
  console.log('  Prompts are stored in .codefactory/prompts/ and shared with your team.');
}

async function promptActions(store: PromptStore, name: string): Promise<void> {
  const customized = await store.isCustomized(name);
  const badge = customized ? chalk.yellow(' (customized)') : '';

  const action = await selectPrompt<string>(`${chalk.bold(name)}${badge}:`, [
    { name: 'Edit in $EDITOR', value: 'edit' },
    { name: 'View contents', value: 'view' },
    { name: 'Reset to default', value: 'reset' },
    { name: chalk.dim('Back'), value: 'back' },
  ]);

  if (action === 'back') return;

  if (action === 'edit') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const path = store.getPath(name);
    spawnSync(editor, [path], { stdio: 'inherit' });
    logger.success(`Prompt "${name}" saved.`);
  } else if (action === 'view') {
    const content = await store.read(name);
    console.log();
    console.log(chalk.dim('\u2500'.repeat(60)));
    console.log(content);
    console.log(chalk.dim('\u2500'.repeat(60)));
    console.log();
  } else if (action === 'reset') {
    const confirmed = await confirmPrompt(
      `Reset "${name}" to default? This will overwrite your changes.`,
      false,
    );
    if (confirmed) {
      await store.resetToDefault(name);
      logger.success(`Prompt "${name}" reset to default.`);
    }
  }
}

async function handleTask(task: string, repoRoot: string, store: PromptStore): Promise<void> {
  if (await hasUncommittedChanges(repoRoot)) {
    logger.warn('You have uncommitted changes in your working tree.');
    const proceed = await confirmPrompt('Continue anyway?', false);
    if (!proceed) return;
  }

  // Generate suggested branch name
  const suggestedBranch = await withSpinner('Generating branch name...', () =>
    generateBranchName(task),
  );

  const branchName = await inputPrompt('Branch name:', suggestedBranch);
  if (!branchName.trim()) {
    logger.error('No branch name provided. Aborting.');
    return;
  }

  const proceed = await confirmPrompt('Create worktree and start Claude?', true);
  if (!proceed) return;

  const worktree = await withSpinner('Creating git worktree...', () =>
    createWorktree(repoRoot, branchName.trim()),
  );

  // Build system prompt from prompt store
  const template = await store.read('agent-system');
  const harnessCommands = await extractHarnessCommands(worktree.path);
  const qualityGates = buildQualityGates(harnessCommands);
  const systemPrompt = template
    .replace(/\{\{branchName\}\}/g, () => branchName.trim())
    .replace(/\{\{qualityGates\}\}/g, () => qualityGates);

  // Write launcher files to worktree
  const cfDir = join(worktree.path, '.codefactory');
  await mkdir(cfDir, { recursive: true });
  const promptFile = join(cfDir, 'system-prompt');
  const taskFile = join(cfDir, 'task');
  const launcherFile = join(cfDir, 'launch.sh');

  await writeFile(promptFile, systemPrompt, 'utf-8');
  await writeFile(taskFile, task, 'utf-8');
  await writeFile(
    launcherFile,
    [
      '#!/bin/bash',
      `PROMPT=$(<${shellEscape(promptFile)})`,
      `TASK=$(<${shellEscape(taskFile)})`,
      'exec claude --dangerously-skip-permissions --append-system-prompt "$PROMPT" "$TASK"',
      '',
    ].join('\n'),
    'utf-8',
  );
  await chmod(launcherFile, 0o755);

  await openInNewTerminal(`bash ${shellEscape(launcherFile)}`, worktree.path);

  console.log();
  logger.success('Claude opened in new terminal.');
  console.log();
  logger.info(`Worktree: ${worktree.path}`);
  logger.info(`Branch:   ${branchName.trim()}`);
  console.log();
  logger.dim('When done, clean up with:');
  logger.dim(`  git worktree remove "${worktree.path}"`);
  logger.dim(`  git branch -D ${branchName.trim()}`);
}

export async function replCommand(): Promise<void> {
  if (!(await isGitRepo())) {
    throw new NotAGitRepoError();
  }

  validatePlatformCLI('claude');

  const repoRoot = await getRepoRoot();
  const store = new PromptStore(repoRoot);
  await store.ensureDefaults();

  printBanner();

  const allCommands = buildCommandChoices(store.list());
  const slashCommands: SlashCommand[] = allCommands.map((c) => ({
    name: c.name.slice(1),
    description: c.description,
  }));

  const ACCENT = '#FF8C00';

  // Main loop
  while (true) {
    try {
      const raw = await borderedInput({
        hint: 'Type a task, or /command for saved prompts',
        accentColor: ACCENT,
        commands: slashCommands,
      });

      if (!raw) continue;

      if (raw.startsWith('/')) {
        const filter = raw.slice(1).toLowerCase();

        // Check for exact match first (e.g., user Tab-completed a command)
        const exactMatch = allCommands.find((c) => c.name.slice(1).toLowerCase() === filter);

        let action: ReplAction;

        if (exactMatch) {
          action = exactMatch.value;
        } else {
          // Filter commands by what was typed after "/"
          const filtered = filter
            ? allCommands.filter((c) => c.name.slice(1).toLowerCase().includes(filter))
            : allCommands;

          if (filtered.length === 0) {
            logger.warn(`No command found for "${raw}"`);
            console.log();
            continue;
          }

          action = await selectPrompt<ReplAction>(
            'Select command:',
            filtered.map((c) => ({ name: c.name, value: c.value })),
          );
        }

        if (action.type === 'prompt') {
          await promptActions(store, action.name);
        } else if (action.type === 'command') {
          if (action.name === 'init') {
            const { initCommand } = await import('./init.js');
            await initCommand({});
          } else if (action.name === 'help') {
            showHelp();
          } else if (action.name === 'exit') {
            process.exit(0);
          }
        }
      } else {
        await handleTask(raw, repoRoot, store);
      }

      console.log();
    } catch (error) {
      // ExitPromptError is thrown when user presses Ctrl+C in an inquirer prompt
      if (error instanceof Error && error.constructor.name === 'ExitPromptError') {
        process.exit(0);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      console.log();
    }
  }
}
