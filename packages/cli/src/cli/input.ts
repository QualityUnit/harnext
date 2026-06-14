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
  /**
   * Render the bottom border / status bar. `footerFocused` is true while the
   * user has moved focus onto a footer affordance (the background-jobs chip)
   * with ↓, so the renderer can highlight it.
   */
  getBottomBorder?: (ctx: { footerFocused: boolean }) => string;
  completions?: CompletionItem[];
  /**
   * Resolver for `@`-mention path completions. Given the text typed after an
   * `@` (the query), returns ranked file/directory candidates. Directories are
   * marked with `hint: 'dir'`. Called synchronously from the keypress handler,
   * so it must never throw.
   */
  getPathCompletions?: (query: string) => CompletionItem[];
  /** Called on shift+tab. Used by interactive mode to cycle modes. */
  onShiftTab?: () => void;
  /**
   * Whether ↓ on an empty prompt should move focus onto the footer's
   * background-jobs chip. Interactive mode returns true only when idle and at
   * least one background shell exists.
   */
  footerCanFocus?: () => boolean;
  /**
   * Called when the user presses ⏎ while the footer chip is focused. Interactive
   * mode opens the background-jobs viewer here.
   */
  onFooterActivate?: () => void;
  /**
   * Called on Ctrl+V. Returns text to insert at the cursor, or null when the
   * paste was handled out of band (e.g. a clipboard image was attached). Async
   * — used by interactive mode to grab a clipboard image, else paste text.
   */
  onPaste?: () => Promise<string | null>;
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
  /** True while the textarea owns the screen (not paused for a modal UI). */
  isActive(): boolean;
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
  // Set when the user presses Esc to dismiss an open `@`-mention panel without
  // interrupting a run. Cleared as soon as a fresh `@` is typed so the picker
  // re-arms; suppresses the path panel while set.
  let panelDismissed = false;
  // Pending modal key capture (captureKey). While set, onKeypress routes
  // every key here instead of the editing logic.
  let keyCapture: { keys: Set<string>; resolve: (key: string) => void } | null = null;
  // True while the user has moved focus onto the footer's background-jobs chip
  // (via ↓ on an empty prompt). Enter then opens the viewer; any edit/Esc/Up
  // leaves focus. The footer renderer highlights the chip while this is set.
  let footerFocused = false;

  // Submitted-input recall history, oldest-first (a shell-like line history).
  // `historyIdx` points at the entry currently shown; `history.length` means
  // "editing the live draft" (nothing recalled). `historyDraft` stashes the
  // in-progress buffer while older entries are browsed so ↓ past the newest
  // entry restores it. ↑ walks toward older entries, ↓ toward newer.
  const history: string[] = [];
  let historyIdx = 0;
  let historyDraft = '';
  // Cap so a marathon session can't grow the recall list without bound; the
  // oldest entry is dropped once the list is full.
  const MAX_HISTORY = 1000;

  const promptStr = options.prompt;
  const promptVisibleLen = stripAnsi(promptStr).length;

  // Set of recognized slash-command names (e.g. "/goal", "/skill:foo"), used
  // to colorize the matching token wherever it appears in the buffer.
  const commandNames = new Set((options.completions ?? []).map((c) => c.text));

  // The inline panel serves two modes:
  //   slash — the whole buffer is a "/command" prefix; selection replaces the
  //           entire buffer (preserves the original behavior).
  //   path  — an "@token" sits under the caret; selection replaces just that
  //           token span with the chosen path.
  // `replaceStart`/`replaceEnd` mark the buffer span a selection overwrites.
  interface ActiveCompletion {
    mode: 'slash' | 'path';
    matches: CompletionItem[];
    replaceStart: number;
    replaceEnd: number;
  }

  // Index of the `@` that begins the mention currently under the caret, or -1.
  // The `@` must sit at start-of-buffer or immediately after whitespace (so
  // `email@host` never triggers), with no whitespace between it and the caret.
  function activeAtIndex(): number {
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = buffer[i];
      if (ch === '@') {
        const prev = i === 0 ? '' : buffer[i - 1];
        return prev === '' || /\s/.test(prev) ? i : -1;
      }
      if (/\s/.test(ch)) return -1;
    }
    return -1;
  }

  function getActiveCompletion(): ActiveCompletion | null {
    // Slash command: whole-buffer prefix match.
    if (options.completions && buffer.startsWith('/')) {
      const lower = buffer.toLowerCase();
      const matches = options.completions.filter((c) => c.text.toLowerCase().startsWith(lower));
      if (matches.length > 0) {
        return { mode: 'slash', matches, replaceStart: 0, replaceEnd: buffer.length };
      }
      return null;
    }
    // `@`-mention path completion under the caret.
    if (options.getPathCompletions && !panelDismissed) {
      const at = activeAtIndex();
      if (at >= 0) {
        const query = buffer.slice(at + 1, cursorPos);
        const matches = options.getPathCompletions(query);
        if (matches.length > 0) {
          return { mode: 'path', matches, replaceStart: at, replaceEnd: cursorPos };
        }
      }
    }
    return null;
  }

  // Apply the highlighted completion. Slash replaces the whole buffer; a path
  // mention replaces its `@token` span — files gain a trailing space (the
  // mention is done, panel closes), directories gain a trailing `/` and leave
  // the panel open so typing narrows into the folder (drill-down).
  function applyCompletion(active: ActiveCompletion) {
    const item = active.matches[selectedCompletionIdx] ?? active.matches[0];
    if (!item) return;
    if (active.mode === 'slash') {
      if (item.text === buffer) return;
      buffer = item.text;
      cursorPos = buffer.length;
      selectedCompletionIdx = 0;
      resetHistoryBrowse();
      redraw();
      return;
    }
    const isDir = item.hint === 'dir' || item.text.endsWith('/');
    const insert = `@${item.text}${isDir ? '' : ' '}`;
    buffer = buffer.slice(0, active.replaceStart) + insert + buffer.slice(active.replaceEnd);
    cursorPos = active.replaceStart + insert.length;
    selectedCompletionIdx = 0;
    resetHistoryBrowse();
    redraw();
  }

  // Panel rendered below the bottom border when the user is typing a slash
  // command or an `@`-mention. Only the selected row is accent-colored; the
  // others are dimmed so the active option stands out. Up/down navigate,
  // tab/enter complete.
  function renderCompletionsPanel(): string {
    const active = getActiveCompletion();
    if (!active) return '';
    const matches = active.matches;
    if (selectedCompletionIdx >= matches.length) selectedCompletionIdx = 0;
    const ACCENT = `${ESC}38;5;74m`;
    const DIM = `${ESC}38;5;245m`;
    const RESET = `${ESC}39m`;
    const termW = Math.max(20, process.stdout.columns ?? 80);

    // `@`-mention rows: only the selected row is accent-colored (accent `@` +
    // bold accent path); the rest are dimmed so it's clear which option is
    // active. The trailing `/` in a directory's text already marks it as a
    // folder, so no separate color is needed. Long paths are head-truncated so
    // a row never wraps (which would break the textarea's row accounting).
    if (active.mode === 'path') {
      const budget = Math.max(8, termW - 6);
      const rows: string[] = [''];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const sel = i === selectedCompletionIdx;
        const chevron = sel ? `${ACCENT}❯${RESET} ` : '  ';
        let label = m.text;
        if (label.length > budget) label = '…' + label.slice(label.length - (budget - 1));
        const at = sel ? `${ACCENT}@${RESET}` : `${DIM}@${RESET}`;
        const styled = sel
          ? `${ACCENT}${ESC}1m${label}${ESC}22m${RESET}`
          : `${DIM}${label}${RESET}`;
        rows.push('  ' + chevron + at + styled);
      }
      return rows.join('\n');
    }

    const cmdColW = Math.max(...matches.map((m) => m.text.length)) + 2;
    const rows: string[] = [''];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const sel = i === selectedCompletionIdx;
      const chevron = sel ? `${ACCENT}❯${RESET} ` : '  ';
      // Only the selected command is accent-colored (accent `/` + bold name);
      // the rest are dimmed so the active option stands out.
      const slash = m.text.startsWith('/') ? `${sel ? ACCENT : DIM}/${RESET}` : '';
      const name = m.text.startsWith('/') ? m.text.slice(1) : m.text;
      const nameStyled = sel
        ? `${ACCENT}${ESC}1m${name}${ESC}22m${RESET}`
        : `${DIM}${name}${RESET}`;
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
    // Ghost text only makes sense for slash mode, where the whole buffer is the
    // completion prefix; `@`-path completions are too long to ghost.
    const active = getActiveCompletion();
    if (!active || active.mode !== 'slash') return;
    const match = active.matches[selectedCompletionIdx] ?? active.matches[0];
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
      const bot = options.getBottomBorder({ footerFocused });
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

  // Record a just-submitted value into the recall history. Empties and an
  // immediate repeat of the previous entry are skipped (a shell's ignoredups),
  // and the list is capped. Always resets the browse position back to the
  // live-draft slot so the next ↑ starts from the most recent entry.
  function recordHistory(value: string) {
    if (value && history[history.length - 1] !== value) {
      history.push(value);
      if (history.length > MAX_HISTORY) history.shift();
    }
    historyIdx = history.length;
    historyDraft = '';
  }

  // Any manual edit drops out of history-browsing: the edited buffer becomes
  // the live draft again, so the next ↑ recalls starting from the newest entry.
  function resetHistoryBrowse() {
    historyIdx = history.length;
  }

  // Replace the buffer with a recalled entry, park the caret at its end, and
  // fully redraw — buffer length and soft-wrap can change arbitrarily, so an
  // in-place line rewrite won't do.
  function loadHistoryEntry(text: string) {
    buffer = text;
    cursorPos = buffer.length;
    selectedCompletionIdx = 0;
    panelDismissed = false;
    redraw();
  }

  // Browse the recall history one step: dir -1 = older (↑), +1 = newer (↓).
  // Returns true when it consumed the key (changed the buffer). At the oldest
  // entry ↑ is a no-op; past the newest, ↓ restores the stashed live draft.
  function browseHistory(dir: -1 | 1): boolean {
    if (dir < 0) {
      if (history.length === 0 || historyIdx === 0) return false;
      // Leaving the live draft → stash it so ↓ can bring it back later.
      if (historyIdx === history.length) historyDraft = buffer;
      historyIdx--;
      loadHistoryEntry(history[historyIdx]);
      return true;
    }
    if (historyIdx >= history.length) return false;
    historyIdx++;
    loadHistoryEntry(historyIdx === history.length ? historyDraft : history[historyIdx]);
    return true;
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

    // Footer-focus mode: ↓ moved focus onto the background-jobs chip. While
    // focused, ⏎ opens its viewer; ↑/Esc (or any edit key) leaves focus. This
    // must run before the global Esc handler so Esc just unfocuses here.
    if (footerFocused) {
      if (key.name === 'return') {
        footerFocused = false;
        redraw();
        options.onFooterActivate?.();
        return;
      }
      if (key.name === 'down') return; // already focused — stay put
      footerFocused = false;
      redraw();
      // ↑ and Esc only leave focus; any other key falls through to normal
      // editing on the now-unfocused (still empty) input.
      if (key.name === 'up' || key.name === 'escape') return;
    }

    // Esc with an open `@`-mention panel dismisses the panel (keeping the typed
    // text) rather than interrupting. Otherwise Esc interrupts an in-flight run
    // — the handler (interactive mode) decides whether anything is running.
    // Note: emitKeypressEvents parses arrow keys etc. into their own named
    // keys, so `escape` only fires for a bare Esc press.
    if (key.name === 'escape') {
      const active = getActiveCompletion();
      if (active && active.mode === 'path') {
        panelDismissed = true;
        redraw();
        return;
      }
      emitter.emit('interrupt');
      return;
    }

    if (!textareaDrawn) drawTextarea();

    // Ctrl+V: hand off to the paste handler (grab a clipboard image, or return
    // text to insert here). Runs async; we redraw when it resolves.
    if (key.ctrl && key.name === 'v' && options.onPaste) {
      void options
        .onPaste()
        .then((text) => {
          if (text) {
            // The buffer is a single logical line; flatten newlines so the
            // wrapped-caret math stays correct.
            const clean = text.replace(/\r?\n/g, ' ');
            buffer = buffer.slice(0, cursorPos) + clean + buffer.slice(cursorPos);
            cursorPos += clean.length;
            selectedCompletionIdx = 0;
          }
          redraw();
        })
        .catch(() => {});
      return;
    }

    if (key.shift && key.name === 'tab' && options.onShiftTab) {
      options.onShiftTab();
      redraw();
      return;
    }

    if (key.name === 'return') {
      const active = getActiveCompletion();
      // An open `@`-mention panel: Enter inserts the selected path (and, for a
      // directory, keeps the panel open to drill in) rather than submitting.
      if (active && active.mode === 'path') {
        applyCompletion(active);
        return;
      }
      // A slash panel: submit the selected command verbatim (so partial input
      // like "/co" submits as "/compact"). Otherwise submit the buffer as-is.
      const chosen = active ? active.matches[selectedCompletionIdx] : undefined;
      const value = chosen ? chosen.text : buffer.trim();
      // Full erase/redraw: a single-row clear would leave stale wrapped
      // input rows and any open completions panel on screen.
      if (textareaDrawn) eraseTextarea();
      buffer = '';
      cursorPos = 0;
      selectedCompletionIdx = 0;
      panelDismissed = false;
      recordHistory(value);
      drawTextarea();
      emitter.emit('submit', value);
      return;
    }

    if (key.name === 'tab') {
      const active = getActiveCompletion();
      if (active) applyCompletion(active);
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
      const active = getActiveCompletion();
      if (active && active.matches.length > 1) {
        const len = active.matches.length;
        selectedCompletionIdx =
          key.name === 'up'
            ? (selectedCompletionIdx - 1 + len) % len
            : (selectedCompletionIdx + 1) % len;
        redraw();
        return;
      }
      // ↓ on an empty prompt moves focus onto the footer's background-jobs chip
      // (highlighted); ⏎ then opens its viewer.
      if (key.name === 'down' && buffer.length === 0 && options.footerCanFocus?.()) {
        footerFocused = true;
        redraw();
        return;
      }
      // No completions panel: within a soft-wrapped input ↑/↓ first move the
      // caret between the wrapped rows. Only when the caret is already on the
      // edge row (top for ↑, bottom for ↓) does the key recall the submitted-
      // input history — ↑ older, ↓ newer — mirroring a shell's line recall.
      const termW = termWidth();
      const caretOffset = promptVisibleLen + cursorPos;
      const lastRow = Math.floor((promptVisibleLen + buffer.length) / termW);
      const row = Math.floor(caretOffset / termW);
      if (key.name === 'up') {
        if (row > 0) moveCaretTo(Math.max(0, caretOffset - termW - promptVisibleLen));
        else browseHistory(-1);
      } else {
        if (row < lastRow)
          moveCaretTo(Math.min(buffer.length, caretOffset + termW - promptVisibleLen));
        else browseHistory(1);
      }
      return;
    }

    if (key.name === 'backspace') {
      if (cursorPos > 0) {
        const hadSlash = buffer.includes('/');
        // An '@' anywhere means the path panel may need to open/close/refresh.
        const hadAt = buffer.includes('@');
        const atEnd = cursorPos === buffer.length;
        // Wrapped before the delete → the input may shrink a row and the
        // borders move up; only a full redraw keeps the frame consistent.
        const wrapped = promptVisibleLen + buffer.length >= termWidth();
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos--;
        selectedCompletionIdx = 0;
        resetHistoryBrowse();
        // A '/' (command recoloring) or '@' (path panel) anywhere can't be
        // expressed by an in-place '\b \b' / mid-row rewrite — full redraw.
        if (hadSlash || hadAt || wrapped) {
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
      resetHistoryBrowse();
      // A fresh `@` re-arms a panel the user previously dismissed with Esc.
      if (str === '@') panelDismissed = false;
      // Wrapped after the insert (>= because at an exact row fill the input
      // grows a forced row) → borders shift down; full redraw required.
      const wrapped = promptVisibleLen + buffer.length >= termWidth();
      // A '/' (command recoloring) or '@' (path panel) anywhere can't be
      // expressed by an in-place write — fall back to a full redraw.
      if (buffer.includes('/') || buffer.includes('@') || wrapped) {
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
    isActive: () => active,
  }) as unknown as Textarea;

  return api;
}
