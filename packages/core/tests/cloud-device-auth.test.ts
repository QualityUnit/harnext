import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CloudAuthError,
  discoverClientId,
  discoverEngine,
  pollForToken,
  refreshTokens,
  requestDeviceCode,
} from '../src/cloud/device-auth.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A `/health` body the engine returns (carries the device-flow marker). */
function engineHealth(clientId = 'harnext-cli'): unknown {
  return { ok: true, agent_oauth: { device_flow: true, client_id: clientId } };
}

describe('discoverClientId', () => {
  it('reads agent_oauth.client_id from /health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, engineHealth('custom-cli'))));
    expect(await discoverClientId('http://engine')).toBe('custom-cli');
  });

  it('falls back to the default when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    expect(await discoverClientId('http://engine')).toBe('harnext-cli');
  });
});

describe('discoverEngine', () => {
  it('uses the root when the API is served there (local make ingest)', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === 'http://localhost:8000/health'
        ? jsonResponse(200, engineHealth('harnext-cli'))
        : jsonResponse(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const info = await discoverEngine('http://localhost:8000');
    expect(info).toEqual({ apiBase: 'http://localhost:8000', clientId: 'harnext-cli' });
  });

  it('falls through to /api for a path-routed hosted engine', async () => {
    // The bare origin serves the web app: /health is a non-JSON 404. /api/health
    // is the real engine.
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://app.harnext.dev/health') {
        return new Response('<!doctype html>not found', { status: 404 });
      }
      if (url === 'https://app.harnext.dev/api/health') {
        return jsonResponse(200, engineHealth('harnext-cli'));
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    const info = await discoverEngine('https://app.harnext.dev');
    expect(info).toEqual({ apiBase: 'https://app.harnext.dev/api', clientId: 'harnext-cli' });
  });

  it('ignores a 200 that is not the engine health shape', async () => {
    // The web app answers /health with 200 JSON that lacks agent_oauth — must not
    // be mistaken for the API; the probe moves on to /api.
    const fetchMock = vi.fn(async (url: string) =>
      url === 'https://app.harnext.dev/api/health'
        ? jsonResponse(200, engineHealth())
        : jsonResponse(200, { ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const info = await discoverEngine('https://app.harnext.dev');
    expect(info.apiBase).toBe('https://app.harnext.dev/api');
  });

  it('trims a trailing slash before probing', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === 'http://localhost:8000/health' ? jsonResponse(200, engineHealth()) : jsonResponse(404, {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const info = await discoverEngine('http://localhost:8000/');
    expect(info.apiBase).toBe('http://localhost:8000');
  });

  it('falls back to the origin + default client id when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, {})));
    const info = await discoverEngine('http://unreachable');
    expect(info).toEqual({ apiBase: 'http://unreachable', clientId: 'harnext-cli' });
  });
});

describe('requestDeviceCode', () => {
  it('posts the client id and returns the device response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        device_code: 'dc',
        user_code: 'WXYZ-1234',
        verification_uri: 'http://engine/device',
        verification_uri_complete: 'http://engine/device?code=WXYZ-1234',
        expires_in: 600,
        interval: 5,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await requestDeviceCode('http://engine/', 'harnext-cli');
    expect(res.user_code).toBe('WXYZ-1234');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://engine/oauth/device/code'); // trailing slash trimmed
    expect((init as RequestInit).body).toContain('client_id=harnext-cli');
  });

  it('throws with the OAuth error code on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'invalid_client' })));
    await expect(requestDeviceCode('http://engine', 'rogue')).rejects.toMatchObject({
      code: 'invalid_client',
    });
  });
});

describe('pollForToken', () => {
  it('waits through authorization_pending then returns tokens', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: 'at',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rt',
          scope: 'agent',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const p = pollForToken('http://engine', 'harnext-cli', 'dc', {
      intervalSeconds: 1,
      expiresInSeconds: 60,
    });
    await vi.advanceTimersByTimeAsync(1000); // first poll → pending
    await vi.advanceTimersByTimeAsync(1000); // second poll → success
    await expect(p).resolves.toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on access_denied', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'access_denied' })));
    const p = pollForToken('http://engine', 'harnext-cli', 'dc', {
      intervalSeconds: 1,
      expiresInSeconds: 60,
    });
    const assertion = expect(p).rejects.toMatchObject({ code: 'access_denied' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('expires when the deadline passes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'authorization_pending' })));
    const p = pollForToken('http://engine', 'harnext-cli', 'dc', {
      intervalSeconds: 1,
      expiresInSeconds: 0, // already past the deadline on the first check
    });
    const assertion = expect(p).rejects.toBeInstanceOf(CloudAuthError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});

describe('refreshTokens', () => {
  it('rotates and returns a fresh pair', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'at2',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt2',
        scope: 'agent',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await refreshTokens('http://engine', 'harnext-cli', 'rt1');
    expect(res.refresh_token).toBe('rt2');
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toContain('grant_type=refresh_token');
  });

  it('throws invalid_grant on a revoked token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: 'invalid_grant' })));
    await expect(refreshTokens('http://engine', 'harnext-cli', 'old')).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });
});
