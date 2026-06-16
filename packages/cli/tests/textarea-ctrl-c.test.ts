import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * Ctrl+C is two-stage (issue #71): the first press emits `interrupt` (the REPL
 * aborts an in-flight run without leaving the conversation) and arms a short
 * window; a second Ctrl+C inside that window emits `exit`. Ctrl+D still exits
 * immediately, and a single Ctrl+C never exits.
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

function emitKey(stdin: FakeStdin, name: string, opts: { ctrl?: boolean; sequence?: string } = {}) {
  stdin.emit('keypress', opts.sequence, { name, ...opts });
}

describe('textarea Ctrl+C — interrupt first, exit on second (issue #71)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    // Swallow the textarea's stdout (hint line, escape codes) to keep tests quiet.
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    vi.useRealTimers();
  });

  it('first Ctrl+C interrupts (does not exit)', () => {
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    emitKey(stdin, 'c', { ctrl: true });

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    textarea.close();
  });

  it('a second Ctrl+C within the window exits', () => {
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    emitKey(stdin, 'c', { ctrl: true });
    emitKey(stdin, 'c', { ctrl: true });

    expect(onInterrupt).toHaveBeenCalledTimes(1); // only the first press interrupts
    expect(onExit).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('disarms after the window: a later single Ctrl+C interrupts again, not exits', () => {
    vi.useFakeTimers();
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    emitKey(stdin, 'c', { ctrl: true }); // arms
    vi.advanceTimersByTime(2500); // window (2000ms) lapses → disarm
    emitKey(stdin, 'c', { ctrl: true }); // first press again

    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
    textarea.close();
  });

  it('typing between presses does not block the second-press exit (within window)', () => {
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('exit', onExit);

    emitKey(stdin, 'c', { ctrl: true });
    emitKey(stdin, 'a', { sequence: 'a' }); // some typing
    emitKey(stdin, 'c', { ctrl: true });

    expect(onExit).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('Ctrl+D still exits immediately (EOF)', () => {
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    emitKey(stdin, 'd', { ctrl: true });

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
    textarea.close();
  });

  it('keeps original immediate-exit while a modal key-capture is pending', async () => {
    const onInterrupt = vi.fn();
    const onExit = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);
    textarea.on('exit', onExit);

    void textarea.captureKey(['y', 'n']); // a y/a/n-style modal owns the keyboard
    emitKey(stdin, 'c', { ctrl: true });

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
    textarea.close();
  });
});
