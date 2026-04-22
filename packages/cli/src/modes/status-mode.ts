/**
 * `harnext status` — live view of active coding-agent runs.
 *
 * Two forms:
 *   - Non-TTY (piped, CI): print a flat summary, exit.
 *   - TTY: interactive drill-down — pick a worktree → pick a file → view diff,
 *     Escape to go back, Escape from top level to exit.
 *
 * Sources:
 *   - `listWorktreeRecords` for registered worktrees.
 *   - `ps -eo pid,etime,cmd` for live external coding-agent processes
 *     (argv carries `Stage:` and `Number: #NN` so we can attribute them).
 *   - `git status --short` for pending edits in each worktree.
 *   - `git diff HEAD -- <path>` (or `cat` for untracked) for per-file diffs.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import chalk from 'chalk';

import { listWorktreeRecords, type WorktreeRecord } from '@harnext/core';

import { select, type SelectItem } from '../cli/select.js';

export interface StatusModeOptions {
  cwd: string;
}

interface RunningStage {
  stage: string;
  pid: string;
  elapsed: string;
  binary: string;
}

interface ChangedFile {
  /** Two-char porcelain status (e.g. " M", "M ", "??", "R "). */
  code: string;
  /** Path relative to worktree root. For renames this is the *new* path. */
  path: string;
  /** Old path for renames, when available. */
  oldPath?: string;
}

function detectRunningStages(): Map<number, RunningStage[]> {
  const map = new Map<number, RunningStage[]>();
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid,etime,cmd', '--no-headers'], {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return map;
  }
  // Matches both `claude -p "..."` and `codex exec ... "..."` — `Stage:` and
  // `Number: #NN` live in the single prompt argv chunk either way.
  const re =
    /^\s*(\d+)\s+(\S+)\s+(?:.*?)\b(claude|codex)\b[^\n]*?\bStage:\s*(\w+)\.[^\n]*?\bNumber:\s*#(\d+)/;
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const [, pid, elapsed, binary, stage, itemStr] = m;
    const item = Number(itemStr);
    if (!Number.isFinite(item)) continue;
    const list = map.get(item) ?? [];
    list.push({ stage, pid, elapsed, binary });
    map.set(item, list);
  }
  return map;
}

function gitCurrentBranch(path: string): string | undefined {
  try {
    return execFileSync('git', ['-C', path, 'branch', '--show-current'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * `git status -z --short` returns NUL-separated records. For renames the record
 * is `XY old\0new\0...`. We parse this robustly rather than splitting on spaces,
 * which would break on paths containing spaces.
 */
function gitChangedFiles(path: string): ChangedFile[] | undefined {
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', path, 'status', '-z', '--porcelain'], {
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  const out: ChangedFile[] = [];
  // Records are NUL-separated. Rename records consume two NUL-separated slots
  // (new path, then old path).
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.length < 3) continue;
    const code = rec.slice(0, 2);
    const rest = rec.slice(3); // skip the space separator
    if (code[0] === 'R' || code[0] === 'C') {
      // rename/copy: next slot is the old path
      const oldPath = parts[++i] ?? '';
      out.push({ code, path: rest, oldPath });
    } else {
      out.push({ code, path: rest });
    }
  }
  return out;
}

/** Render the non-interactive summary (the shape we had before). */
function printSummary(records: WorktreeRecord[], running: Map<number, RunningStage[]>): void {
  const sorted = [...records].sort((a, b) => a.itemNumber - b.itemNumber);
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) lines.push('');
    const rec = sorted[i];
    const branch = gitCurrentBranch(rec.path) ?? rec.branch;
    lines.push(`${chalk.bold(`#${rec.itemNumber}`)} ${chalk.dim(`(${rec.itemKind})`)}  ${chalk.cyan(branch)}`);
    lines.push(`  ${chalk.dim('path:')}        ${rec.path}`);
    lines.push(`  ${chalk.dim('lastStageAt:')} ${rec.lastStageAt}`);
    for (const r of running.get(rec.itemNumber) ?? []) {
      lines.push(
        `  ${chalk.green('RUNNING')}     ${chalk.bold(r.stage)}  pid=${r.pid}  elapsed=${r.elapsed}  agent=${r.binary}`,
      );
    }
    if (!running.has(rec.itemNumber)) {
      lines.push(`  ${chalk.dim('no active run')}`);
    }
    const files = gitChangedFiles(rec.path);
    if (files === undefined) {
      lines.push(`  ${chalk.yellow('git status unavailable')}`);
    } else if (files.length === 0) {
      lines.push(`  ${chalk.dim('(clean)')}`);
    } else {
      for (const f of files) {
        lines.push(`  ${f.code} ${f.path}`);
      }
    }
  }
  console.log(lines.join('\n'));
}

/** Spawn `git diff` (or `cat` for untracked) through a pager, inheriting stdio. */
async function viewFileDiff(cwd: string, file: ChangedFile): Promise<void> {
  const isUntracked = file.code === '??';
  const absPath = `${cwd}/${file.path}`;
  // Prefer `less -R` if available; fall back to inheriting stdout (dump + return).
  const pager = process.env.PAGER ?? (hasBinary('less') ? 'less -R' : '');

  const runDiff = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let cmd: string;
      let args: string[];
      if (isUntracked) {
        // Show the new file as a "diff against /dev/null" so the viewer is consistent.
        cmd = 'git';
        args = ['-C', cwd, 'diff', '--color=always', '--no-index', '--', '/dev/null', absPath];
      } else {
        cmd = 'git';
        args = ['-C', cwd, 'diff', '--color=always', 'HEAD', '--', file.path];
      }

      if (pager) {
        // Pipe git output into the pager.
        const git = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        const pagerParts = pager.split(/\s+/);
        const pg = spawn(pagerParts[0], pagerParts.slice(1), {
          stdio: ['pipe', 'inherit', 'inherit'],
          env: { ...process.env, LESS: process.env.LESS ?? '-R' },
        });
        git.stdout.pipe(pg.stdin);
        pg.on('close', () => resolve());
        pg.on('error', () => resolve());
        git.on('error', () => resolve());
      } else {
        const c = spawn(cmd, args, { stdio: 'inherit' });
        c.on('close', () => resolve());
        c.on('error', () => resolve());
      }
    });

  await runDiff();
}

function hasBinary(name: string): boolean {
  const paths = (process.env.PATH ?? '').split(':');
  for (const p of paths) {
    if (!p) continue;
    if (existsSync(`${p}/${name}`)) return true;
  }
  return false;
}

async function browseFiles(rec: WorktreeRecord, running: RunningStage[] | undefined): Promise<void> {
  for (;;) {
    const files = gitChangedFiles(rec.path);
    const branch = gitCurrentBranch(rec.path) ?? rec.branch;
    const runHint =
      running && running.length > 0
        ? running.map((r) => `${r.stage} ${r.elapsed}`).join(' + ')
        : 'idle';

    if (!files || files.length === 0) {
      console.log(
        `${chalk.bold(`#${rec.itemNumber}`)} ${chalk.cyan(branch)}  ${chalk.dim(runHint)}  ${chalk.dim('(no changes)')}`,
      );
      return;
    }

    const items: SelectItem<ChangedFile | '__back__'>[] = files.map((f) => ({
      label: `${f.code}  ${f.path}`,
      value: f,
      hint: f.oldPath ? `← ${f.oldPath}` : undefined,
    }));
    items.push({ label: chalk.dim('← back'), value: '__back__' });

    const picked = await select<ChangedFile | '__back__'>(items, {
      title: `#${rec.itemNumber} ${branch} — ${runHint} — ${files.length} changed`,
    });
    if (!picked || picked === '__back__') return;
    await viewFileDiff(rec.path, picked);
  }
}

async function interactiveLoop(
  records: WorktreeRecord[],
  running: Map<number, RunningStage[]>,
): Promise<void> {
  const sorted = [...records].sort((a, b) => a.itemNumber - b.itemNumber);
  for (;;) {
    // Refresh each iteration so the view reflects new edits from a still-running agent.
    const fresh = detectRunningStages();
    const items: SelectItem<WorktreeRecord | '__quit__'>[] = sorted.map((rec) => {
      const runs = fresh.get(rec.itemNumber);
      const files = gitChangedFiles(rec.path) ?? [];
      const runningTag =
        runs && runs.length > 0
          ? chalk.green(`● ${runs[0].stage} ${runs[0].elapsed}`)
          : chalk.dim('idle');
      const changeTag =
        files.length > 0 ? chalk.yellow(`${files.length} changed`) : chalk.dim('clean');
      return {
        label: `#${rec.itemNumber} ${chalk.dim(`(${rec.itemKind})`)} ${rec.branch}`,
        value: rec,
        hint: `${runningTag}  ${changeTag}`,
      };
    });
    items.push({ label: chalk.dim('quit'), value: '__quit__' });

    const picked = await select<WorktreeRecord | '__quit__'>(items, {
      title: 'harnext status — select a worktree',
    });
    if (!picked || picked === '__quit__') return;
    await browseFiles(picked, fresh.get(picked.itemNumber));
    // Return to top-level menu after the user escapes the file list.
  }
  // Silence unused import warning for `running` in strict mode (we re-fetch inside the loop).
  void running;
}

export async function runStatusMode(options: StatusModeOptions): Promise<number> {
  const records = listWorktreeRecords(options.cwd);
  const running = detectRunningStages();

  if (records.length === 0) {
    console.log(chalk.dim('No registered worktrees for this project.'));
    return 0;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    printSummary(records, running);
    return 0;
  }

  await interactiveLoop(records, running);
  return 0;
}
