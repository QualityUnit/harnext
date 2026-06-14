import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTextarea } from '../src/cli/input.js';

/**
 * ↑/↓ recall previously submitted input, shell-style: ↑ walks toward older
 * entries, ↓ toward newer, and ↓ past the newest restores the draft the user
 * was typing. Editing drops out of browsing, and immediate duplicates are
 * deduped. Within a soft-wrapped input the keys move the caret between wrapped
 * rows first and only recall history from the edge row. Buffer state is
 * asserted through the submit payload (the only observable of the buffer).
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

describe('textarea history navigation', () => {
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

  function track(textarea: ReturnType<typeof createTextarea>): string[] {
    const values: string[] = [];
    textarea.on('submit', (v) => values.push(v));
    return values;
  }

  function submit(text: string) {
    type(stdin, text);
    emitKey(stdin, 'return');
  }

  it('↑ recalls successively older submissions', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('first');
    submit('second');
    emitKey(stdin, 'up'); // → "second"
    emitKey(stdin, 'up'); // → "first"
    emitKey(stdin, 'return'); // submit the recalled "first"
    expect(values).toEqual(['first', 'second', 'first']);
    textarea.close();
  });

  it('↓ walks back toward newer entries and restores the live draft', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('a');
    submit('b');
    type(stdin, 'draft'); // an in-progress, unsubmitted line
    emitKey(stdin, 'up'); // → "b" (draft stashed)
    emitKey(stdin, 'up'); // → "a"
    emitKey(stdin, 'down'); // → "b"
    emitKey(stdin, 'down'); // past the newest → restores "draft"
    emitKey(stdin, 'return');
    expect(values).toEqual(['a', 'b', 'draft']);
    textarea.close();
  });

  it('↑ at the oldest entry stays put', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('only');
    emitKey(stdin, 'up'); // → "only"
    emitKey(stdin, 'up'); // already oldest → no-op
    emitKey(stdin, 'up'); // still no-op
    emitKey(stdin, 'return');
    expect(values).toEqual(['only', 'only']);
    textarea.close();
  });

  it('editing a recalled entry drops out of browsing', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('alpha');
    submit('beta');
    emitKey(stdin, 'up'); // → "beta"
    emitKey(stdin, 'backspace'); // edit → "bet"; browsing resets
    emitKey(stdin, 'up'); // recalls the newest again → "beta" (draft "bet" stashed)
    emitKey(stdin, 'down'); // back to the edited draft → "bet"
    emitKey(stdin, 'return');
    expect(values).toEqual(['alpha', 'beta', 'bet']);
    textarea.close();
  });

  it('skips an immediate duplicate submission', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('dup');
    submit('dup'); // deduped in history, but still emitted
    emitKey(stdin, 'up'); // → "dup"
    emitKey(stdin, 'up'); // only one entry → no-op
    emitKey(stdin, 'return');
    expect(values).toEqual(['dup', 'dup', 'dup']);
    textarea.close();
  });

  it('starts empty: ↑/↓ do nothing before anything is submitted', () => {
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    emitKey(stdin, 'up');
    emitKey(stdin, 'down');
    type(stdin, 'fresh');
    emitKey(stdin, 'return');
    expect(values).toEqual(['fresh']);
    textarea.close();
  });

  it('within wrapped input ↑ moves a row up before recalling history', () => {
    process.stdout.columns = 20;
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('prev'); // history: ["prev"]
    type(stdin, 'abcdefghijklmnopqrstuvwxyz0123'); // 30 chars → wraps to 2 rows
    emitKey(stdin, 'up'); // caret row 1 → row 0: moves caret, does NOT recall
    emitKey(stdin, 'return');
    expect(values).toEqual(['prev', 'abcdefghijklmnopqrstuvwxyz0123']);
    textarea.close();
  });

  it('within wrapped input ↑ from the top row recalls history', () => {
    process.stdout.columns = 20;
    const textarea = createTextarea({ prompt: '> ' });
    const values = track(textarea);
    submit('prev');
    type(stdin, 'abcdefghijklmnopqrstuvwxyz0123');
    emitKey(stdin, 'up'); // row 1 → row 0 (caret move)
    emitKey(stdin, 'up'); // already on the top row → recalls "prev"
    emitKey(stdin, 'return');
    expect(values).toEqual(['prev', 'prev']);
    textarea.close();
  });
});
