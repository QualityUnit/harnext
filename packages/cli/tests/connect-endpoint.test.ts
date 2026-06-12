import { describe, expect, it } from 'vitest';

import { DEFAULT_ENDPOINT, normalizeEndpoint } from '../src/cli/connect-prompt.js';

describe('normalizeEndpoint', () => {
  it('points a bare origin at the engine /api base', () => {
    expect(normalizeEndpoint('https://app.harnext.dev')).toBe('https://app.harnext.dev/api');
  });

  it('defaults the scheme to https and adds /api', () => {
    expect(normalizeEndpoint('app.harnext.dev')).toBe('https://app.harnext.dev/api');
  });

  it('treats a trailing slash as a bare origin', () => {
    expect(normalizeEndpoint('https://app.harnext.dev/')).toBe('https://app.harnext.dev/api');
  });

  it('leaves an explicit path untouched (self-hosted engines)', () => {
    expect(normalizeEndpoint('https://engine.example.com/ingest')).toBe(
      'https://engine.example.com/ingest',
    );
  });

  it('is idempotent on an already-normalized endpoint', () => {
    expect(normalizeEndpoint('https://app.harnext.dev/api')).toBe('https://app.harnext.dev/api');
  });

  it('preserves a non-default port', () => {
    expect(normalizeEndpoint('http://localhost:8787')).toBe('http://localhost:8787/api');
  });

  it('returns empty for empty input', () => {
    expect(normalizeEndpoint('   ')).toBe('');
  });

  it('the default endpoint normalizes to the engine /api base', () => {
    expect(normalizeEndpoint(DEFAULT_ENDPOINT)).toBe('https://app.harnext.dev/api');
  });
});
