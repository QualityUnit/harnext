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

  it('flattens newlines in pasted text (single-line buffer)', async () => {
    const onPaste = vi.fn(async () => 'line1\nline2\r\nline3');
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onPaste });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'v', { ctrl: true });
    await tick();
    emitKey(stdin, 'return');

    expect(onSubmit).toHaveBeenCalledWith('line1 line2 line3');
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
