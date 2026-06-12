import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandAtMentions } from '../src/cli/at-mentions.js';

/**
 * `expandAtMentions` rewrites the agent payload at submit time: each resolvable
 * `@path` appends a preview block inside <attached-files>, while the raw input
 * text is preserved verbatim at the front. Unresolvable tokens and non-mention
 * `@` (e.g. emails) leave the text untouched.
 */
describe('expandAtMentions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-atmentions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the input unchanged when there are no mentions', () => {
    expect(expandAtMentions('just a normal prompt', dir)).toBe('just a normal prompt');
  });

  it('does not treat an email address as a mention', () => {
    writeFileSync(join(dir, 'example.com'), 'x');
    const input = 'mail me at user@example.com please';
    expect(expandAtMentions(input, dir)).toBe(input);
  });

  it('injects a numbered preview and preserves the raw text + full path', () => {
    writeFileSync(join(dir, 'hello.ts'), 'const a = 1;\nconst b = 2;\n');
    const out = expandAtMentions('look at @hello.ts', dir);
    expect(out.startsWith('look at @hello.ts')).toBe(true);
    expect(out).toContain('<attached-files>');
    expect(out).toContain('<file path="hello.ts">');
    // read-tool numbered-line format (1-based, padded to 4 cols).
    expect(out).toContain('   1\tconst a = 1;');
    expect(out).toContain('   2\tconst b = 2;');
  });

  it('caps the preview at 50 lines and points at the read tool', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(dir, 'big.txt'), body);
    const out = expandAtMentions('@big.txt', dir);
    expect(out).toContain('  50\tline 50');
    expect(out).not.toContain('  51\tline 51');
    expect(out).toContain('first 50 of 200 lines');
    expect(out).toContain('use the read tool on "big.txt"');
  });

  it('lists directory contents with trailing slashes for subdirs', () => {
    mkdirSync(join(dir, 'pkg', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'a.ts'), 'x');
    const out = expandAtMentions('see @pkg', dir);
    expect(out).toContain('<dir path="pkg/">');
    expect(out).toContain('a.ts');
    expect(out).toContain('sub/');
  });

  it('skips binary files but still names them', () => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const out = expandAtMentions('@bin.dat', dir);
    expect(out).toContain('<file path="bin.dat"');
    expect(out).toContain('binary file');
    // No numbered preview lines for a binary.
    expect(out).not.toContain('\t');
  });

  it('dedupes repeated mentions of the same path', () => {
    writeFileSync(join(dir, 'dup.ts'), 'x');
    const out = expandAtMentions('@dup.ts and again @dup.ts', dir);
    expect(out.match(/<file path="dup.ts">/g)).toHaveLength(1);
  });

  it('passes through unresolvable tokens and returns identity when none resolve', () => {
    expect(expandAtMentions('@nope.ts is missing', dir)).toBe('@nope.ts is missing');
  });

  it('expands only the resolvable mention when mixed with a missing one', () => {
    writeFileSync(join(dir, 'real.ts'), 'x');
    const out = expandAtMentions('@real.ts and @ghost.ts', dir);
    expect(out).toContain('<file path="real.ts">');
    expect(out).not.toContain('path="ghost.ts"');
  });
});
