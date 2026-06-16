import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * Ctrl+V routes to the onPaste handler: returned text is inserted at the cursor
 * (newlines flattened to keep the single-line buffer), and a null return means
 * the paste was handled out of band (an image was attached) — nothing inserted.
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
  opts: { ctrl?: boolean; meta?: boolean; sequence?: string } = {},
) {
  stdin.emit('keypress', opts.sequence, { name, ...opts });
}

const tick = () => new Promise((r) => setImmediate(r));

describe('textarea Ctrl+V paste', () => {
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

  it('inserts text returned by onPaste at the cursor', async () => {
    const onPaste = vi.fn(async () => 'hello world');
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    emitKey(stdin, 'return');

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello world');
    textarea.close();
  });

  it('preserves newlines in a multiline paste via the placeholder (#53)', async () => {
    // Previously the Ctrl+V path flattened newlines to spaces; a multiline paste
    // is now stored behind a placeholder and expanded verbatim at submit.
    const onPaste = vi.fn(async () => 'line1\nline2\r\nline3');
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith('line1\nline2\r\nline3');
    textarea.close();
  });

  it('inserts nothing when onPaste returns null (image attached out of band)', async () => {
    const onPaste = vi.fn(async () => null);
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    emitKey(stdin, 'return');

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('');
    textarea.close();
  });
});

describe('textarea large/multiline paste placeholder (issue #53)', () => {
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

  it('stores a multiline paste and expands it (newlines preserved) at submit', async () => {
    const pasted = 'def main():\n    print("hi")\n    return 0';
    const onPaste = vi.fn(async () => pasted);
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    emitKey(stdin, 'return');

    // Submit emits the ORIGINAL text (placeholder expanded, newlines intact) —
    // not the flattened inline form a small paste would produce.
    expect(onSubmit).toHaveBeenCalledWith(pasted);
    textarea.close();
  });

  it('expands a placeholder embedded among typed text', async () => {
    const pasted = 'alpha\nbeta\ngamma';
    const onPaste = vi.fn(async () => pasted);
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    // Type "see ", then paste, then type " ok".
    for (const ch of 'see ') emitKey(stdin, ch, { sequence: ch });
    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    for (const ch of ' ok') emitKey(stdin, ch, { sequence: ch });
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith(`see ${pasted} ok`);
    textarea.close();
  });

  it('deletes the whole placeholder token with a single backspace (atomic)', async () => {
    const onPaste = vi.fn(async () => 'a\nb\nc\nd\ne');
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    // One backspace removes the entire placeholder (proving it's a single token,
    // not the ~9 raw characters inlined).
    emitKey(stdin, 'backspace');
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith('');
    textarea.close();
  });

  it('still inlines a short single-line paste (flattened), unchanged', async () => {
    const onPaste = vi.fn(async () => 'short paste');
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    // A single backspace removes just one char (it was inlined, not a token).
    emitKey(stdin, 'backspace');
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith('short past');
    textarea.close();
  });
});
