import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/args.js';

describe('parseArgs — SDK parity flags', () => {
  it('parses allowed/disallowed tools, repeated and comma-separated', () => {
    const args = parseArgs([
      '-p',
      '--allowed-tools',
      'Read,Bash',
      '--allowed-tools',
      'Edit',
      '--disallowed-tools',
      'WebFetch',
      'hello',
    ]);
    expect(args.mode).toBe('print');
    expect(args.allowedTools).toEqual(['Read', 'Bash', 'Edit']);
    expect(args.disallowedTools).toEqual(['WebFetch']);
    expect(args.messages).toEqual(['hello']);
  });

  it('parses permission-mode, max-turns, setting-sources', () => {
    const args = parseArgs([
      '-p',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '25',
      '--setting-sources',
      'project,user',
      'go',
    ]);
    expect(args.permissionMode).toBe('dontAsk');
    expect(args.maxTurns).toBe(25);
    expect(args.settingSources).toEqual(['project', 'user']);
  });

  it('parses output-format, input-format, append-system-prompt, add-dir, sandbox', () => {
    const args = parseArgs([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--append-system-prompt',
      'extra rules',
      '--add-dir',
      '/a',
      '--add-dir',
      '/b',
      '--sandbox',
      '{"enabled":true}',
    ]);
    expect(args.outputFormat).toBe('stream-json');
    expect(args.inputFormat).toBe('stream-json');
    expect(args.appendSystemPrompt).toBe('extra rules');
    expect(args.addDirs).toEqual(['/a', '/b']);
    expect(args.sandbox).toBe('{"enabled":true}');
  });

  it('ignores empty/invalid max-turns', () => {
    expect(parseArgs(['-p', '--max-turns', '0', 'x']).maxTurns).toBeUndefined();
    expect(parseArgs(['-p', '--max-turns', 'abc', 'x']).maxTurns).toBeUndefined();
  });

  it('leaves new fields undefined when not passed', () => {
    const args = parseArgs(['-p', 'hello']);
    expect(args.allowedTools).toBeUndefined();
    expect(args.permissionMode).toBeUndefined();
    expect(args.outputFormat).toBeUndefined();
  });

  it('still parses existing model/system-prompt/cwd flags', () => {
    const args = parseArgs([
      '-p',
      '-m',
      'claude-opus-4-8',
      '--system-prompt',
      'sys',
      '--cwd',
      '/work',
      'do',
    ]);
    expect(args.model).toBe('claude-opus-4-8');
    expect(args.systemPrompt).toBe('sys');
    expect(args.cwd).toBe('/work');
  });
});
