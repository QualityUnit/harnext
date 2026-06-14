import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { select } from '../src/cli/select.js';

/**
 * A long label/hint (e.g. a verbose background-job command) must be truncated
 * so the row fits the terminal width — a wrapped row corrupts the in-place
 * redraw. These tests pin that each rendered option line stays within columns.
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

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

describe('select row width clamping', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s: string | Uint8Array) => {
        writes.push(String(s));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  it('truncates a long hint so the row fits the terminal width', async () => {
    const longCmd =
      "bash -c 'for i in $(seq 1 180); do shuf -n 1 /usr/share/dict/words 2>/dev/null || echo \"word$RANDOM\"; sleep 1; done'";
    const p = select([{ label: 'bash_1  running · 9s', value: 'bash_1', hint: longCmd }], {
      title: 'Background jobs',
    });
    stdin.emit('keypress', undefined, { name: 'return' });
    await p;

    const rowLines = writes
      .join('')
      .split('\n')
      .map(stripAnsi)
      .filter((l) => l.includes('bash_1'));
    expect(rowLines.length).toBeGreaterThan(0);
    for (const line of rowLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    // The command was long enough that it had to be cut with an ellipsis.
    expect(rowLines.some((l) => l.includes('…'))).toBe(true);
  });

  it('leaves short rows untouched', async () => {
    const p = select([{ label: 'Refresh output', value: 'r', hint: 'short' }], {
      title: 'x',
      searchable: false,
    });
    stdin.emit('keypress', undefined, { name: 'return' });
    await p;
    const out = stripAnsi(writes.join(''));
    expect(out).toContain('Refresh output');
    expect(out).toContain('short');
    expect(out).not.toContain('…');
  });
});
