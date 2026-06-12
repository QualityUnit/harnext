import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudIngestClient, type CloudTokens } from '../src/cloud/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokens(overrides: Partial<CloudTokens> = {}): CloudTokens {
  return {
    endpoint: 'http://engine/',
    clientId: 'harnext-cli',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('CloudIngestClient', () => {
  it('opens / appends / finalizes with the bearer token against the right URLs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { id: 'srv-1', status: 'open' }))
      .mockResolvedValueOnce(jsonResponse(200, { session_id: 'srv-1', accepted: 2, duplicates: 0, max_seq: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'srv-1', status: 'closed' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudIngestClient(tokens(), () => {});
    const opened = await client.openSession({ client_session_id: 'cs', harness: 'harnext' });
    expect(opened.id).toBe('srv-1');
    await client.appendEvents('srv-1', [
      { seq: 0, type: 'system', payload: {} },
      { seq: 1, type: 'assistant', payload: {} },
    ]);
    await client.finalize('srv-1', { stop_reason: 'completed' });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      'http://engine/agent/sessions',
      'http://engine/agent/sessions/srv-1/events',
      'http://engine/agent/sessions/srv-1/finalize',
    ]);
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Bearer access-1');
  });

  it('refreshes + rotates an expired access token before requesting', async () => {
    const persisted: CloudTokens[] = [];
    const fetchMock = vi
      .fn()
      // first call is the refresh (token endpoint) because the access token is expired
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-2',
          scope: 'agent',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 'srv-1', status: 'open' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudIngestClient(
      tokens({ accessExpiresAt: Date.now() - 1000 }),
      (t) => persisted.push(t),
    );
    await client.openSession({ client_session_id: 'cs', harness: 'harnext' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://engine/oauth/token');
    expect(persisted[0]).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    const openAuth = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(openAuth.Authorization).toBe('Bearer access-2');
  });

  it('rotates once and retries on a 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' })) // first attempt rejected
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-2',
          scope: 'agent',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { id: 'srv-1', status: 'open' })); // retry succeeds
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudIngestClient(tokens(), () => {});
    const opened = await client.openSession({ client_session_id: 'cs', harness: 'harnext' });
    expect(opened.id).toBe('srv-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
