import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * Left/right (plus home/end and ctrl+a/ctrl+e) move a caret within the input
 * buffer: insertion and backspace happen at the caret, not unconditionally at
 * the end of the line. Buffer behavior is asserted through the submit payload;
 * the TTY test asserts the terminal cursor actually moves on screen.
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

function emitKey(
  stdin: FakeStdin,
  name: string,
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } = {},
) {
  stdin.emit('keypress', opts.sequence, { name, ...opts });
}

function type(stdin: FakeStdin, text: string) {
  for (const ch of text) emitKey(stdin, ch, { sequence: ch });
}

describe('textarea cursor navigation', () => {
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

  function submitted(textarea: ReturnType<typeof createTextarea>): string {
    let value = '';
    textarea.on('submit', (v) => {
      value = v;
    });
    emitKey(stdin, 'return');
    return value;
  }

  it('inserts at the caret after moving left', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'helo');
    emitKey(stdin, 'left');
    type(stdin, 'l');
    expect(submitted(textarea)).toBe('hello');
    textarea.close();
  });

  it('right moves the caret back toward the end', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'ab');
    emitKey(stdin, 'left');
    emitKey(stdin, 'left');
    emitKey(stdin, 'right');
    type(stdin, 'X');
    expect(submitted(textarea)).toBe('aXb');
    textarea.close();
  });

  it('clamps left at the start and right at the end', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'ab');
    for (let i = 0; i < 5; i++) emitKey(stdin, 'left');
    type(stdin, 'X');
    for (let i = 0; i < 10; i++) emitKey(stdin, 'right');
    type(stdin, 'Y');
    expect(submitted(textarea)).toBe('XabY');
    textarea.close();
  });

  it('backspace deletes the character before the caret', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'abc');
    emitKey(stdin, 'left');
    emitKey(stdin, 'backspace');
    expect(submitted(textarea)).toBe('ac');
    textarea.close();
  });

  it('home/end and ctrl+a/ctrl+e jump to the buffer edges', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'bc');
    emitKey(stdin, 'home');
    type(stdin, 'a');
    emitKey(stdin, 'end');
    type(stdin, 'd');
    emitKey(stdin, 'a', { ctrl: true });
    type(stdin, '<');
    emitKey(stdin, 'e', { ctrl: true });
    type(stdin, '>');
    expect(submitted(textarea)).toBe('<abcd>');
    textarea.close();
  });

  it('resets the caret on submit', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values: string[] = [];
    textarea.on('submit', (v) => values.push(v));
    type(stdin, 'ab');
    emitKey(stdin, 'left');
    emitKey(stdin, 'return');
    type(stdin, 'cd');
    emitKey(stdin, 'return');
    expect(values).toEqual(['ab', 'cd']);
    textarea.close();
  });

  it('moves the terminal cursor on screen (TTY)', () => {
    stdin.isTTY = true;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'ab');

    // Prompt '> ' is 2 cols, so caret index n sits at screen column 2 + n.
    writes.length = 0;
    emitKey(stdin, 'left');
    expect(writes.join('')).toBe('\r\x1B[3C');

    writes.length = 0;
    emitKey(stdin, 'left');
    expect(writes.join('')).toBe('\r\x1B[2C');

    // Caret is at index 0 — a further left press must not move the cursor.
    writes.length = 0;
    emitKey(stdin, 'left');
    expect(writes).toHaveLength(0);

    writes.length = 0;
    emitKey(stdin, 'right');
    expect(writes.join('')).toBe('\r\x1B[3C');

    // Caret at index 1 of "ab": typing must re-render the line, not append.
    writes.length = 0;
    type(stdin, 'X');
    expect(writes.join('')).toContain('aXb');

    textarea.close();
    spy.mockRestore();
  });
});

describe('textarea wrapped-input navigation', () => {
  let originalStdin: NodeJS.ReadStream;
  let originalColumns: number | undefined;
  let stdin: FakeStdin;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalColumns = process.stdout.columns;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    process.stdout.columns = originalColumns as number;
  });

  function submitted(textarea: ReturnType<typeof createTextarea>): string {
    let value = '';
    textarea.on('submit', (v) => {
      value = v;
    });
    emitKey(stdin, 'return');
    return value;
  }

  it('up moves the caret one terminal row up within wrapped input', () => {
    process.stdout.columns = 20;
    const textarea = createTextarea({ prompt: '> ' });
    // 2 (prompt) + 30 chars at width 20 → caret at row 1, col 12.
    type(stdin, 'abcdefghijklmnopqrstuvwxyz0123');
    emitKey(stdin, 'up'); // same column, one row up → caret index 10
    type(stdin, 'X');
    expect(submitted(textarea)).toBe('abcdefghijXklmnopqrstuvwxyz0123');
    textarea.close();
  });

  it('up clamps to the buffer start when the row above is the prompt', () => {
    process.stdout.columns = 10;
    const textarea = createTextarea({ prompt: '> ' });
    // 2 + 8 chars exactly fill the row; caret sits on the forced next row.
    type(stdin, 'abcdefgh');
    emitKey(stdin, 'up');
    type(stdin, 'X');
    expect(submitted(textarea)).toBe('Xabcdefgh');
    textarea.close();
  });

  it('down moves a row down and stops on the last row', () => {
    process.stdout.columns = 10;
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'abcdefghijkl'); // rows: "> abcdefgh" / "ijkl"
    emitKey(stdin, 'home');
    emitKey(stdin, 'down'); // caret index 10 (row 1, col 2)
    emitKey(stdin, 'down'); // already on the last row — no-op
    type(stdin, 'Z');
    expect(submitted(textarea)).toBe('abcdefghijZkl');
    textarea.close();
  });

  it('down clamps to the buffer end when the last row is shorter', () => {
    process.stdout.columns = 10;
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'abcdefghijkl');
    emitKey(stdin, 'up'); // caret index 2 (row 0)
    emitKey(stdin, 'down'); // back down: offset 14 clamps to end (index 12)
    type(stdin, 'Z');
    expect(submitted(textarea)).toBe('abcdefghijklZ');
    textarea.close();
  });

  it('up/down do nothing when the input fits one row', () => {
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'abc');
    emitKey(stdin, 'up');
    emitKey(stdin, 'down');
    type(stdin, 'X');
    expect(submitted(textarea)).toBe('abcX');
    textarea.close();
  });

  it('left/right cross the wrap boundary on screen (TTY)', () => {
    stdin.isTTY = true;
    process.stdout.columns = 20;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const textarea = createTextarea({ prompt: '> ' });
    type(stdin, 'abcdefghijklmnopqrstuvwxyz0123'); // caret offset 32: row 1, col 12

    writes.length = 0;
    emitKey(stdin, 'up'); // row 1 → row 0, same column
    expect(writes.join('')).toBe('\x1B[1A\r\x1B[12C');

    writes.length = 0;
    emitKey(stdin, 'down');
    expect(writes.join('')).toBe('\x1B[1B\r\x1B[12C');

    // Walk the caret to offset 20 (row 1, col 0), then cross the boundary.
    for (let i = 0; i < 12; i++) emitKey(stdin, 'left');
    writes.length = 0;
    emitKey(stdin, 'left'); // offset 19: row 0, col 19
    expect(writes.join('')).toBe('\x1B[1A\r\x1B[19C');

    writes.length = 0;
    emitKey(stdin, 'right'); // back to offset 20: row 1, col 0
    expect(writes.join('')).toBe('\x1B[1B\r');

    textarea.close();
    spy.mockRestore();
  });
});
