import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTextarea } from '../src/cli/input.js';
import type { CompletionItem } from '../src/cli/input.js';

/**
 * End-to-end coverage of the `@`-mention picker through the real textarea: a
 * fake TTY is driven with keypresses and we inspect what gets written and what
 * the textarea ultimately submits. Mirrors the highlight e2e harness.
 */
const ESC = '\x1B[';

type FakeStdin = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode: (v: boolean) => void;
  resume: () => void;
};

function makeFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  return stdin;
}

function type(stdin: FakeStdin, text: string) {
  for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
}
function press(stdin: FakeStdin, name: string) {
  stdin.emit('keypress', undefined, { name });
}
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// Dirs first so a folder query selects the directory by default; substring
// filter mirrors the real completer's shape (text + 'dir' hint).
const PATHS = ['src/cli/', 'src/', 'src/cli/input.ts', 'src/cli/file-search.ts', 'README.md'];
function getPathCompletions(query: string): CompletionItem[] {
  const q = query.toLowerCase();
  return PATHS.filter((p) => p.toLowerCase().includes(q))
    .slice(0, 8)
    .map((p) => ({ text: p, hint: p.endsWith('/') ? 'dir' : undefined }));
}

const slashCompletions: CompletionItem[] = [
  { text: '/model', hint: 'switch model' },
  { text: '/compact', hint: 'compact history' },
];

describe('textarea @-mention picker (e2e)', () => {
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
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  });

  function capture(fn: () => void): string {
    writes = [];
    fn();
    return stripAnsi(writes.join(''));
  }

  function make() {
    // A bottom border is required for the completion panel to render (the
    // textarea only emits the panel inside the getBottomBorder block).
    return createTextarea({
      prompt: '> ',
      getBottomBorder: () => '────',
      completions: slashCompletions,
      getPathCompletions,
    });
  }

  it('opens the picker when @ is typed at the start of input', () => {
    const textarea = make();
    const out = capture(() => type(stdin, '@inp'));
    expect(out).toContain('src/cli/input.ts');
    textarea.close();
  });

  it('does not open the picker for an email-like token', () => {
    const textarea = make();
    const out = capture(() => type(stdin, 'user@host'));
    expect(out).not.toContain('input.ts');
    expect(out).not.toContain('README.md');
    textarea.close();
  });

  it('Enter inserts the selected file (with trailing space) instead of submitting', () => {
    const textarea = make();
    const onSubmit = vi.fn();
    textarea.on('submit', onSubmit);
    type(stdin, '@inp');
    press(stdin, 'return'); // insert, must NOT submit
    expect(onSubmit).not.toHaveBeenCalled();
    press(stdin, 'return'); // now submit the composed buffer
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('@src/cli/input.ts');
    textarea.close();
  });

  it('Tab inserts the selected path', () => {
    const textarea = make();
    const onSubmit = vi.fn();
    textarea.on('submit', onSubmit);
    type(stdin, '@inp');
    press(stdin, 'tab');
    press(stdin, 'return');
    expect(onSubmit.mock.calls[0][0]).toBe('@src/cli/input.ts');
    textarea.close();
  });

  it('Down navigates the result list before inserting', () => {
    const textarea = make();
    const onSubmit = vi.fn();
    textarea.on('submit', onSubmit);
    type(stdin, '@.ts'); // matches input.ts then file-search.ts
    press(stdin, 'down'); // select the second match
    press(stdin, 'return'); // insert it
    press(stdin, 'return'); // submit
    expect(onSubmit.mock.calls[0][0]).toBe('@src/cli/file-search.ts');
    textarea.close();
  });

  it('selecting a directory inserts a trailing / and keeps the panel open (drill-down)', () => {
    const textarea = make();
    const onSubmit = vi.fn();
    textarea.on('submit', onSubmit);
    type(stdin, '@src/cli/'); // dir is ranked first by the stub
    const afterEnter = capture(() => press(stdin, 'return'));
    expect(onSubmit).not.toHaveBeenCalled();
    // Panel still open: children remain visible after the directory insert.
    expect(afterEnter).toContain('src/cli/input.ts');
    textarea.close();
  });

  it('Esc dismisses an open picker without firing interrupt', () => {
    const textarea = make();
    const onInterrupt = vi.fn();
    textarea.on('interrupt', onInterrupt);
    type(stdin, '@inp');
    const afterEsc = capture(() => press(stdin, 'escape'));
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(afterEsc).not.toContain('src/cli/input.ts'); // panel closed
    // A second Esc (no panel) falls through to interrupt.
    press(stdin, 'escape');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    textarea.close();
  });

  it('still serves slash-command completions (regression)', () => {
    const textarea = make();
    const out = capture(() => type(stdin, '/mod'));
    expect(out).toContain('model');
    textarea.close();
  });
});
