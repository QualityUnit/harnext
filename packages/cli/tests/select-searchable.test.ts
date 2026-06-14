import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { select } from '../src/cli/select.js';

/**
 * `searchable: false` suppresses the type-to-search bar (and the "type to
 * search" hint) for short, fixed action menus like the per-job Refresh / Kill /
 * Back list — where a search box is just noise.
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

describe('select searchable option', () => {
  let originalStdin: NodeJS.ReadStream;
  let stdin: FakeStdin;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalStdin = process.stdin;
    stdin = makeFakeStdin();
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
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

  const items = [
    { label: 'Refresh output', value: 'refresh' },
    { label: 'Back to list', value: 'back' },
  ];

  it('omits the search bar when searchable is false', async () => {
    const p = select(items, { title: 'bash_1 — completed', searchable: false });
    stdin.emit('keypress', undefined, { name: 'return' });
    const result = await p;

    const out = writes.join('');
    expect(out).not.toContain('search:');
    expect(out).not.toContain('type to search');
    expect(result).toBe('refresh');
  });

  it('shows the search bar by default', async () => {
    const p = select(items, { title: 'pick' });
    stdin.emit('keypress', undefined, { name: 'return' });
    await p;

    const out = writes.join('');
    expect(out).toContain('search:');
    expect(out).toContain('type to search');
  });

  it('ignores typed characters when not searchable (no filtering)', async () => {
    const p = select(items, { title: 'pick', searchable: false });
    // Typing would normally filter; here it must be a no-op, so "Refresh" stays
    // selectable as the first item.
    stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' });
    stdin.emit('keypress', undefined, { name: 'return' });
    const result = await p;
    expect(result).toBe('refresh');
  });
});
