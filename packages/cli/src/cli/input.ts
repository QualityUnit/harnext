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

function termWidth(): number {
  return Math.max(1, process.stdout.columns ?? 80);
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

// Number of physical terminal rows `s` occupies when printed starting at
// column 0 of a `termW`-column terminal: one row per logical line plus the
// extra rows long lines soft-wrap onto (a narrow terminal wraps the footer,
// and an undercount here would skew every relative cursor move).
function screenRows(s: string, termW: number): number {
  if (!s) return 0;
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let rows = 0;
  for (const line of lines) rows += Math.max(1, Math.ceil(stripAnsi(line).length / termW));
  return rows;
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
 *
 * The buffer is a single logical line. When prompt + buffer exceed the
 * terminal width it soft-wraps; caret math maps the buffer offset to a
 * wrapped (row, col) so arrows — including up/down — navigate within the
 * wrapped input, and editing falls back to full redraws.
 */
export function createTextarea(options: TextareaOptions): Textarea {
  const emitter = new EventEmitter();
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  const hasTTY = !!stdin.isTTY;

  let buffer = '';
  // Caret index into `buffer` (0..buffer.length). Insertion and deletion
  // happen at this position; left/right/home/end move it, and up/down move
  // it by one terminal row when the input soft-wraps. All screen math maps
  // the offset `promptVisibleLen + cursorPos` to a wrapped (row, col) via
  // the terminal width.
  let cursorPos = 0;
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
  // Wrapped input row the physical cursor currently sits on (0-based within
  // the input area). Erase unwinds from here — it must not be derived from
  // cursorPos, which handlers mutate before the screen catches up.
  let drawnCaretRow = 0;
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
      // Ghost rendering is single-row only: skip it when prompt + buffer +
      // ghost would reach the terminal edge, where the cursor-left rewind
      // could not cross the wrap.
      if (promptVisibleLen + buffer.length + rest.length >= termWidth()) return;
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
    const termW = termWidth();
    process.stdout.write(HIDE_CURSOR);
    if (contentCol > 0) {
      process.stdout.write('\n');
    }
    if (options.getTopBorder) {
      const top = options.getTopBorder();
      process.stdout.write(top);
      process.stdout.write('\n');
      lastTopLines = screenRows(top, termW);
    } else {
      lastTopLines = 0;
    }
    process.stdout.write(promptStr);
    process.stdout.write(highlightSlashCommands(buffer, commandNames));
    ghostLen = 0;
    drawGhost();
    const endOffset = promptVisibleLen + buffer.length;
    // When the input exactly fills its last row the terminal holds the
    // cursor in deferred-wrap state on that row. Print-and-backspace forces
    // the next row to exist so the caret can sit at column 0 of it and the
    // border/erase row accounting stays consistent.
    if (endOffset > 0 && endOffset % termW === 0) process.stdout.write(' \b');
    if (options.getBottomBorder) {
      const bot = options.getBottomBorder();
      process.stdout.write('\n');
      process.stdout.write(bot);
      lastBottomLines = screenRows(bot, termW);
      const panel = renderCompletionsPanel();
      if (panel) {
        process.stdout.write('\n');
        process.stdout.write(panel);
        lastBottomLines += screenRows(panel, termW);
      }
      if (lastBottomLines > 0) process.stdout.write(`${ESC}${lastBottomLines}A`);
    } else {
      lastBottomLines = 0;
    }
    // Relative-only reposition from the last wrapped input row (where the
    // cursor sits after the border dance) to the caret's row and column.
    const lastRow = Math.floor(endOffset / termW);
    const caretOffset = promptVisibleLen + cursorPos;
    const caretRow = Math.floor(caretOffset / termW);
    process.stdout.write('\r');
    if (lastRow > caretRow) process.stdout.write(`${ESC}${lastRow - caretRow}A`);
    const col = caretOffset % termW;
    if (col > 0) process.stdout.write(`${ESC}${col}C`);
    drawnCaretRow = caretRow;
    textareaDrawn = true;
    process.stdout.write(SHOW_CURSOR);
  }

  // Move the caret to `newPos` and emit the relative cursor motion to get
  // there from the current caret position, crossing soft-wrap row
  // boundaries when the input spans multiple terminal rows.
  function moveCaretTo(newPos: number) {
    const from = promptVisibleLen + cursorPos;
    const to = promptVisibleLen + newPos;
    cursorPos = newPos;
    if (!hasTTY || !textareaDrawn || from === to) return;
    const termW = termWidth();
    const fromRow = Math.floor(from / termW);
    const toRow = Math.floor(to / termW);
    if (toRow < fromRow) process.stdout.write(`${ESC}${fromRow - toRow}A`);
    else if (toRow > fromRow) process.stdout.write(`${ESC}${toRow - fromRow}B`);
    process.stdout.write('\r');
    const col = to % termW;
    if (col > 0) process.stdout.write(`${ESC}${col}C`);
    drawnCaretRow = toRow;
  }

  // Re-render only the input row in place. Used for mid-buffer edits where
  // the tail of the line changes — cheaper than a full erase/redraw and
  // avoids frame flicker. Callers guarantee the input fits a single
  // terminal row; wrapped input (and any '/' that may need recoloring) always
  // goes through a full redraw, so highlighting here is a zero-width no-op.
  function renderInputLine() {
    if (!hasTTY) return;
    ghostLen = 0;
    process.stdout.write('\r');
    process.stdout.write(`${ESC}K`);
    process.stdout.write(promptStr);
    process.stdout.write(highlightSlashCommands(buffer, commandNames));
    drawGhost();
    process.stdout.write('\r');
    const col = promptVisibleLen + cursorPos;
    if (col > 0) process.stdout.write(`${ESC}${col}C`);
  }

  // Erase the textarea. Assumes cursor is on the input line at buffer end.
  // Uses the *last-drawn* top/bottom line counts so dynamic shape changes
  // (spinner line appearing/vanishing) unwind to the correct origin.
  // After: cursor is positioned where the next content write should land —
  // either at col 1 of a fresh row (contentCol == 0) or at contentCol of
  // the row directly above the textarea (contentCol > 0).
  function eraseTextarea() {
    if (!hasTTY || !textareaDrawn) return;
    process.stdout.write(HIDE_CURSOR);
    clearGhost();
    process.stdout.write('\r');
    // The cursor sits on the wrapped row last placed on screen; unwind past
    // any wrapped input rows above it plus the top border before clearing
    // downward. drawnCaretRow (not cursorPos) is authoritative: handlers
    // mutate cursorPos before the redraw that re-syncs the screen.
    const up = lastTopLines + drawnCaretRow;
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
      // Full erase/redraw: a single-row clear would leave stale wrapped
      // input rows and any open completions panel on screen.
      if (textareaDrawn) eraseTextarea();
      buffer = '';
      cursorPos = 0;
      selectedCompletionIdx = 0;
      drawTextarea();
      emitter.emit('submit', value);
      return;
    }

    if (key.name === 'tab' && buffer.length > 0) {
      const matches = getMatchingCompletions();
      const match = matches[selectedCompletionIdx] ?? matches[0];
      if (match && match.text !== buffer) {
        buffer = match.text;
        cursorPos = buffer.length;
        selectedCompletionIdx = 0;
        redraw();
      }
      return;
    }

    if (key.name === 'left') {
      if (cursorPos > 0) moveCaretTo(cursorPos - 1);
      return;
    }

    if (key.name === 'right') {
      if (cursorPos < buffer.length) moveCaretTo(cursorPos + 1);
      return;
    }

    if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      if (cursorPos > 0) moveCaretTo(0);
      return;
    }

    if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      if (cursorPos < buffer.length) moveCaretTo(buffer.length);
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
        return;
      }
      // No completions panel: move the caret one terminal row up/down
      // within a soft-wrapped input, clamping to the buffer edges.
      const termW = termWidth();
      const caretOffset = promptVisibleLen + cursorPos;
      const lastRow = Math.floor((promptVisibleLen + buffer.length) / termW);
      const row = Math.floor(caretOffset / termW);
      if (key.name === 'up' && row > 0) {
        moveCaretTo(Math.max(0, caretOffset - termW - promptVisibleLen));
      } else if (key.name === 'down' && row < lastRow) {
        moveCaretTo(Math.min(buffer.length, caretOffset + termW - promptVisibleLen));
      }
      return;
    }

    if (key.name === 'backspace') {
      if (cursorPos > 0) {
        const hadSlash = buffer.includes('/');
        const atEnd = cursorPos === buffer.length;
        // Wrapped before the delete → the input may shrink a row and the
        // borders move up; only a full redraw keeps the frame consistent.
        const wrapped = promptVisibleLen + buffer.length >= termWidth();
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos--;
        selectedCompletionIdx = 0;
        // A '/' anywhere means a command token may need (re)coloring, which an
        // in-place '\b \b' / mid-row rewrite can't reliably express — fall back
        // to a full redraw.
        if (hadSlash || buffer.includes('/') || wrapped) {
          redraw();
        } else if (atEnd) {
          clearGhost();
          process.stdout.write('\b \b');
          drawGhost();
        } else {
          renderInputLine();
        }
      }
      return;
    }

    if (str && str.length === 1 && !key.ctrl && !key.meta && str.charCodeAt(0) >= 32) {
      const atEnd = cursorPos === buffer.length;
      buffer = buffer.slice(0, cursorPos) + str + buffer.slice(cursorPos);
      cursorPos++;
      selectedCompletionIdx = 0;
      // Wrapped after the insert (>= because at an exact row fill the input
      // grows a forced row) → borders shift down; full redraw required.
      const wrapped = promptVisibleLen + buffer.length >= termWidth();
      // A '/' anywhere means a command token may need (re)coloring, which an
      // in-place write can't express — fall back to a full redraw.
      if (buffer.includes('/') || wrapped) {
        redraw();
      } else if (atEnd) {
        clearGhost();
        process.stdout.write(str);
        drawGhost();
      } else {
        renderInputLine();
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
