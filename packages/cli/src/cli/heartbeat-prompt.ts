import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';

import chalk from 'chalk';
import {
  HEARTBEAT_INTERVAL_PRESETS,
  buildCronLine,
  buildCronSchedule,
  deleteHeartbeatConfig,
  findCronLine,
  getHeartbeatPaths,
  getHeartbeatTag,
  installCronLine,
  listHeartbeats,
  loadHeartbeatConfig,
  removeCronLine,
  saveHeartbeatConfig,
  validateHeartbeatName,
  type HeartbeatConfig,
  type HeartbeatIntervalMinutes,
} from '@harnext/core';

import { select } from './select.js';
import type { SelectItem } from './select.js';

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return 'hourly';
  if (minutes < 1440) return `every ${minutes / 60}h`;
  return 'daily';
}

function statusFor(cfg: HeartbeatConfig): string {
  const cronLine = findCronLine(getHeartbeatTag(cfg.cwd, cfg.name));
  const interval = formatInterval(cfg.intervalMinutes);
  return cronLine
    ? chalk.dim(`${interval} · cron installed`)
    : chalk.yellow(`${interval} · cron missing`);
}

async function pickInterval(
  current?: number,
): Promise<HeartbeatIntervalMinutes | undefined> {
  const items: SelectItem<HeartbeatIntervalMinutes>[] = HEARTBEAT_INTERVAL_PRESETS.map((m) => ({
    label: formatInterval(m),
    value: m,
    hint: current === m ? 'current' : buildCronSchedule(m),
  }));
  return select(items, { title: 'Pick a heartbeat interval (esc to cancel)' });
}

async function pickName(existingNames: Set<string>): Promise<string | undefined> {
  while (true) {
    const answer = (await readLine(chalk.cyan('  name: '))).trim();
    if (!answer) return undefined;
    const err = validateHeartbeatName(answer);
    if (err) {
      console.log(chalk.red(`  ${err}`));
      continue;
    }
    if (existingNames.has(answer)) {
      console.log(chalk.red(`  "${answer}" already exists — pick a different name`));
      continue;
    }
    return answer;
  }
}

async function pickPrompt(current?: string): Promise<string | undefined> {
  if (current) console.log(chalk.dim(`  current: ${current}`));
  const answer = await readLine(chalk.cyan('  prompt: '));
  const trimmed = answer.trim();
  return trimmed || undefined;
}

async function confirm(question: string): Promise<boolean> {
  const answer = await readLine(chalk.cyan(`  ${question} [y/N]: `));
  return /^y(es)?$/i.test(answer.trim());
}

export interface HeartbeatPromptOptions {
  cwd: string;
  /** Absolute path to the harnext CLI entrypoint (process.argv[1]). */
  cliPath: string;
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
}

/**
 * Top-level /heartbeat flow. Assumes the caller has paused its sticky input
 * so stdin is free. Offers list → (create | edit | remove | view log).
 */
export async function runHeartbeatCommand(opts: HeartbeatPromptOptions): Promise<void> {
  const heartbeats = listHeartbeats(opts.cwd);

  console.log();
  if (heartbeats.length === 0) {
    console.log(chalk.bold('  No heartbeats configured for this project.'));
  } else {
    console.log(chalk.bold(`  Heartbeats for this project (${heartbeats.length}):`));
    for (const cfg of heartbeats) {
      console.log(`    ${chalk.cyan(cfg.name)}  ${statusFor(cfg)}`);
      console.log(chalk.dim(`      ${cfg.prompt}`));
    }
  }
  console.log();

  type TopAction =
    | { kind: 'create' }
    | { kind: 'edit'; name: string }
    | { kind: 'remove'; name: string }
    | { kind: 'view'; name: string }
    | { kind: 'cancel' };

  const items: SelectItem<TopAction>[] = [
    { label: 'Create', value: { kind: 'create' }, hint: 'add a new heartbeat' },
  ];
  for (const cfg of heartbeats) {
    items.push({
      label: `Edit ${cfg.name}`,
      value: { kind: 'edit', name: cfg.name },
      hint: 'change interval or prompt',
    });
    items.push({
      label: `Remove ${cfg.name}`,
      value: { kind: 'remove', name: cfg.name },
      hint: 'uninstall the cron entry',
    });
    items.push({
      label: `View ${cfg.name} log`,
      value: { kind: 'view', name: cfg.name },
      hint: 'last 20 tick records',
    });
  }
  items.push({ label: 'Cancel', value: { kind: 'cancel' } });

  const action = await select(items, { title: 'What do you want to do?' });
  if (!action || action.kind === 'cancel') {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  switch (action.kind) {
    case 'create':
      await createFlow(opts, new Set(heartbeats.map((c) => c.name)));
      return;
    case 'edit': {
      const cfg = loadHeartbeatConfig(opts.cwd, action.name);
      if (!cfg) {
        console.log(chalk.red(`  Heartbeat "${action.name}" not found.`));
        console.log();
        return;
      }
      await editFlow(opts, cfg);
      return;
    }
    case 'remove':
      await removeFlow(opts, action.name);
      return;
    case 'view':
      await viewLog(opts, action.name);
      return;
  }
}

async function createFlow(
  opts: HeartbeatPromptOptions,
  existingNames: Set<string>,
): Promise<void> {
  console.log(chalk.dim('  Names are lowercase a-z, 0-9, hyphens (max 32 chars).'));
  const name = await pickName(existingNames);
  if (!name) {
    console.log(chalk.dim('  Cancelled (empty name).'));
    console.log();
    return;
  }

  const interval = await pickInterval();
  if (!interval) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  const prompt = await pickPrompt();
  if (!prompt) {
    console.log(chalk.dim('  Cancelled (empty prompt).'));
    console.log();
    return;
  }

  await installFlow(opts, { name, intervalMinutes: interval, prompt });
}

async function editFlow(opts: HeartbeatPromptOptions, current: HeartbeatConfig): Promise<void> {
  const interval = await pickInterval(current.intervalMinutes);
  if (!interval) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  console.log(chalk.dim('  Leave empty to keep the current prompt.'));
  const promptInput = (await readLine(chalk.cyan('  prompt: '))).trim();
  const prompt = promptInput.length > 0 ? promptInput : current.prompt;

  await installFlow(opts, { name: current.name, intervalMinutes: interval, prompt });
}

async function installFlow(
  opts: HeartbeatPromptOptions,
  draft: { name: string; intervalMinutes: HeartbeatIntervalMinutes; prompt: string },
): Promise<void> {
  const schedule = buildCronSchedule(draft.intervalMinutes);
  const tag = getHeartbeatTag(opts.cwd, draft.name);
  const cronLine = buildCronLine({
    schedule,
    cliPath: opts.cliPath,
    cwd: opts.cwd,
    name: draft.name,
    tag,
    nodePath: opts.nodePath,
    path: process.env.PATH,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  });

  console.log();
  console.log(chalk.bold('  Ready to install:'));
  console.log(chalk.dim(`    ${cronLine}`));
  console.log();

  if (!(await confirm('Install this heartbeat?'))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  const cfg: HeartbeatConfig = {
    name: draft.name,
    intervalMinutes: draft.intervalMinutes,
    prompt: draft.prompt,
    cwd: opts.cwd,
    updatedAt: Date.now(),
  };

  try {
    saveHeartbeatConfig(cfg);
    installCronLine(cronLine, tag);
    console.log(chalk.green(`  Heartbeat "${draft.name}" installed.`));
    const { config, log } = getHeartbeatPaths(opts.cwd, draft.name);
    console.log(chalk.dim(`    config: ${config}`));
    console.log(chalk.dim(`    log:    ${log}`));
    console.log();
  } catch (err) {
    console.log(
      chalk.red('  Failed to install heartbeat: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    console.log(chalk.dim('  If this machine has no `crontab`, install cron first.'));
    console.log();
  }
}

async function removeFlow(opts: HeartbeatPromptOptions, name: string): Promise<void> {
  if (!(await confirm(`Remove heartbeat "${name}"?`))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  const tag = getHeartbeatTag(opts.cwd, name);
  try {
    removeCronLine(tag);
  } catch (err) {
    console.log(
      chalk.red('  Failed to update crontab: ') +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  deleteHeartbeatConfig(opts.cwd, name);
  console.log(chalk.green(`  Heartbeat "${name}" removed.`));
  console.log();
}

async function viewLog(opts: HeartbeatPromptOptions, name: string): Promise<void> {
  const { log } = getHeartbeatPaths(opts.cwd, name);
  if (!existsSync(log)) {
    console.log(chalk.dim(`  No log yet at ${log}.`));
    console.log();
    return;
  }
  const lines = readFileSync(log, 'utf-8').trim().split('\n').slice(-20);
  console.log();
  console.log(chalk.bold(`  Last ${lines.length} ticks for "${name}":`));
  for (const raw of lines) {
    try {
      const rec = JSON.parse(raw) as {
        ts: string;
        exit: number;
        durationMs: number;
        output?: string;
        error?: string;
      };
      const status =
        rec.exit === 0
          ? chalk.green('ok')
          : rec.exit === 2
            ? chalk.yellow('tool-err')
            : chalk.red('fail');
      const summary = rec.error ?? (rec.output ?? '').split('\n')[0] ?? '';
      console.log(
        `    ${chalk.dim(rec.ts)}  ${status}  ${chalk.dim(`${rec.durationMs}ms`)}  ${summary.slice(0, 80)}`,
      );
    } catch {
      console.log(chalk.dim(`    ${raw}`));
    }
  }
  console.log();
}
