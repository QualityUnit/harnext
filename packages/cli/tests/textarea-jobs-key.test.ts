import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * ↓ on an empty prompt focuses the footer's background-jobs chip; ⏎ then opens
 * the viewer. These tests pin that two-step flow: focus only on empty-buffer ↓
 * (gated by footerCanFocus), activate only via ⏎ while focused, and ↑/text
 * leaves focus so ⏎ submits normally again.
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

describe('textarea ↓ focuses background-jobs chip; ⏎ activates', () => {
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

  it('↓ on empty then ⏎ activates the viewer (and does not submit)', () => {
    const footerCanFocus = vi.fn(() => true);
    const onFooterActivate = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', footerCanFocus, onFooterActivate });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'down'); // focus the chip
    emitKey(stdin, 'return'); // activate

    expect(footerCanFocus).toHaveBeenCalled();
    expect(onFooterActivate).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    textarea.close();
  });

  it('does not focus when the buffer has text (⏎ submits normally)', () => {
    const footerCanFocus = vi.fn(() => true);
    const onFooterActivate = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({ prompt: '> ', footerCanFocus, onFooterActivate });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'h', { sequence: 'h' });
    emitKey(stdin, 'i', { sequence: 'i' });
    emitKey(stdin, 'down');
    emitKey(stdin, 'return');

    expect(footerCanFocus).not.toHaveBeenCalled();
    expect(onFooterActivate).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    textarea.close();
  });

  it('does not focus when footerCanFocus returns false', () => {
    const onFooterActivate = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({
      prompt: '> ',
      footerCanFocus: () => false,
      onFooterActivate,
    });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'down');
    emitKey(stdin, 'return');

    expect(onFooterActivate).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1); // empty submit, normal behavior
    textarea.close();
  });

  it('↑ leaves focus so ⏎ submits instead of activating', () => {
    const onFooterActivate = vi.fn();
    const onSubmit = vi.fn();
    const textarea = createTextarea({
      prompt: '> ',
      footerCanFocus: () => true,
      onFooterActivate,
    });
    textarea.on('submit', onSubmit);

    emitKey(stdin, 'down'); // focus
    emitKey(stdin, 'up'); // blur
    emitKey(stdin, 'return'); // should submit, not activate

    expect(onFooterActivate).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    textarea.close();
  });
});
