import { execSync } from 'node:child_process';

import chalk, { type ChalkInstance } from 'chalk';

import { APP_NAME, VERSION } from '@harnext/core';

// ── Palette ──────────────────────────────────────────────────────────
// All hues drawn from the xterm-256 palette so the UI degrades safely on
// 256-color terminals. Color is signal, not decoration:
//   cyan = read/query · amber = edit/diff · green = run/added
//   red = error/removed · magenta = special · grey ramp = chrome.
const X = {
  accent: 74, // #5fafd7  primary / read
  green: 107, // #87af5f  added / success
  green2: 71, // #5faf5f  run badge
  red: 167, //   #d75f5f  removed / error
  amber: 179, // #d7af5f  edit / running
  blue: 68, //   #5f87d7  info / link
  magenta: 140, // #af87d7 special
  fg: 250,
  bright: 254,
  dim: 245,
  faint: 241,
  bg: 234, // near-black, used as text color on reverse-video badges
  hairline: 237,
} as const;

const c = {
  accent: chalk.ansi256(X.accent),
  green: chalk.ansi256(X.green),
  red: chalk.ansi256(X.red),
  amber: chalk.ansi256(X.amber),
  blue: chalk.ansi256(X.blue),
  magenta: chalk.ansi256(X.magenta),
  fg: chalk.ansi256(X.fg),
  bright: chalk.ansi256(X.bright),
  dim: chalk.ansi256(X.dim),
  faint: chalk.ansi256(X.faint),
};

// Subtle diff-row tints — truecolor only. The nearest xterm-256 fallback is
// a mid gray that reads as mud, so on 256-color terminals the +/− sign and
// green/red foreground carry the diff on their own.
const identity = ((s: string) => s) as unknown as ChalkInstance;
const ADD_BG = chalk.level >= 3 ? chalk.bgRgb(30, 43, 30) : identity;
const DEL_BG = chalk.level >= 3 ? chalk.bgRgb(46, 30, 30) : identity;

function termWidth(): number {
  return process.stdout.columns || 80;
}

// ── Separator ────────────────────────────────────────────────────────

export function separator(color: ChalkInstance = chalk.ansi256(X.hairline)): string {
  return color('─'.repeat(termWidth()));
}

// ── Utilities ────────────────────────────────────────────────────────

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function fitToWidth(text: string, maxVisible: number): string {
  if (text.length <= maxVisible) return text;
  if (maxVisible <= 1) return text.slice(0, maxVisible);
  return text.slice(0, Math.max(0, maxVisible - 1)) + '…';
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

// Compact decimal form for token counts. < 1K shows raw, otherwise scaled
// with K/M and one decimal (trimmed when it's `.0`).
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const trim = (v: number) => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n < 1_000_000) return trim(n / 1000) + 'K';
  return trim(n / 1_000_000) + 'M';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  return '$' + (cost < 1 ? cost.toFixed(3) : cost.toFixed(2));
}

// ── User message echo (❯ caret, no background fill) ─────────────────

export function userMessage(text: string): string {
  const lines = text.split('\n');
  return lines
    .map((line, i) => (i === 0 ? c.accent.bold('❯ ') : '  ') + c.bright(line))
    .join('\n');
}

// ── Tool framing: rail + reverse-video badge ─────────────────────────
//
// Header (printed at tool start):   [badge] arg
// Body (printed at tool end):       │ single-spaced output lines
//                                   ⋮ 137 more lines
// plus a ✓/✗ exit line for shell commands.

type RoleColor = { idx: number; ink: ChalkInstance };

function toolColor(name: string): RoleColor {
  switch (name) {
    case 'read':
    case 'grep':
    case 'glob':
    case 'ls':
    case 'find':
      return { idx: X.accent, ink: c.accent };
    case 'edit':
    case 'write':
      return { idx: X.amber, ink: c.amber };
    case 'bash':
      return { idx: X.green2, ink: chalk.ansi256(X.green2) };
    default:
      return { idx: X.magenta, ink: c.magenta };
  }
}

function badge(name: string, colorIdx: number): string {
  return chalk.bgAnsi256(colorIdx).ansi256(X.bg).bold(` ${name} `);
}

function railPrefix(ink: ChalkInstance): string {
  return ink('│') + ' ';
}

// Max body lines shown before collapsing into a "⋮ N more lines" row.
const MAX_BODY_LINES = 12;
// Max diff lines shown for write/edit bodies.
const MAX_DIFF_LINES = 10;

export function toolStart(name: string, args: Record<string, unknown>): string {
  // The todo tool renders as a plan block instead of a badge header — all
  // its information lives in the args, so it draws in full at call start.
  if (name === 'todo') return planBlock(args);

  const role = toolColor(name);
  const head = badge(name, role.idx);
  const w = termWidth();
  const argBudget = Math.max(8, w - stripAnsi(head).length - 2);

  let arg: string;
  if (name === 'bash') {
    const cmd = truncateOneLine(String(args.command ?? ''), argBudget - 2);
    arg = c.green('$ ') + c.bright(cmd);
  } else if (name === 'read' || name === 'write' || name === 'edit') {
    arg = c.bright(fitToWidth(String(args.path ?? ''), argBudget));
  } else {
    arg = c.dim(truncateOneLine(JSON.stringify(args), argBudget));
  }
  return `${head} ${arg}`;
}

// Collapse runs of blank lines to a single blank line and drop leading /
// trailing blanks — tool results often arrive double-spaced, which blows
// up the scrollback for no information gain.
function singleSpace(lines: string[]): string[] {
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    const isBlank = line.trim() === '';
    if (isBlank) {
      blank = true;
      continue;
    }
    if (blank && out.length > 0) out.push('');
    blank = false;
    out.push(line);
  }
  return out;
}

interface BodyRow {
  text: string;
  style: (s: string) => string;
  /** Pre-styled prefix (gutter / diff sign) with its visible width. */
  prefix?: { rendered: string; width: number };
}

function renderBody(rows: BodyRow[], ink: ChalkInstance, moreNote?: string): string {
  const w = termWidth();
  const rail = railPrefix(ink);
  const out: string[] = [];
  for (const row of rows) {
    const prefixW = row.prefix?.width ?? 0;
    const budget = Math.max(8, w - 2 - prefixW);
    const fit = fitToWidth(row.text, budget);
    out.push(rail + (row.prefix?.rendered ?? '') + row.style(fit));
  }
  if (moreNote) out.push(c.faint('⋮ ') + c.accent(moreNote));
  return out.join('\n');
}

// Faint right-aligned gutter for `read` output, which arrives as
// `NNNN\tline` rows from the read tool.
const NUMBERED_LINE = /^(\s*\d+)\t(.*)$/;

function readRows(lines: string[]): BodyRow[] {
  return lines.map((line) => {
    const m = line.match(NUMBERED_LINE);
    if (!m) return { text: line, style: (s) => c.fg(s) };
    const gut = m[1] + ' ';
    return {
      text: m[2],
      style: (s) => c.fg(s),
      prefix: { rendered: c.faint(gut), width: gut.length },
    };
  });
}

function diffRow(sign: '+' | '-', text: string): BodyRow {
  const ink = sign === '+' ? c.green : c.red;
  const bg = sign === '+' ? ADD_BG : DEL_BG;
  return {
    text,
    style: (s) => bg(ink(s)),
    prefix: { rendered: bg(ink(sign + ' ')), width: 2 },
  };
}

export interface ToolEndOptions {
  durationMs?: number;
  /**
   * For `write`: the file's content before the tool ran. `null` means the
   * file didn't exist (a true new file); `undefined` means unknown.
   */
  priorContent?: string | null;
}

export function toolEnd(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
  opts: ToolEndOptions = {},
): string {
  const role = isError ? { idx: X.red, ink: c.red } : toolColor(name);
  const parts: string[] = [];

  // The plan block already rendered everything at tool start.
  if (name === 'todo' && !isError) return '';

  if (name === 'edit' && !isError) {
    parts.push(editBody(args, role.ink));
  } else if (name === 'write' && !isError) {
    parts.push(writeBody(args, role.ink, opts.priorContent));
  } else if (name === 'bash') {
    return bashBody(result, isError, opts.durationMs);
  } else {
    parts.push(genericBody(name, result, isError, role.ink));
  }

  return parts.filter((p) => p.length > 0).join('\n');
}

function genericBody(
  name: string,
  result: string,
  isError: boolean,
  ink: ChalkInstance,
): string {
  let lines = singleSpace(result.split('\n'));

  // The read tool prefixes truncated output with a "(showing lines …)"
  // header; fold it into the ⋮ note instead of showing it as body text.
  let toolHidden = 0;
  let sizeNote = '';
  if (name === 'read' && lines.length > 0 && lines[0].startsWith('(showing lines')) {
    const m = lines[0].match(/^\(showing lines \d+-(\d+) of (\d+)(?:, ([^)]+))?\)$/);
    if (m) {
      toolHidden = Number(m[2]) - Number(m[1]);
      sizeNote = m[3] ?? '';
    }
    lines = lines.slice(1);
  }

  let displayHidden = 0;
  if (lines.length > MAX_BODY_LINES) {
    displayHidden = lines.length - MAX_BODY_LINES;
    lines = lines.slice(0, MAX_BODY_LINES);
  }
  const hidden = toolHidden + displayHidden;
  let moreNote: string | undefined;
  if (hidden > 0) {
    moreNote = `${hidden} more lines${sizeNote ? ` · ${sizeNote}` : ''}`;
  }

  if (lines.length === 0 && !moreNote) {
    return isError ? railPrefix(ink) + c.red('error (no output)') : '';
  }

  const rows: BodyRow[] =
    name === 'read'
      ? readRows(lines)
      : lines.map((line) => ({
          text: line,
          style: (s: string) => (isError ? c.red(s) : c.fg(s)),
        }));
  return renderBody(rows, ink, moreNote);
}

function editBody(args: Record<string, unknown>, ink: ChalkInstance): string {
  const oldStr = (args.old_string as string | undefined) ?? '';
  const newStr = (args.new_string as string | undefined) ?? '';
  if (!oldStr && !newStr) return '';

  const dels = oldStr ? oldStr.split('\n') : [];
  const adds = newStr ? newStr.split('\n') : [];
  let rows: BodyRow[] = [
    ...dels.map((l) => diffRow('-', l)),
    ...adds.map((l) => diffRow('+', l)),
  ];
  let moreNote: string | undefined;
  if (rows.length > MAX_DIFF_LINES) {
    moreNote = `${rows.length - MAX_DIFF_LINES} more lines · +${adds.length} −${dels.length}`;
    rows = rows.slice(0, MAX_DIFF_LINES);
  }
  return renderBody(rows, ink, moreNote);
}

function writeBody(
  args: Record<string, unknown>,
  ink: ChalkInstance,
  priorContent?: string | null,
): string {
  const content = (args.content as string | undefined) ?? '';
  if (!content) return '';
  const newLines = content.split('\n');

  // No prior snapshot: every line is an addition. Only claim "new file"
  // when we know the file didn't exist before.
  if (priorContent == null) {
    let rows = newLines.map((l) => diffRow('+', l));
    let moreNote: string | undefined;
    if (rows.length > MAX_DIFF_LINES) {
      const fileNote = priorContent === null ? ' · new file' : '';
      moreNote = `${rows.length - MAX_DIFF_LINES} more added lines · +${newLines.length} −0${fileNote}`;
      rows = rows.slice(0, MAX_DIFF_LINES);
    }
    return renderBody(rows, ink, moreNote);
  }

  // Overwrite of an existing file: show only the changed hunk, found by
  // trimming the common prefix and suffix. This turns "rewrote the whole
  // file to append two lines" into a 2-line diff instead of a full dump.
  const oldLines = priorContent.split('\n');
  const maxCommon = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < maxCommon && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxCommon - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const dels = oldLines.slice(prefix, oldLines.length - suffix);
  const adds = newLines.slice(prefix, newLines.length - suffix);

  if (dels.length === 0 && adds.length === 0) {
    return railPrefix(ink) + c.faint('no changes');
  }

  const hunk: BodyRow = {
    text: `@@ -${prefix + 1},${dels.length} +${prefix + 1},${adds.length} @@`,
    style: (s) => c.blue(s),
  };
  let rows: BodyRow[] = [hunk, ...dels.map((l) => diffRow('-', l)), ...adds.map((l) => diffRow('+', l))];
  let moreNote: string | undefined;
  if (rows.length > MAX_DIFF_LINES + 1) {
    moreNote = `${rows.length - 1 - MAX_DIFF_LINES} more lines · +${adds.length} −${dels.length}`;
    rows = rows.slice(0, MAX_DIFF_LINES + 1);
  }
  return renderBody(rows, ink, moreNote);
}

// Shell output: dim stdout, with a ✓/✗ exit line carrying code + duration.
// The bash tool folds failures into an error string ending in
// "Command exited with code N" — strip that trailer and surface it as the
// exit line instead of leaving it as body text.
const EXIT_TRAILER = /\n*Command exited with code (\d+)\s*$/;

function bashBody(result: string, isError: boolean, durationMs?: number): string {
  let text = result;
  let exitCode = isError ? 1 : 0;
  const m = text.match(EXIT_TRAILER);
  if (m) {
    exitCode = Number(m[1]);
    text = text.replace(EXIT_TRAILER, '');
  }
  if (text.trim() === '(no output)') text = '';

  const ink = isError ? c.red : chalk.ansi256(X.green2);
  let lines = singleSpace(text.split('\n'));
  let moreNote: string | undefined;
  if (lines.length > MAX_BODY_LINES) {
    moreNote = `${lines.length - MAX_BODY_LINES} more lines`;
    lines = lines.slice(0, MAX_BODY_LINES);
  }

  const rows: BodyRow[] = lines.map((line) => ({
    text: line,
    style: (s: string) => (isError ? c.fg(s) : c.dim(s)),
  }));
  const body = rows.length > 0 || moreNote ? renderBody(rows, ink, moreNote) : '';

  const time = durationMs != null ? ` · ${formatDuration(durationMs)}` : '';
  const exitLine =
    exitCode === 0
      ? c.green(`✓ exit 0${time}`)
      : c.red(`✗ exit ${exitCode}${time}`);

  return body.length > 0 ? body + '\n' + exitLine : exitLine;
}

// ── Plan / todo block ────────────────────────────────────────────────
//
//  │ ◇ plan · add openrouter provider
//  │ ✔ Inspect Provider interface          (done — dim, struck through)
//  │ ▶ Create src/providers/openrouter.ts  (active — bright)
//  │ ○ Register in providers/index.ts      (pending — faint)

interface PlanItem {
  text: string;
  status: 'pending' | 'active' | 'done';
}

export function planBlock(args: Record<string, unknown>): string {
  const items: PlanItem[] = Array.isArray(args.items)
    ? (args.items as unknown[]).map((raw) => {
        const it = (raw ?? {}) as { text?: unknown; status?: unknown };
        const status = it.status === 'done' || it.status === 'active' ? it.status : 'pending';
        return { text: String(it.text ?? ''), status };
      })
    : [];
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'plan';

  const w = termWidth();
  const rail = c.magenta('│') + ' ';
  const lines: string[] = [];
  lines.push(rail + c.magenta.bold('◇ ' + fitToWidth(title, Math.max(8, w - 6))));
  for (const it of items) {
    const text = fitToWidth(it.text, Math.max(8, w - 6));
    switch (it.status) {
      case 'done':
        lines.push(rail + c.green('✔') + ' ' + c.dim.strikethrough(text));
        break;
      case 'active':
        lines.push(rail + c.amber('▶') + ' ' + c.bright(text));
        break;
      default:
        lines.push(rail + c.faint('○') + ' ' + c.faint(text));
    }
  }
  return lines.join('\n');
}

// ── Approval / permission prompt ─────────────────────────────────────
//
//  ╭──────────────────────────────────────────────────╮
//  │ ⚠ permission  harnext wants to run a shell command│
//  │   $ npm install @openrouter/sdk                   │
//  │  y run once   a always allow npm   n deny         │
//  ╰──────────────────────────────────────────────────╯

const APPROVE_MAX_WIDTH = 86;

export interface ApproveOptions {
  /** The full shell command awaiting approval. */
  command: string;
  /** The program (first token) an "always allow" decision would whitelist. */
  program: string;
}

export function approvePrompt(opts: ApproveOptions): string {
  const w = Math.min(termWidth(), APPROVE_MAX_WIDTH);
  const inner = Math.max(20, w - 4); // "│ " + content + " │"

  const keycap = (key: string, bg: number, fg: ChalkInstance, label: string) => ({
    rendered: chalk.bgAnsi256(bg).ansi256(X.bg).bold(` ${key} `) + ' ' + fg(label),
    width: key.length + 3 + label.length,
  });

  const rows: { rendered: string; width: number }[] = [];
  {
    const head = '⚠ permission';
    const tail = `  ${APP_NAME} wants to run a shell command`;
    const tailFit = fitToWidth(tail, Math.max(0, inner - head.length));
    rows.push({
      rendered: c.amber.bold(head) + c.bright(tailFit),
      width: head.length + tailFit.length,
    });
  }
  {
    const cmd = '$ ' + truncateOneLine(opts.command, Math.max(8, inner - 4));
    rows.push({
      rendered: '  ' + chalk.bgAnsi256(235)(c.bright(` ${cmd} `)),
      width: 2 + cmd.length + 2,
    });
  }
  {
    const yes = keycap('y', X.amber, c.dim, 'run once');
    const always = keycap(
      'a',
      X.green,
      c.dim,
      `always allow ${fitToWidth(opts.program, 24)}`,
    );
    const no = keycap('n', X.dim, c.dim, 'deny & tell agent why');
    const GAP = 3;
    let rendered = '';
    let width = 0;
    for (const opt of [yes, always, no]) {
      if (width + (width > 0 ? GAP : 0) + opt.width > inner) break;
      if (width > 0) {
        rendered += ' '.repeat(GAP);
        width += GAP;
      }
      rendered += opt.rendered;
      width += opt.width;
    }
    rows.push({ rendered, width });
  }

  const bar = '─'.repeat(inner + 2);
  const out: string[] = [c.amber('╭' + bar + '╮')];
  for (const row of rows) {
    const pad = ' '.repeat(Math.max(0, inner - row.width));
    out.push(c.amber('│') + ' ' + row.rendered + pad + ' ' + c.amber('│'));
  }
  out.push(c.amber('╰' + bar + '╯'));
  return out.join('\n');
}

export type ApproveDecision = 'y' | 'a' | 'n';

export function approveDecision(decision: ApproveDecision, program: string): string {
  switch (decision) {
    case 'y':
      return c.green('✓ approved') + c.faint(' — run once');
    case 'a':
      return c.green('✓ approved') + c.faint(` — always allowing "${program}" this session`);
    default:
      return c.red('✗ denied') + c.faint(' — type a message to tell the agent why');
  }
}

// ── Header ───────────────────────────────────────────────────────────

export function header(): string {
  const lines = [
    '',
    chalk.bold.ansi256(X.accent)(APP_NAME) + c.faint(` v${VERSION}`),
    c.faint('⏎ send · / commands · esc interrupt · ⌃c quit'),
    '',
  ];
  return lines.join('\n');
}

// ── Git status (cached) ──────────────────────────────────────────────

let cachedBranch: string | undefined;
let cachedClean: boolean | undefined;

function getGitBranch(): string {
  if (cachedBranch !== undefined) return cachedBranch;
  try {
    cachedBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', {
      encoding: 'utf8',
    }).trim();
  } catch {
    cachedBranch = '';
  }
  return cachedBranch;
}

function isGitClean(): boolean {
  if (cachedClean !== undefined) return cachedClean;
  try {
    cachedClean =
      execSync('git status --porcelain 2>/dev/null', { encoding: 'utf8' }).trim() === '';
  } catch {
    cachedClean = true;
  }
  return cachedClean;
}

// ── Mode pill ────────────────────────────────────────────────────────

export type Mode = 'normal' | 'secure';

const MODE_STYLES: Record<Mode, { label: string; bg: ChalkInstance }> = {
  normal: { label: 'NORMAL', bg: chalk.bgAnsi256(X.accent).ansi256(X.bg).bold },
  secure: { label: 'SECURE', bg: chalk.bgAnsi256(X.green).ansi256(X.bg).bold },
};

// ── Status bar ───────────────────────────────────────────────────────
//
//  NORMAL  ~/path ⎇ main ✓        ↑5.9K ↓2.3K  $0.041  provider/model  ctx ▓▓░░░░ 31%

export interface StatusBarOptions {
  provider: string;
  model: string;
  cwd: string;
  contextPercent?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  mode?: Mode;
}

const CTX_BAR_CELLS = 6;

function contextMeter(percent: number): { rendered: string; width: number } {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  const filled = Math.min(CTX_BAR_CELLS, Math.round((pct / 100) * CTX_BAR_CELLS));
  const pctStr = ` ${pct}%`;
  return {
    rendered:
      c.faint('ctx ') +
      c.accent('▓'.repeat(filled)) +
      c.faint('░'.repeat(CTX_BAR_CELLS - filled)) +
      c.faint(pctStr),
    width: 4 + CTX_BAR_CELLS + pctStr.length,
  };
}

export function inputFooter(opts: StatusBarOptions): string {
  const w = termWidth();
  const home = process.env.HOME ?? '';
  const shortCwd =
    home && opts.cwd.startsWith(home) ? '~' + opts.cwd.slice(home.length) : opts.cwd;
  const mode = opts.mode ?? 'normal';

  // Left: mode pill + cwd + git branch.
  const pillStyle = MODE_STYLES[mode];
  const pill = pillStyle.bg(` ${pillStyle.label} `);
  const pillW = pillStyle.label.length + 2;

  const branch = getGitBranch();
  const gitRendered = branch
    ? ' ' + c.amber(`⎇ ${branch}`) + (isGitClean() ? c.green(' ✓') : c.amber(' ✱'))
    : '';
  const gitW = branch ? 3 + branch.length + 2 : 0;

  // Right: tokens · cost · provider/model · ctx meter.
  const segs: { rendered: string; width: number }[] = [];
  if (opts.inputTokens != null && opts.outputTokens != null) {
    const s = `↑${formatTokens(opts.inputTokens)} ↓${formatTokens(opts.outputTokens)}`;
    segs.push({ rendered: c.faint(s), width: s.length });
  }
  if (opts.cost != null && opts.cost > 0) {
    const s = formatCost(opts.cost);
    segs.push({ rendered: c.green(s), width: s.length });
  }
  {
    const prov = `${opts.provider}/`;
    segs.push({
      rendered: c.dim(prov) + c.accent(opts.model),
      width: prov.length + opts.model.length,
    });
  }
  if (opts.contextPercent != null) {
    segs.push(contextMeter(opts.contextPercent));
  }

  const GAP = 2;
  const joinSegs = (): { rendered: string; width: number } => {
    let rendered = '';
    let width = 0;
    for (const seg of segs) {
      if (rendered) {
        rendered += ' '.repeat(GAP);
        width += GAP;
      }
      rendered += seg.rendered;
      width += seg.width;
    }
    return { rendered, width };
  };

  // Fixed chrome: pill + space + git + min 1-space gap before the right side.
  // Drop right-side segments from the left inward until the bar fits.
  let right = joinSegs();
  while (pillW + 1 + gitW + 1 + right.width > w && segs.length > 1) {
    segs.shift();
    right = joinSegs();
  }

  // cwd gets whatever is left, truncated from the front.
  const leftBudget = Math.max(0, w - pillW - 1 - gitW - right.width - 1);
  let cwdStr = shortCwd;
  if (cwdStr.length > leftBudget) {
    cwdStr = leftBudget <= 1 ? cwdStr.slice(0, leftBudget) : '…' + cwdStr.slice(-(leftBudget - 1));
  }
  const leftW = pillW + 1 + cwdStr.length + gitW;
  const gap = Math.max(1, w - leftW - right.width);

  const infoLine = pill + ' ' + c.dim(cwdStr) + gitRendered + ' '.repeat(gap) + right.rendered;
  return separator() + '\n' + infoLine;
}

// ── Prompt ───────────────────────────────────────────────────────────

export function prompt(): string {
  return c.accent.bold('❯ ');
}

// ── Think line (spinner + token & cost meter) ────────────────────────
//
//  ⠋ Working… · 6.1s · ↑1.2K ↓0.3K · $0.012            esc to interrupt

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface ThinkLineOptions {
  frame: number;
  label: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export function thinkLine(opts: ThinkLineOptions): string {
  const spin = SPINNER_FRAMES[opts.frame % SPINNER_FRAMES.length];
  let line = '  ' + c.accent(spin) + ' ' + c.bright(opts.label);
  let width = 2 + 2 + stripAnsi(opts.label).length;

  const push = (rendered: string, vis: number) => {
    line += c.faint(' · ') + rendered;
    width += 3 + vis;
  };
  if (opts.elapsedMs != null) {
    const s = formatDuration(opts.elapsedMs);
    push(c.faint(s), s.length);
  }
  if (opts.inputTokens != null && opts.outputTokens != null) {
    const s = `↑${formatTokens(opts.inputTokens)} ↓${formatTokens(opts.outputTokens)}`;
    push(c.dim(s), s.length);
  }
  if (opts.cost != null && opts.cost > 0) {
    const s = formatCost(opts.cost);
    push(c.green(s), s.length);
  }

  const hint = 'esc to interrupt';
  const w = termWidth();
  const gap = w - width - hint.length - 1;
  if (gap > 2) line += ' '.repeat(gap) + c.faint(hint);
  return line;
}

// ── Loading spinner (standalone, for blocking commands) ─────────────

export interface Spinner {
  stop: () => void;
  message: string;
}

export function startSpinner(message: string): Spinner {
  let frame = 0;
  const interval = setInterval(() => {
    const spinner = c.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    process.stdout.write(`\r\x1B[K  ${spinner} ${c.dim(message)}`);
    frame++;
  }, 80);

  return {
    message,
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r\x1B[K');
    },
  };
}
