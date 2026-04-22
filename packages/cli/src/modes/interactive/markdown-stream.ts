/**
 * Incrementally formats a streaming markdown text into ANSI-styled output.
 *
 * The tricky bit: a delta may split a delimiter (e.g. first chunk ends with
 * `*`, next starts with `*`). We keep a small internal buffer of characters
 * that *could* be the start/end of a delimiter and only emit them once we
 * know which way they resolve.
 *
 * Supported:
 *   **bold**      → bold
 *   `code`        → cyan
 *
 * Everything else flows through unchanged.
 */

type Mode = 'normal' | 'bold' | 'code';

const BOLD_OPEN = '\x1B[1m';
const BOLD_CLOSE = '\x1B[22m';
const CODE_OPEN = '\x1B[36m';
const CODE_CLOSE = '\x1B[39m';

export function createMarkdownStreamer() {
  let pending = '';
  let mode: Mode = 'normal';

  // In `normal` mode, if the buffer ends with a `*`, we can't emit it yet —
  // a following `*` would make it a bold opener. Same story for the tail of
  // a `**` while in bold mode: leave trailing `*` pending in case a second
  // `*` is about to arrive and close the span.
  function feed(delta: string): string {
    pending += delta;
    let out = '';
    // If a write of some unrelated UI happens between feed() calls (e.g. the
    // sticky textarea redraws its footer, which contains chalk.dim whose
    // close code `\x1B[22m` resets bold), the terminal's SGR state for our
    // span is lost. Re-emit the active open code at the start of every
    // produced chunk so the terminal re-enters the span before rendering.
    const startMode = mode;

    while (pending.length > 0) {
      if (mode === 'normal') {
        const boldIdx = pending.indexOf('**');
        const codeIdx = pending.indexOf('`');
        let firstIdx = -1;
        let kind: 'bold' | 'code' | null = null;
        if (boldIdx >= 0 && (codeIdx < 0 || boldIdx < codeIdx)) {
          firstIdx = boldIdx;
          kind = 'bold';
        } else if (codeIdx >= 0) {
          firstIdx = codeIdx;
          kind = 'code';
        }

        if (firstIdx < 0) {
          if (pending.endsWith('*')) {
            out += pending.slice(0, -1);
            pending = '*';
          } else {
            out += pending;
            pending = '';
          }
          break;
        }

        out += pending.slice(0, firstIdx);
        if (kind === 'bold') {
          pending = pending.slice(firstIdx + 2);
          mode = 'bold';
          out += BOLD_OPEN;
        } else {
          pending = pending.slice(firstIdx + 1);
          mode = 'code';
          out += CODE_OPEN;
        }
      } else if (mode === 'bold') {
        const closeIdx = pending.indexOf('**');
        if (closeIdx < 0) {
          if (pending.endsWith('*')) {
            out += pending.slice(0, -1);
            pending = '*';
          } else {
            out += pending;
            pending = '';
          }
          break;
        }
        out += pending.slice(0, closeIdx);
        out += BOLD_CLOSE;
        pending = pending.slice(closeIdx + 2);
        mode = 'normal';
      } else {
        const closeIdx = pending.indexOf('`');
        if (closeIdx < 0) {
          out += pending;
          pending = '';
          break;
        }
        out += pending.slice(0, closeIdx);
        out += CODE_CLOSE;
        pending = pending.slice(closeIdx + 1);
        mode = 'normal';
      }
    }

    if (out.length > 0 && startMode !== 'normal') {
      const reopen = startMode === 'bold' ? BOLD_OPEN : CODE_OPEN;
      out = reopen + out;
    }
    return out;
  }

  function flush(): string {
    const startMode = mode;
    let out = pending;
    if (mode === 'bold') out += BOLD_CLOSE;
    else if (mode === 'code') out += CODE_CLOSE;
    if (out.length > 0 && startMode !== 'normal') {
      const reopen = startMode === 'bold' ? BOLD_OPEN : CODE_OPEN;
      out = reopen + out;
    }
    pending = '';
    mode = 'normal';
    return out;
  }

  return { feed, flush };
}

export type MarkdownStreamer = ReturnType<typeof createMarkdownStreamer>;
