import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * Steering dequeue: while the agent streams, submitting queues a steering
 * message shown as a gray "queued" line above the input. Esc on an *empty*
 * input peels the most recent queued message back into the buffer for editing
 * (via the `onSteerDequeue` callback) instead of interrupting the run. A
 * non-empty buffer is never clobbered — Esc interrupts there as usual.
 *
 * A non-TTY fake stdin is enough: the escape branch fires before any TTY-only
 * drawing, and `hasTTY` false makes draw/erase no-ops while buffer edits still
 * run.
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

describe('textarea steering dequeue (Esc)', () => {
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

  it('Esc on an empty input recalls a queued steer for editing (no interrupt)', () => {
    const onSteerDequeue = vi.fn(() => 'fix the failing test too');
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onSteerDequeue });
    textarea.on('interrupt', onInterrupt);
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'escape');

    expect(onSteerDequeue).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();

    // The recalled text is now in the buffer — pressing Enter submits it.
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('fix the failing test too');
    textarea.close();
  });

  it('Esc interrupts (does not dequeue) when the input has a draft', () => {
    const onSteerDequeue = vi.fn(() => 'queued message');
    const onInterrupt = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onSteerDequeue });
    textarea.on('interrupt', onInterrupt);

    emitKey(stdin, 'a', { sequence: 'a' }); // draft in progress
    emitKey(stdin, 'escape');

    expect(onSteerDequeue).not.toHaveBeenCalled();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('Esc interrupts when nothing is queued (callback returns null)', () => {
    const onSteerDequeue = vi.fn(() => null);
    const onInterrupt = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onSteerDequeue });
    textarea.on('interrupt', onInterrupt);

    emitKey(stdin, 'escape');

    expect(onSteerDequeue).toHaveBeenCalledTimes(1);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('Esc interrupts as before when no dequeue handler is wired', () => {
    const onInterrupt = vi.fn();
    const textarea = createTextarea({ prompt: '> ' });
    textarea.on('interrupt', onInterrupt);

    emitKey(stdin, 'escape');

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  // ── #54 QA coverage ───────────────────────────────────────────────

  it('repeated Esc drains the whole queue one message per press, then interrupts', () => {
    // Model the interactive-mode stack: each dequeue pops the most-recent entry.
    const queue = ['first', 'second', 'third'];
    const onSteerDequeue = vi.fn(() => queue.pop() ?? null);
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onSteerDequeue });
    textarea.on('interrupt', onInterrupt);
    textarea.on('submit', onSubmit);

    // 1st Esc recalls "third" into the buffer; submit it to clear the buffer so
    // the next Esc sees an empty input again.
    emitKey(stdin, 'escape');
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenLastCalledWith('third');

    emitKey(stdin, 'escape');
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenLastCalledWith('second');

    emitKey(stdin, 'escape');
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenLastCalledWith('first');

    // Queue now empty → the next Esc interrupts instead of dequeuing.
    expect(onInterrupt).not.toHaveBeenCalled();
    emitKey(stdin, 'escape');
    expect(onSteerDequeue).toHaveBeenCalledTimes(4);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('does not clobber a non-empty draft buffer on Esc (interrupts instead, draft kept)', () => {
    const onSteerDequeue = vi.fn(() => 'queued');
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', onSteerDequeue });
    textarea.on('interrupt', onInterrupt);
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'h', { sequence: 'h' });
    emitKey(stdin, 'i', { sequence: 'i' });
    emitKey(stdin, 'escape'); // draft present → interrupt, no dequeue
    expect(onSteerDequeue).not.toHaveBeenCalled();
    expect(onInterrupt).toHaveBeenCalledTimes(1);

    // The draft survived the interrupt — submitting emits it unchanged.
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('hi');
    textarea.close();
  });
});
