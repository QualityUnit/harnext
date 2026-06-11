import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * End-to-end coverage of slash-command highlighting through the real textarea:
 * we drive a fake TTY with keypresses and inspect exactly what gets written to
 * the terminal. This exercises the full wiring — the draw path, and the
 * keystroke fast-paths that must fall back to a redraw when a '/' is present so
 * the command (re)colors correctly.
 */
const ESC = '\x1B[';
const ACCENT = `${ESC}38;5;74m`;
const RESET = `${ESC}39m`;

type FakeStdin = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode: (v: boolean) => void;
  resume: () => void;
};

function makeFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  // A TTY stdin makes the textarea actually draw to stdout — required to
  // observe the highlighting.
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  return stdin;
}

function type(stdin: FakeStdin, text: string) {
  for (const ch of text) {
    stdin.emit('keypress', ch, { name: ch, sequence: ch });
  }
}

function backspace(stdin: FakeStdin) {
  stdin.emit('keypress', undefined, { name: 'backspace' });
}

describe('textarea slash-command highlighting (e2e)', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    Object.defineProperty(process.stdout, 'columns', {
      value: originalColumns,
      configurable: true,
    });
  });

  // Capture only what gets written from `fn()` onward.
  function capture(fn: () => void): string {
    writes = [];
    fn();
    return writes.join('');
  }

  const completions = [
    { text: '/goal', hint: 'run a goal' },
    { text: '/model', hint: 'switch model' },
  ];

  it('colorizes a known command typed as the whole prompt', () => {
    const textarea = createTextarea({ prompt: '> ', completions });
    const out = capture(() => type(stdin, '/goal'));
    expect(out).toContain(`${ACCENT}/goal${RESET}`);
    textarea.close();
  });

  it('colorizes a command typed in the middle of a prompt', () => {
    const textarea = createTextarea({ prompt: '> ', completions });
    type(stdin, 'please run ');
    const out = capture(() => type(stdin, '/model'));
    expect(out).toContain(`${ACCENT}/model${RESET}`);
    textarea.close();
  });

  it('does not colorize an unrecognized /token', () => {
    const textarea = createTextarea({ prompt: '> ', completions });
    const out = capture(() => type(stdin, '/nope'));
    expect(out).not.toContain(ACCENT);
    // The literal text is still rendered.
    expect(out).toContain('/nope');
    textarea.close();
  });

  it('drops the highlight when a completed command is edited back into a partial', () => {
    const textarea = createTextarea({ prompt: '> ', completions });
    type(stdin, '/goal');
    // Backspace to "/goa" — no longer an exact command, so the next render
    // must contain the plain token without the accent wrapper.
    const out = capture(() => backspace(stdin));
    const lastDraw = out.slice(out.lastIndexOf('> '));
    expect(lastDraw).toContain('/goa');
    expect(lastDraw).not.toContain(`${ACCENT}/goa`);
    textarea.close();
  });

  it('submits the raw command text without ANSI codes', () => {
    const textarea = createTextarea({ prompt: '> ', completions });
    const onSubmit = vi.fn();
    textarea.on('submit', onSubmit);
    type(stdin, '/goal');
    stdin.emit('keypress', undefined, { name: 'return' });
    expect(onSubmit).toHaveBeenCalledWith('/goal');
    textarea.close();
  });
});
