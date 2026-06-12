import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/args.js';

describe('parseArgs — connect subcommand', () => {
  it('parses the endpoint from --endpoint', () => {
    const args = parseArgs(['connect', '--endpoint', 'https://engine.example.com']);
    expect(args.mode).toBe('connect');
    expect(args.connectEndpoint).toBe('https://engine.example.com');
    expect(args.connectDisable).toBeUndefined();
  });

  it('accepts a bare positional endpoint', () => {
    const args = parseArgs(['connect', 'https://engine.example.com']);
    expect(args.mode).toBe('connect');
    expect(args.connectEndpoint).toBe('https://engine.example.com');
  });

  it('parses --disable', () => {
    const args = parseArgs(['connect', '--disable']);
    expect(args.mode).toBe('connect');
    expect(args.connectDisable).toBe(true);
  });
});
