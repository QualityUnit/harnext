import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/args.js';

describe('parseArgs — --base-url / --api-key', () => {
  it('parses the documented example without leaking the URL into messages', () => {
    // The regression at the heart of #80: --base-url used to fall into
    // args.messages and get sent to the model as prompt text.
    const args = parseArgs(['--base-url', 'http://localhost:8000/v1', '--model', 'my-finetune']);
    expect(args.baseUrl).toBe('http://localhost:8000/v1');
    expect(args.model).toBe('my-finetune');
    expect(args.messages).toEqual([]);
  });

  it('parses --api-key', () => {
    const args = parseArgs(['--api-key', 'sk-x']);
    expect(args.apiKey).toBe('sk-x');
  });

  it('leaves baseUrl/apiKey undefined when not passed', () => {
    const args = parseArgs(['-p', 'hello']);
    expect(args.baseUrl).toBeUndefined();
    expect(args.apiKey).toBeUndefined();
  });

  it('keeps mode/flags/positionals intact alongside the new flags', () => {
    const args = parseArgs(['-p', '--base-url', 'http://localhost:8000/v1', '-m', 'x', 'hi']);
    expect(args.mode).toBe('print');
    expect(args.baseUrl).toBe('http://localhost:8000/v1');
    expect(args.model).toBe('x');
    expect(args.messages).toEqual(['hi']);
  });
});
