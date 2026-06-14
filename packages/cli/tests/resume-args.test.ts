import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/args.js';

describe('parseArgs — --resume', () => {
  it('sets resume with no id (picker) for bare --resume', () => {
    const args = parseArgs(['--resume']);
    expect(args.mode).toBe('interactive');
    expect(args.resume).toBe(true);
    expect(args.resumeSessionId).toBeUndefined();
  });

  it('accepts the -r alias', () => {
    const args = parseArgs(['-r']);
    expect(args.resume).toBe(true);
    expect(args.resumeSessionId).toBeUndefined();
  });

  it('consumes a UUID-shaped token as the session id', () => {
    const id = '3f9c1b2a-4d5e-4f6a-8b9c-0d1e2f3a4b5c';
    const args = parseArgs(['--resume', id]);
    expect(args.resume).toBe(true);
    expect(args.resumeSessionId).toBe(id);
  });

  it('does not treat a following message as a session id', () => {
    const args = parseArgs(['--resume', 'list', 'the', 'files']);
    expect(args.resume).toBe(true);
    expect(args.resumeSessionId).toBeUndefined();
    expect(args.messages).toEqual(['list', 'the', 'files']);
  });

  it('works alongside print mode for scripted resume', () => {
    const id = '3f9c1b2a-4d5e-4f6a-8b9c-0d1e2f3a4b5c';
    const args = parseArgs(['-p', '--resume', id, 'continue please']);
    expect(args.mode).toBe('print');
    expect(args.resumeSessionId).toBe(id);
    expect(args.messages).toEqual(['continue please']);
  });
});
