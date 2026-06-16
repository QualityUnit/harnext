import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * Bracketed paste (issue #60): a terminal with bracketed-paste mode wraps a
 * paste in ESC[200~ … ESC[201~, which Node's readline surfaces as
 * `paste-start` / `paste-end` keypresses with the content (newlines included,
 * as `enter`) in between. The textarea must capture that whole span as ONE
 * paste so the embedded newlines do NOT each fire a submit — the multi-line
 * paste infinite loop. Captured text routes through the same paste-store as
 * Ctrl+V (placeholder for large/multi-line, inline for small).
 */
type FakeStdin = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode: (v: boolean) => void;
  resume: () => void;
};

function makeFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = false;
  stdin.isRaw = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  return stdin;
}

function emitKey(stdin: FakeStdin, name: string, opts: { sequence?: string } = {}) {
  stdin.emit('keypress', opts.sequence, { name, ...opts });
}

/** Drive a full bracketed paste: start marker, the content, end marker. */
function pasteBracketed(stdin: FakeStdin, text: string) {
  stdin.emit('keypress', undefined, { name: 'paste-start' });
  for (const ch of text) {
    stdin.emit('keypress', ch, { name: ch === '\n' ? 'enter' : ch, sequence: ch });
  }
  stdin.emit('keypress', undefined, { name: 'paste-end' });
}

describe('textarea bracketed paste (issue #60)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  it('does NOT submit on the newlines inside a multi-line paste', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    pasteBracketed(stdin, 'line one\nline two\nline three');
    // The two embedded newlines must not have triggered any submit.
    expect(onSubmit).not.toHaveBeenCalled();

    // An explicit Enter afterwards submits once, with the full text expanded
    // (multi-line ⇒ stored behind a placeholder ⇒ expanded verbatim).
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two\nline three');
    textarea.close();
  });

  it('preserves a single backspace as atomic deletion of the pasted placeholder', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    pasteBracketed(stdin, 'a\nb\nc\nd');
    // One backspace removes the entire placeholder token (not one char).
    emitKey(stdin, 'backspace');
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('');
    textarea.close();
  });

  it('inlines a small single-line bracketed paste (no placeholder)', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    pasteBracketed(stdin, 'quick note');
    expect(onSubmit).not.toHaveBeenCalled();
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('quick note');
    textarea.close();
  });

  it('keeps pasted text and typed text together, in order', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    for (const ch of 'see: ') emitKey(stdin, ch, { sequence: ch });
    pasteBracketed(stdin, 'multi\nline\nblock');
    for (const ch of ' done') emitKey(stdin, ch, { sequence: ch });
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith('see: multi\nline\nblock done');
    textarea.close();
  });

  it('a normal Enter (outside any paste) still submits', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    for (const ch of 'hello') emitKey(stdin, ch, { sequence: ch });
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    textarea.close();
  });

  it('handles an empty paste (start immediately followed by end) without error', () => {
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('submit', onSubmit);

    stdin.emit('keypress', undefined, { name: 'paste-start' });
    stdin.emit('keypress', undefined, { name: 'paste-end' });
    // Typing still works after an empty paste (capture flag was cleared).
    for (const ch of 'ok') emitKey(stdin, ch, { sequence: ch });
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('ok');
    textarea.close();
  });
});

describe('bracketed paste mode enable/disable (TTY)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[];
  let cols: number | undefined;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    stdin.isTTY = true; // a real terminal — enable/disable should be emitted
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    cols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  });

  it('enables bracketed paste on start and disables it on close', () => {
    const textarea = createTextarea({ prompt: '> ' });
    expect(writes.join('')).toContain('\x1B[?2004h'); // enable on start
    const beforeClose = writes.length;
    textarea.close();
    expect(writes.slice(beforeClose).join('')).toContain('\x1B[?2004l'); // disable on close
  });

  it('disables bracketed paste on pause and re-enables on resume', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const beforePause = writes.length;
    textarea.pause();
    expect(writes.slice(beforePause).join('')).toContain('\x1B[?2004l');
    const beforeResume = writes.length;
    textarea.resume();
    expect(writes.slice(beforeResume).join('')).toContain('\x1B[?2004h');
    textarea.close();
  });
});
