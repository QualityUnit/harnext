import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * The interactive REPL keeps the textarea live while the agent streams, so a
 * keypress during generation must reach `onKeypress`. These tests pin the Esc
 * wiring: Esc emits `interrupt` (which interactive mode turns into an abort),
 * without also submitting or exiting.
 *
 * A non-TTY fake stdin is enough: the escape branch fires before any of the
 * TTY-only drawing, and `hasTTY` false makes draw/erase no-ops.
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

describe('textarea Esc interrupt wiring', () => {
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

  it('emits "interrupt" when Esc is pressed', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    const onExit = vi.fn();
    textarea.on('interrupt', onInterrupt);
    textarea.on('submit', onSubmit);
    textarea.on('exit', onExit);

    emitKey(stdin, 'escape');

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    textarea.close();
  });

  it('emits "interrupt" (not "exit") on a single ctrl+c; exit needs a second (#71)', () => {
    // Ctrl+C is now two-stage — full coverage in textarea-ctrl-c.test.ts.
    const textarea = createTextarea({ prompt: '> ' });
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    emitKey(stdin, 'c', { ctrl: true });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();

    emitKey(stdin, 'c', { ctrl: true });
    expect(onExit).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('does not treat arrow keys as Esc (no spurious interrupt)', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const onInterrupt = vi.fn();
    textarea.on('interrupt', onInterrupt);

    // emitKeypressEvents delivers arrow keys as their own named keys, never a
    // bare 'escape', so navigation must not fire interrupt.
    emitKey(stdin, 'up');
    emitKey(stdin, 'down');

    expect(onInterrupt).not.toHaveBeenCalled();
    textarea.close();
  });
});
