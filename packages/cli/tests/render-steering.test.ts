import { describe, expect, it } from 'vitest';

import { queuedSteers, stripAnsi, undeliveredSteers } from '../src/modes/interactive/render.js';

describe('queuedSteers', () => {
  it('renders nothing when the queue is empty', () => {
    expect(queuedSteers([])).toBe('');
  });

  it('renders one dimmed line per queued message with an edit hint on the last', () => {
    const plain = stripAnsi(queuedSteers(['fix the test', 'update the docs']));
    const lines = plain.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('fix the test');
    expect(lines[1]).toContain('update the docs');
    // Only the last queued line advertises the dequeue affordance.
    expect(lines[0]).not.toContain('esc to edit');
    expect(lines[1]).toContain('esc to edit');
  });

  it('keeps every line within the terminal width (multi-line text folded to one row)', () => {
    const width = process.stdout.columns || 80;
    const multiline = 'first line\nsecond line that keeps going '.repeat(8);
    const plain = stripAnsi(queuedSteers([multiline, 'short']));
    for (const line of plain.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line).not.toContain('\n');
    }
  });
});

describe('undeliveredSteers', () => {
  it('summarizes the count and lists the undelivered text', () => {
    const plain = stripAnsi(undeliveredSteers(['fix the test', 'update the docs']));
    expect(plain).toContain('2 queued messages not delivered');
    expect(plain).toContain('fix the test');
    expect(plain).toContain('update the docs');
  });

  it('uses the singular form for a single message', () => {
    const plain = stripAnsi(undeliveredSteers(['only one']));
    expect(plain).toContain('1 queued message not delivered');
    expect(plain).not.toContain('messages not delivered');
  });
});
