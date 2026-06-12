import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProjectMemoryDir } from '../src/config.js';
import { createMemoryTool } from '../src/tools/memory.js';

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('memory tool', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;
  // A stable cwd so the project hash (and thus the memory dir) is deterministic.
  const cwd = '/memory/tool/project';
  let tool: ReturnType<typeof createMemoryTool>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-mem-tool-'));
    process.env.HARNEXT_HOME = home;
    tool = createMemoryTool(cwd);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('create then view round-trips a memory file', async () => {
    const created = await tool.execute('1', { command: 'create', path: 'indent.md', text: 'two spaces' });
    expect(created.details.ok).toBe(true);
    // File lands inside the per-project memory dir.
    const onDisk = readFileSync(join(getProjectMemoryDir(cwd), 'indent.md'), 'utf-8');
    expect(onDisk).toBe('two spaces');

    const viewed = await tool.execute('2', { command: 'view', path: 'indent.md' });
    expect(textOf(viewed)).toContain('two spaces');
  });

  it('view with no path lists the directory', async () => {
    await tool.execute('1', { command: 'create', path: 'a.md', text: 'x' });
    await tool.execute('2', { command: 'create', path: 'b.md', text: 'y' });
    const listed = await tool.execute('3', { command: 'view' });
    const text = textOf(listed);
    expect(text).toContain('a.md');
    expect(text).toContain('b.md');
  });

  it('str_replace updates a unique match and rejects ambiguous ones', async () => {
    await tool.execute('1', { command: 'create', path: 'f.md', text: 'foo once' });
    const okEdit = await tool.execute('2', {
      command: 'str_replace',
      path: 'f.md',
      old_str: 'foo',
      new_str: 'bar',
    });
    expect(okEdit.details.ok).toBe(true);
    expect(readFileSync(join(getProjectMemoryDir(cwd), 'f.md'), 'utf-8')).toBe('bar once');

    await tool.execute('3', { command: 'create', path: 'dup.md', text: 'x x' });
    const ambiguous = await tool.execute('4', {
      command: 'str_replace',
      path: 'dup.md',
      old_str: 'x',
      new_str: 'y',
    });
    expect(ambiguous.details.ok).toBe(false);
    expect(textOf(ambiguous)).toContain('Must be unique');
  });

  it('delete and rename work', async () => {
    await tool.execute('1', { command: 'create', path: 'old.md', text: 'hi' });
    const renamed = await tool.execute('2', { command: 'rename', path: 'old.md', new_path: 'new.md' });
    expect(renamed.details.ok).toBe(true);
    expect(readFileSync(join(getProjectMemoryDir(cwd), 'new.md'), 'utf-8')).toBe('hi');

    const deleted = await tool.execute('3', { command: 'delete', path: 'new.md' });
    expect(deleted.details.ok).toBe(true);
    const gone = await tool.execute('4', { command: 'view', path: 'new.md' });
    expect(gone.details.ok).toBe(false);
  });

  it('rejects path traversal outside the memory directory', async () => {
    const escape = await tool.execute('1', {
      command: 'create',
      path: '../../escape.md',
      text: 'nope',
    });
    expect(escape.details.ok).toBe(false);
    expect(textOf(escape)).toContain('escapes the memory directory');
  });
});
