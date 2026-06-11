import { EventEmitter } from 'node:events';
import { emitKeypressEvents } from 'node:readline';

const ESC = '\x1B[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

export interface CompletionItem {
  text: string;
  hint?: string;
}

export interface TextareaOptions {
  prompt: string;
  getTopBorder?: () => string;
  getBottomBorder?: () => string;
  completions?: CompletionItem[];
  /** Called on shift+tab. Used by interactive mode to cycle modes. */
  onShiftTab?: () => void;
}

export interface Textarea {
  on(event: 'submit', cb: (value: string) => void): Textarea;
  on(event: 'exit', cb: () => void): Textarea;
  /** Emitted when the user presses Esc — used to interrupt an in-flight run. */
  on(event: 'interrupt', cb: () => void): Textarea;
  writeAbove(text: string): void;
  redraw(): void;
  pause(): void;
  resume(): void;
  close(): void;
  /**
   * Modal one-shot key capture for hotkey prompts (e.g. the y/a/n approval
   * box). While pending, every keypress except ctrl+c/ctrl+d is consumed;
   * the promise resolves with the first key whose name (or character) is in
   * `keys` — pass `'escape'` to capture Esc. Caller must ensure stdin is a
   * TTY; without one no keypress ever arrives and the promise never settles.
   */
  captureKey(keys: readonly string[]): Promise<string>;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// Matches a slash-command-shaped token: a leading slash, an initial letter,
// then word chars / ':' / '-' (covers "/goal" and "/skill:foo"). Exported for
// reuse by the highlighter and its tests.
const SLASH_TOKEN = /\/[A-Za-z][\w:-]*/g;

/**
 * Colorize any recognized slash-command token in `text` so the user can see at
 * a glance that it is special. Only tokens that *exactly* match a name in
 * `commandNames` are highlighted; arbitrary "/foo" text is left untouched, and
 * the token may appear anywhere in the line, not just at the start.
 *
 * Inserts zero-width ANSI codes only, so callers that compute terminal columns
 * from the raw (unhighlighted) string stay correct.
 */
export function highlightSlashCommands(text: string, commandNames: ReadonlySet<string>): string {
  if (commandNames.size === 0 || text.indexOf('/') < 0) return text;
  const ACCENT = `${ESC}38;5;74m`;
  const RESET = `${ESC}39m`;
  return text.replace(SLASH_TOKEN, (token) =>
    commandNames.has(token) ? `${ACCENT}${token}${RESET}` : token,
  );
}

function countLines(s: string): number {
  if (!s) return 0;
  const nl = (s.match(/\n/g) || []).length;
  return nl + (s.endsWith('\n') ? 0 : 1);
}

/**
 * Persistent "sticky" textarea pinned to the bottom of the terminal for the
 * duration of the session.
 *
 * On every writeAbove() or redraw() the textarea is erased, content flows
 * onto the content area above, and the textarea is immediately re-rendered
 * below — so it stays visible throughout streaming. Cursor is hidden for the
 * duration of the dance to avoid visible jitter.
 *
 * Content continuity across writeAbove calls is preserved via `contentCol`,
 * the column where the previous content ended. When the last write did not
 * end in a newline, the next write continues from that same screen column so
 * streamed tokens concatenate on the same row.
 *
 * All cursor movement is relative (no DEC scroll region, no absolute row
 * positioning) so the frame stays correct across terminals with inconsistent
 * dimension reporting.
 */
export function createTextarea(options: TextareaOptions): Textarea {
  const emitter = new EventEmitter();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  const hasTTY = !!stdin.isTTY;

  let buffer = '';
  let ghostLen = 0;
  let textareaDrawn = false;
  // Column where the next content append should land. 0 means "fresh row".
  // Non-zero means the previous write ended mid-line and the next write
  // should continue from that column on the row directly above the textarea.
  let contentCol = 0;
  let active = false;
  let closed = false;
  // Captured at draw time so that erase always unwinds the exact layout
  // that was drawn, even if getTopBorder / getBottomBorder changes shape
  // (e.g. a spinner line appearing) between draws.
  let lastTopLines = 0;
  let lastBottomLines = 0;
  // Rows the prompt+buffer occupied at draw time. Long input wraps across
  // multiple terminal rows; erase must unwind past all of them.
  let lastInputRows = 1;
  // Index into the current matches list for the inline completion panel.
  // Always clamped to [0, matches.length) at render time.
  let selectedCompletionIdx = 0;
  // Pending modal key capture (captureKey). While set, onKeypress routes
  // every key here instead of the editing logic.
  let keyCapture: { keys: Set<string>; resolve: (key: string) => void } | null = null;

  const promptStr = options.prompt;
  const promptVisibleLen = stripAnsi(promptStr).length;

  // Set of recognized slash-command names (e.g. "/goal", "/skill:foo"), used
  // to colorize the matching token wherever it appears in the buffer.
  const commandNames = new Set((options.completions ?? []).map((c) => c.text));

  // Rows occupied / final column of an input line of `len` visible chars,
  // accounting for terminal wrapping. Terminals defer autowrap: a line that
  // exactly fills the row leaves the cursor on that row (pending-wrap), so
  // the math uses len - 1. inputEndCol returns termW (not 0) in that state.
  function inputRows(len: number): number {
    const termW = Math.max(1, process.stdout.columns ?? 80);
    return len === 0 ? 1 : Math.floor((len - 1) / termW) + 1;
  }

  function inputEndCol(len: number): number {
    const termW = Math.max(1, process.stdout.columns ?? 80);
    return len === 0 ? 0 : ((len - 1) % termW) + 1;
  }

  function getMatchingCompletions(): CompletionItem[] {
    if (!options.completions || buffer.length === 0) return [];
    if (!buffer.startsWith('/')) return [];
    const lower = buffer.toLowerCase();
    return options.completions.filter((c) => c.text.toLowerCase().startsWith(lower));
  }

  // Panel rendered below the bottom border when the user is typing a
  // slash command. Commands sit in a fixed-width column (accent slash,
  // bright name) with dim descriptions beside them; the selected row gets
  // an accent chevron + accent name. Up/down navigate, tab/enter complete.
  function renderCompletionsPanel(): string {
    const matches = getMatchingCompletions();
    if (matches.length === 0) return '';
    if (selectedCompletionIdx >= matches.length) selectedCompletionIdx = 0;
    const ACCENT = `${ESC}38;5;74m`;
    const BRIGHT = `${ESC}38;5;254m`;
    const DIM = `${ESC}38;5;245m`;
    const RESET = `${ESC}39m`;
    const termW = Math.max(20, process.stdout.columns ?? 80);
    const cmdColW = Math.max(...matches.map((m) => m.text.length)) + 2;
    const rows: string[] = [''];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const sel = i === selectedCompletionIdx;
      const chevron = sel ? `${ACCENT}❯${RESET} ` : '  ';
      const slash = m.text.startsWith('/') ? `${ACCENT}/${RESET}` : '';
      const name = m.text.startsWith('/') ? m.text.slice(1) : m.text;
      const nameStyled = sel
        ? `${ACCENT}${ESC}1m${name}${ESC}22m${RESET}`
        : `${BRIGHT}${name}${RESET}`;
      const pad = ' '.repeat(Math.max(1, cmdColW - m.text.length));
      // Truncate hints so a panel row never wraps (a wrap breaks the
      // textarea's row accounting).
      const hintBudget = termW - 4 - cmdColW - 1;
      let hint = m.hint ?? '';
      if (hint.length > hintBudget) hint = hint.slice(0, Math.max(0, hintBudget - 1)) + '…';
      const hintStyled = hint ? `${DIM}${hint}${RESET}` : '';
      rows.push('  ' + chevron + slash + nameStyled + pad + hintStyled);
    }
    return rows.join('\n');
  }

  function clearGhost() {
    if (!hasTTY || ghostLen === 0) return;
    process.stdout.write(`${ESC}K`);
    ghostLen = 0;
  }

  function drawGhost() {
    if (!hasTTY || buffer.length === 0) return;
    const matches = getMatchingCompletions();
    const match = matches[selectedCompletionIdx] ?? matches[0];
    if (match && match.text !== buffer) {
      const rest = match.text.slice(buffer.length);
      process.stdout.write(`${ESC}2m${rest}${ESC}22m`);
      process.stdout.write(`${ESC}${rest.length}D`);
      ghostLen = rest.length;
    }
  }

  // Advance contentCol as if `text` were just written at current cursor pos.
  // Modulo termWidth so extremely long unwrapped lines don't make contentCol
  // blow up past what a relative move can express.
  function advanceContentCol(text: string) {
    const termW = Math.max(1, process.stdout.columns ?? 80);
    const idx = text.lastIndexOf('\n');
    if (idx < 0) {
      contentCol = (contentCol + stripAnsi(text).length) % termW;
    } else {
      contentCol = stripAnsi(text.slice(idx + 1)).length % termW;
    }
  }

  // Draw the textarea starting at the current cursor position. If the
  // previous content ended mid-line (contentCol > 0) we emit a newline
  // first so the top border lands on a fresh row.
  function drawTextarea() {
    if (!hasTTY) return;
    process.stdout.write(HIDE_CURSOR);
    if (contentCol > 0) {
      process.stdout.write('\n');
    }
    if (options.getTopBorder) {
      const top = options.getTopBorder();
      process.stdout.write(top);
      process.stdout.write('\n');
      lastTopLines = countLines(top);
    } else {
      lastTopLines = 0;
    }
    process.stdout.write(promptStr);
    process.stdout.write(highlightSlashCommands(buffer, commandNames));
    ghostLen = 0;
    drawGhost();
    if (options.getBottomBorder) {
      const bot = options.getBottomBorder();
      process.stdout.write('\n');
      process.stdout.write(bot);
      lastBottomLines = countLines(bot);
      const panel = renderCompletionsPanel();
      if (panel) {
        process.stdout.write('\n');
        process.stdout.write(panel);
        lastBottomLines += countLines(panel);
      }
      if (lastBottomLines > 0) process.stdout.write(`${ESC}${lastBottomLines}A`);
    } else {
      lastBottomLines = 0;
    }
    // Relative-only reposition to end of buffer. The ESC A above already
    // landed on the last input row (wrapped input ends there), so only the
    // column needs fixing — modulo the terminal width, since a wrapped
    // buffer's end column is not promptLen + bufferLen.
    process.stdout.write('\r');
    const col = inputEndCol(promptVisibleLen + buffer.length);
    if (col > 0) process.stdout.write(`${ESC}${col}C`);
    lastInputRows = inputRows(promptVisibleLen + buffer.length);
    textareaDrawn = true;
    process.stdout.write(SHOW_CURSOR);
  }

  // Erase the textarea. Assumes cursor is on the *last* input row at buffer
  // end (wrapped input spans lastInputRows rows). Uses the *last-drawn* line
  // counts so dynamic shape changes (spinner line appearing/vanishing, input
  // wrapping) unwind to the correct origin.
  // After: cursor is positioned where the next content write should land —
  // either at col 1 of a fresh row (contentCol == 0) or at contentCol of
  // the row directly above the textarea (contentCol > 0).
  function eraseTextarea() {
    if (!hasTTY || !textareaDrawn) return;
    process.stdout.write(HIDE_CURSOR);
    clearGhost();
    process.stdout.write('\r');
    const up = lastTopLines + lastInputRows - 1;
    if (up > 0) process.stdout.write(`${ESC}${up}A`);
    // Clear from top-border-row to end of screen.
    process.stdout.write(`${ESC}J`);
    textareaDrawn = false;
    if (contentCol > 0) {
      process.stdout.write(`${ESC}1A`);
      process.stdout.write(`${ESC}${contentCol}C`);
    }
  }

  function writeAbove(text: string) {
    if (!hasTTY || !active) {
      process.stdout.write(text);
      return;
    }
    if (textareaDrawn) eraseTextarea();
    process.stdout.write(text);
    advanceContentCol(text);
    drawTextarea();
  }

  function redraw() {
    if (!hasTTY || !active) return;
    if (textareaDrawn) eraseTextarea();
    drawTextarea();
  }

  const onKeypress = (
    str: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ) => {
    if (!active || !key) return;

    if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
      emitter.emit('exit');
      return;
    }

    // Modal key capture: a pending captureKey() owns the keyboard. Keys in
    // the capture set resolve the promise; everything else is swallowed so
    // stray typing can't leak into the textarea mid-prompt.
    if (keyCapture) {
      const pressed = key.name === 'escape' ? 'escape' : (str ?? key.name ?? '').toLowerCase();
      if (keyCapture.keys.has(pressed)) {
        const pending = keyCapture;
        keyCapture = null;
        pending.resolve(pressed);
      }
      return;
    }

    // Esc interrupts an in-flight agent run. The handler (interactive mode)
    // decides whether anything is running; here we just surface the intent.
    // Note: emitKeypressEvents parses arrow keys etc. into their own named
    // keys, so `escape` only fires for a bare Esc press.
    if (key.name === 'escape') {
      emitter.emit('interrupt');
      return;
    }

    if (!textareaDrawn) drawTextarea();

    if (key.shift && key.name === 'tab' && options.onShiftTab) {
      options.onShiftTab();
      redraw();
      return;
    }

    if (key.name === 'return') {
      // If the inline panel is open, submit the selected command verbatim
      // (so partial input like "/co" submits as "/compact"). Otherwise
      // submit the buffer as-is.
      const matches = getMatchingCompletions();
      const chosen = matches[selectedCompletionIdx];
      const value = chosen ? chosen.text : buffer.trim();
      clearGhost();
      buffer = '';
      selectedCompletionIdx = 0;
      // Full redraw rather than a single-row clear: wrapped input occupied
      // multiple rows, and all of them must be erased with the frame.
      redraw();
      emitter.emit('submit', value);
      return;
    }

    if (key.name === 'tab' && buffer.length > 0) {
      const matches = getMatchingCompletions();
      const match = matches[selectedCompletionIdx] ?? matches[0];
      if (match && match.text !== buffer) {
        buffer = match.text;
        selectedCompletionIdx = 0;
        redraw();
      }
      return;
    }

    if (key.name === 'up' || key.name === 'down') {
      const matches = getMatchingCompletions();
      if (matches.length > 1) {
        selectedCompletionIdx =
          key.name === 'up'
            ? (selectedCompletionIdx - 1 + matches.length) % matches.length
            : (selectedCompletionIdx + 1) % matches.length;
        redraw();
      }
      return;
    }

    if (key.name === 'backspace') {
      if (buffer.length > 0) {
        const hadSlash = buffer.includes('/');
        const oldLen = promptVisibleLen + buffer.length;
        buffer = buffer.slice(0, -1);
        selectedCompletionIdx = 0;
        // Full redraw when the deletion crosses a wrap boundary ('\b' cannot
        // move up a row) or the row was exactly full (pending-wrap leaves the
        // cursor on the deleted char, so '\b \b' would erase its neighbor).
        const termW = Math.max(1, process.stdout.columns ?? 80);
        const wraps = inputRows(oldLen - 1) !== lastInputRows || oldLen % termW === 0;
        // A '/' anywhere means a command token may need (re)coloring, which an
        // in-place '\b \b' can't express — fall back to a full redraw.
        if (hadSlash || buffer.includes('/') || wraps) {
          redraw();
        } else {
          clearGhost();
          process.stdout.write('\b \b');
          drawGhost();
        }
      }
      return;
    }

    if (str && str.length === 1 && !key.ctrl && !key.meta && str.charCodeAt(0) >= 32) {
      buffer += str;
      selectedCompletionIdx = 0;
      // Crossing a wrap boundary needs a full redraw: an in-place write
      // would wrap the cursor down onto the bottom border instead of
      // re-flowing the frame to make room for the new input row.
      const wraps = inputRows(promptVisibleLen + buffer.length) !== lastInputRows;
      // A '/' anywhere means a command token may need (re)coloring, which an
      // in-place append can't express — fall back to a full redraw.
      if (buffer.includes('/') || wraps) {
        redraw();
      } else {
        clearGhost();
        process.stdout.write(str);
        drawGhost();
      }
    }
  };

  function pause() {
    if (!active) return;
    active = false;
    if (textareaDrawn) eraseTextarea();
    process.stdout.write(SHOW_CURSOR);
    stdin.removeListener('keypress', onKeypress);
    if (hasTTY) stdin.setRawMode(wasRaw);
  }

  function resume() {
    if (active || closed) return;
    emitKeypressEvents(stdin);
    if (hasTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    active = true;
    drawTextarea();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (active) {
      active = false;
      if (textareaDrawn) eraseTextarea();
      process.stdout.write(SHOW_CURSOR);
      stdin.removeListener('keypress', onKeypress);
      if (hasTTY) stdin.setRawMode(wasRaw);
    }
  }

  emitKeypressEvents(stdin);
  if (hasTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKeypress);
  active = true;
  drawTextarea();

  function captureKey(keys: readonly string[]): Promise<string> {
    return new Promise((resolve) => {
      keyCapture = { keys: new Set(keys.map((k) => k.toLowerCase())), resolve };
    });
  }

  const api = Object.assign(emitter, {
    writeAbove,
    redraw,
    pause,
    resume,
    close,
    captureKey,
  }) as unknown as Textarea;

  return api;
}
