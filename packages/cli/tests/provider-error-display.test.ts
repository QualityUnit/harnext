import { describe, expect, it } from 'vitest';

import { errorBlock, stripAnsi } from '../src/modes/interactive/render.js';

describe('errorBlock', () => {
  it('renders an error badge, the default headline, and the message on a rail', () => {
    const plain = stripAnsi(errorBlock('401 Incorrect API key provided'));
    const lines = plain.split('\n');
    expect(lines[0]).toContain('✗ error');
    expect(lines[0]).toContain('the model request failed');
    expect(plain).toContain('401 Incorrect API key provided');
    // The message body sits on a red rail.
    expect(lines.slice(1).every((l) => l.startsWith('│ '))).toBe(true);
  });

  it('accepts a custom headline', () => {
    const plain = stripAnsi(errorBlock('boom', 'request to anthropic failed'));
    expect(plain.split('\n')[0]).toContain('request to anthropic failed');
  });

  it('falls back to a placeholder when the provider returns no message', () => {
    const plain = stripAnsi(errorBlock('   '));
    expect(plain).toContain('unknown error');
  });

  it('word-wraps long messages so no body line overflows the terminal width', () => {
    const width = process.stdout.columns || 80;
    const long =
      'The model request failed because the provider rejected the request with a very long ' +
      'diagnostic message that should be wrapped across several lines rather than truncated so ' +
      'the user can read the whole thing without losing any detail at all whatsoever.';
    const plain = stripAnsi(errorBlock(long));
    const bodyLines = plain.split('\n').slice(1);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
    // No words are dropped — the wrapped body preserves the full message.
    const reassembled = bodyLines.map((l) => l.replace(/^│ /, '')).join(' ');
    for (const word of long.split(/\s+/)) {
      expect(reassembled).toContain(word);
    }
  });

  it('hard-splits tokens longer than the available width (e.g. URLs/JSON)', () => {
    const width = process.stdout.columns || 80;
    const token = 'x'.repeat(width * 2);
    const plain = stripAnsi(errorBlock(token));
    for (const line of plain.split('\n').slice(1)) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});
