import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * `captureKey` backs the y/a/n approval prompt: while a capture is pending it
 * owns the keyboard — listed keys resolve the promise, everything else (other
 * characters, Esc when not listed, Enter) is swallowed so stray typing can't
 * leak into the textarea or fire interrupt/submit mid-prompt. Ctrl+C still
 * exits.
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

describe('textarea captureKey (modal approval hotkeys)', () => {
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

  it('resolves with the pressed key and swallows non-listed keys', async () => {
    const textarea = createTextarea({ prompt: '> ' });
    const onSubmit = vi.fn();
    const onInterrupt = vi.fn();
    textarea.on('submit', onSubmit);
    textarea.on('interrupt', onInterrupt);

    const capture = textarea.captureKey(['y', 'a', 'n']);

    // Non-listed keys are swallowed: no submit, no echo into the buffer.
    emitKey(stdin, 'x', { sequence: 'x' });
    emitKey(stdin, 'return');
    emitKey(stdin, 'y', { sequence: 'y' });

    await expect(capture).resolves.toBe('y');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();

    // After resolution the modal is gone — Enter submits an empty-trim buffer
    // (typing works again).
    emitKey(stdin, 'h', { sequence: 'h' });
    emitKey(stdin, 'return');
    expect(onSubmit).toHaveBeenCalledWith('h');
    textarea.close();
  });

  it('captures Esc when listed instead of firing interrupt', async () => {
    const textarea = createTextarea({ prompt: '> ' });
    const onInterrupt = vi.fn();
    textarea.on('interrupt', onInterrupt);

    const capture = textarea.captureKey(['y', 'escape']);
    emitKey(stdin, 'escape');

    await expect(capture).resolves.toBe('escape');
    expect(onInterrupt).not.toHaveBeenCalled();
    textarea.close();
  });

  it('matches keys case-insensitively', async () => {
    const textarea = createTextarea({ prompt: '> ' });
    const capture = textarea.captureKey(['Y']);
    emitKey(stdin, 'y', { sequence: 'Y', shift: true });
    await expect(capture).resolves.toBe('y');
    textarea.close();
  });

  it('still exits on ctrl+c while a capture is pending', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const onExit = vi.fn();
    textarea.on('exit', onExit);

    void textarea.captureKey(['y']);
    emitKey(stdin, 'c', { ctrl: true });

    expect(onExit).toHaveBeenCalledTimes(1);
    textarea.close();
  });
});
