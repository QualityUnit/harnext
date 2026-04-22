import { execSync } from 'node:child_process';

import chalk, { type ChalkInstance } from 'chalk';

import { APP_NAME, VERSION } from '@harnext/core';

// ── Box-drawing characters ───────────────────────────────────────────
const BOX = { h: '─' } as const;

function termWidth(): number {
  return process.stdout.columns || 80;
}

// ── Separator ────────────────────────────────────────────────────────

export function separator(color: ChalkInstance = chalk.dim): string {
  return color(BOX.h.repeat(termWidth()));
}

// ── Tinted card (subtle background, no border) ──────────────────────

type Tint = 'yellow' | 'green' | 'red';

// Low-saturation backgrounds that read as colored blocks on both dark and
// light terminals while keeping white/dim text legible on top.
const CARD_BG: Record<Tint, ChalkInstance> = {
  yellow: chalk.bgRgb(60, 50, 18),
  green: chalk.bgRgb(25, 48, 28),
  red: chalk.bgRgb(62, 26, 26),
};

const CARD_TITLE: Record<Tint, ChalkInstance> = {
  yellow: chalk.yellow.bold,
  green: chalk.green.bold,
  red: chalk.red.bold,
};

export interface CardOptions {
  title: string;
  tint: Tint;
  maxLines?: number;
}

// Non-tinted space between the terminal edge and the card.
const CARD_MARGIN_X = 2;
// Tinted space between the card edge and its content.
const CARD_PAD_X = 3;

export function card(content: string, options: CardOptions): string {
  const termW = termWidth();
  const cardW = Math.max(4, termW - CARD_MARGIN_X * 2);
  const innerW = Math.max(1, cardW - CARD_PAD_X * 2);
  const bg = CARD_BG[options.tint];
  const titleFg = CARD_TITLE[options.tint];
  const marginLeft = ' '.repeat(CARD_MARGIN_X);

  // Wrap one pre-fit content line into a full card row:
  // [margin] [tinted pad | content | right pad | tinted pad] [margin].
  const row = (body: string, visibleLen: number): string => {
    const pad = Math.max(0, innerW - visibleLen);
    return (
      marginLeft +
      bg(' '.repeat(CARD_PAD_X) + body + ' '.repeat(pad) + ' '.repeat(CARD_PAD_X))
    );
  };

  const out: string[] = [];
  const blank = row('', 0);

  // Blank tinted line — top padding inside the card.
  out.push(blank);

  // Title — truncated if somehow wider than the card.
  const titleText = fitToWidth(options.title, innerW);
  out.push(row(titleFg(titleText), titleText.length));

  let lines = content.split('\n');
  // Trim trailing empty lines — tool outputs often end in `\n`, which would
  // otherwise render as a bare ANSI close-code row inside the card, stacking
  // a visible blank row against the card's own bottom padding.
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1]).trim() === '') {
    lines.pop();
  }
  if (options.maxLines && lines.length > options.maxLines) {
    lines = lines.slice(0, options.maxLines);
    lines.push(chalk.dim('... (truncated)'));
  }

  // Each content line is fit to innerW so the terminal never wraps it and
  // bleeds the tint into column 0 of the next row.
  for (const line of lines) {
    const visible = stripAnsi(line);
    if (visible.length <= innerW) {
      out.push(row(line, visible.length));
    } else {
      // Drop ANSI on overflow lines rather than risk slicing inside an escape.
      const fit = fitToWidth(visible, innerW);
      out.push(row(fit, fit.length));
    }
  }

  // Intentionally no bottom padding row: the *next* card's top padding is
  // what separates adjacent cards. Having both would stack two colored
  // blank rows at each boundary and read as extra whitespace.
  return out.join('\n');
}

function fitToWidth(text: string, maxVisible: number): string {
  if (text.length <= maxVisible) return text;
  if (maxVisible <= 1) return text.slice(0, maxVisible);
  return text.slice(0, Math.max(0, maxVisible - 1)) + '…';
}

// ── User message ─────────────────────────────────────────────────────

export function userMessage(text: string): string {
  const w = termWidth();
  const lines = text.split('\n');
  return lines
    .map((line) => {
      const stripped = stripAnsi(line);
      const pad = Math.max(0, w - stripped.length - 2);
      return chalk.bgRgb(50, 50, 50)(' ' + chalk.white(line) + ' '.repeat(pad) + ' ');
    })
    .join('\n');
}

// ── Tool rendering ───────────────────────────────────────────────────

export function toolStart(name: string, args: Record<string, unknown>): string {
  const summary = formatToolSummary(name, args);
  return card(chalk.white(summary), { title: name, tint: 'yellow' });
}

export function toolEnd(
  name: string,
  args: Record<string, unknown>,
  result: string,
  isError: boolean,
): string {
  const tint: Tint = isError ? 'red' : 'green';
  const summary = formatToolSummary(name, args);
  const lines: string[] = [chalk.white(summary)];

  // Show diff for edit tool. Bright variants stand out on the card bg.
  if (name === 'edit' && !isError) {
    const oldStr = args.old_string as string | undefined;
    const newStr = args.new_string as string | undefined;
    if (oldStr && newStr) {
      lines.push('');
      for (const line of oldStr.split('\n')) {
        lines.push(chalk.redBright('- ' + line));
      }
      for (const line of newStr.split('\n')) {
        lines.push(chalk.greenBright('+ ' + line));
      }
    }
  }

  // Show summary for write tool
  if (name === 'write' && !isError) {
    const content = args.content as string | undefined;
    if (content) {
      const lineCount = content.split('\n').length;
      lines.push('');
      lines.push(chalk.greenBright(`+ ${lineCount} lines written`));
    }
  }

  if (result.length > 0) {
    lines.push('');
    // White fg keeps error output readable against the red tint.
    lines.push(isError ? chalk.white(result) : chalk.white(result));
  }

  return card(lines.join('\n'), {
    title: isError ? `${name} (error)` : name,
    tint,
    maxLines: 25,
  });
}

function formatToolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return `$ ${args.command ?? ''}`;
    case 'read':
      return `${args.path ?? ''}`;
    case 'write':
      return `${args.path ?? ''}`;
    case 'edit':
      return `${args.path ?? ''}`;
    default:
      return truncateOneLine(JSON.stringify(args), termWidth() - 8);
  }
}

// ── Header ───────────────────────────────────────────────────────────

export function header(): string {
  const lines = [
    '',
    chalk.bold.cyan(APP_NAME) + chalk.dim(` v${VERSION}`),
    chalk.dim(`esc to interrupt  ctrl+c to exit`),
    chalk.dim(`/ for commands`),
    '',
  ];
  return lines.join('\n');
}

// ── Input footer (plain border, info on the line below) ─────────────

let cachedBranch: string | undefined;

function getGitBranch(): string {
  if (cachedBranch !== undefined) return cachedBranch;
  try {
    cachedBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
  } catch {
    cachedBranch = '';
  }
  return cachedBranch;
}

// Compact decimal form for token counts on the info line. < 1K shows raw,
// otherwise scaled with K/M and one decimal (trimmed when it's `.0`).
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const trim = (v: number) => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n < 1_000_000) return trim(n / 1000) + 'K';
  return trim(n / 1_000_000) + 'M';
}

export function inputFooter(
  provider: string,
  model: string,
  cwd: string,
  contextPercent?: number,
  inputTokens?: number,
  outputTokens?: number,
): string {
  const w = termWidth();
  const home = process.env.HOME ?? '';
  const shortCwd = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const branch = getGitBranch();
  const branchStr = branch ? ` (${branch})` : '';

  const pctPart = contextPercent != null ? ` ${Math.round(contextPercent)}%` : '';
  const tokPart =
    inputTokens != null && outputTokens != null
      ? ` ↑ ${formatTokens(inputTokens)} ↓ ${formatTokens(outputTokens)}`
      : '';
  const ctxStr = pctPart + tokPart;
  const rightRaw = `${provider}/${model}`;
  // Right-align `rightRaw`; give `leftRaw` whatever is left (min 1 gap).
  // Truncate left side with an ellipsis if it overflows, so the info line
  // never wraps (a wrap breaks the textarea's row accounting).
  const rightFit = rightRaw.length >= w ? rightRaw.slice(-(w - 1)) : rightRaw;
  const leftBudget = Math.max(0, w - rightFit.length - 1);
  let leftRaw = `${shortCwd}${branchStr}${ctxStr}`;
  if (leftRaw.length > leftBudget) {
    leftRaw = leftBudget <= 1 ? leftRaw.slice(0, leftBudget) : '…' + leftRaw.slice(-(leftBudget - 1));
  }
  const gap = Math.max(1, w - leftRaw.length - rightFit.length);
  const border = chalk.magenta('─'.repeat(w));
  const infoLine = chalk.dim(leftRaw) + ' '.repeat(gap) + chalk.dim(rightFit);

  return border + '\n' + infoLine;
}

// ── Prompt ───────────────────────────────────────────────────────────

export function prompt(): string {
  return chalk.cyan('> ');
}

// ── Loading spinner ──────────────────────────────────────────────────

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

export interface Spinner {
  stop: () => void;
  message: string;
}

export function startSpinner(message?: string): Spinner {
  const CYCLE_MS = 3000;
  const cycling = message == null;
  let frame = 0;
  let msg = message ?? randomMessage();
  let lastCycle = Date.now();

  const interval = setInterval(() => {
    if (cycling && Date.now() - lastCycle >= CYCLE_MS) {
      let next = randomMessage();
      while (next === msg && LOADING_MESSAGES.length > 1) next = randomMessage();
      msg = next;
      lastCycle = Date.now();
    }
    const spinner = chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    const text = chalk.dim(msg);
    process.stdout.write(`\r\x1B[K  ${spinner} ${text}`);
    frame++;
  }, 80);

  return {
    message: msg,
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r\x1B[K');
    },
  };
}

// ── Utilities ────────────────────────────────────────────────────────

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine;
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}
