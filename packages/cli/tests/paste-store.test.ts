import { describe, expect, it } from 'vitest';

import {
  createPasteStore,
  DEFAULT_PASTE_CHAR_THRESHOLD,
  shouldStorePaste,
} from '../src/cli/paste-store.js';

describe('shouldStorePaste', () => {
  it('stores any multi-line paste (even short)', () => {
    expect(shouldStorePaste('a\nb')).toBe(true);
    expect(shouldStorePaste('a\r\nb')).toBe(true);
  });

  it('inlines short single-line pastes', () => {
    expect(shouldStorePaste('hello world')).toBe(false);
    expect(shouldStorePaste('x'.repeat(DEFAULT_PASTE_CHAR_THRESHOLD))).toBe(false);
  });

  it('stores a long single-line paste over the threshold', () => {
    expect(shouldStorePaste('x'.repeat(DEFAULT_PASTE_CHAR_THRESHOLD + 1))).toBe(true);
  });

  it('honors a custom char threshold', () => {
    expect(shouldStorePaste('hello', { charThreshold: 3 })).toBe(true);
    expect(shouldStorePaste('hi', { charThreshold: 3 })).toBe(false);
  });
});

describe('createPasteStore', () => {
  it('registers text and returns a compact line-count placeholder', () => {
    const store = createPasteStore();
    const token = store.register('line1\nline2\nline3');
    expect(token).toBe('[Pasted text #1 +3 lines]');
    expect(store.size).toBe(1);
  });

  it('uses a char-count placeholder for a long single line', () => {
    const store = createPasteStore();
    const token = store.register('y'.repeat(500));
    expect(token).toBe('[Pasted text #1 500 chars]');
  });

  it('singularizes a one-line placeholder', () => {
    const store = createPasteStore();
    expect(store.register('only one line, but long enough'.repeat(20))).toBe(
      '[Pasted text #1 600 chars]',
    );
    // A trailing newline still counts as a single line.
    expect(store.register('just one\n')).toBe('[Pasted text #2 +1 line]');
  });

  it('expands a placeholder back to the exact original text (newlines preserved)', () => {
    const store = createPasteStore();
    const raw = 'first line\nsecond line\nthird';
    const token = store.register(raw);
    expect(store.expand(`look at this: ${token} please`)).toBe(`look at this: ${raw} please`);
  });

  it('expands multiple placeholders, each to its own text', () => {
    const store = createPasteStore();
    const a = store.register('AAA\nAAA');
    const b = store.register('z'.repeat(300));
    expect(store.expand(`${a} and ${b}`)).toBe(`AAA\nAAA and ${'z'.repeat(300)}`);
  });

  it('leaves an unknown look-alike token untouched on expand', () => {
    const store = createPasteStore();
    expect(store.expand('a literal [Pasted text #999 +2 lines] I typed')).toBe(
      'a literal [Pasted text #999 +2 lines] I typed',
    );
  });

  it('detects a token ending exactly at the caret for atomic deletion', () => {
    const store = createPasteStore();
    const token = store.register('multi\nline');
    const value = `hi ${token}`;
    const found = store.tokenEndingAt(value, value.length);
    expect(found).toBeDefined();
    expect(found?.token).toBe(token);
    expect(found?.start).toBe(3);
    expect(found?.end).toBe(value.length);
  });

  it('does not report a token when the caret is elsewhere', () => {
    const store = createPasteStore();
    const token = store.register('multi\nline');
    const value = `${token} trailing`;
    expect(store.tokenEndingAt(value, value.length)).toBeUndefined(); // caret after " trailing"
    expect(store.tokenEndingAt(value, token.length - 1)).toBeUndefined(); // mid-token
  });

  it('does not treat an unknown look-alike token as deletable', () => {
    const store = createPasteStore();
    const value = '[Pasted text #42 +1 line]';
    expect(store.tokenEndingAt(value, value.length)).toBeUndefined();
  });

  it('clears entries but keeps ids monotonic (no stale-token collisions)', () => {
    const store = createPasteStore();
    const first = store.register('a\nb');
    expect(first).toBe('[Pasted text #1 +2 lines]');
    store.clear();
    expect(store.size).toBe(0);
    const second = store.register('c\nd');
    expect(second).toBe('[Pasted text #2 +2 lines]'); // id advanced, not reused
    // The cleared entry no longer expands.
    expect(store.expand(first)).toBe(first);
  });
});
