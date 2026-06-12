/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) client for the context engine.
 *
 * The CLI is a public client: it asks for a device + user code, shows the user
 * the verification URL, and polls the token endpoint until they approve it in
 * the dashboard. Endpoints + payload shapes mirror the engine's ingest API:
 *   POST /oauth/device/code   → { device_code, user_code, verification_uri, ... }
 *   POST /oauth/token         → { access_token, refresh_token, expires_in, ... }
 *                               or RFC error bodies { error: "authorization_pending" | ... }
 */

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_CLIENT_ID = 'harnext-cli';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export class CloudAuthError extends Error {
  constructor(
    message: string,
    /** The OAuth `error` code when the server returned one (e.g. `access_denied`). */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CloudAuthError';
  }
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

async function postForm(
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal,
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON response — leave body empty
  }
  return { status: res.status, body };
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new CloudAuthError('aborted', 'aborted'));
      },
      { once: true },
    );
  });

/**
 * Discover the public client id this engine expects (from `/health`). Falls back
 * to the well-known default when the field is absent or the probe fails.
 */
export async function discoverClientId(endpoint: string): Promise<string> {
  try {
    const res = await fetch(`${trimEndpoint(endpoint)}/health`);
    if (res.ok) {
      const body = (await res.json()) as { agent_oauth?: { client_id?: string } };
      const id = body.agent_oauth?.client_id;
      if (typeof id === 'string' && id) return id;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_CLIENT_ID;
}

export async function requestDeviceCode(
  endpoint: string,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const { status, body } = await postForm(`${trimEndpoint(endpoint)}/oauth/device/code`, {
    client_id: clientId,
  });
  if (status !== 200) {
    throw new CloudAuthError(
      `device code request failed (${status}: ${String(body.error ?? 'unknown')})`,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return body as unknown as DeviceCodeResponse;
}

export interface PollOptions {
  /** Seconds between polls (RFC 8628 `interval`); grows on `slow_down`. */
  intervalSeconds: number;
  /** Seconds until the device code expires (RFC 8628 `expires_in`). */
  expiresInSeconds: number;
  signal?: AbortSignal;
  /** Called before each poll attempt (for a spinner / status line). */
  onPoll?: () => void;
}

/**
 * Poll the token endpoint until the user approves (→ TokenResponse), denies, or
 * the code expires (→ CloudAuthError). Honours `authorization_pending` and
 * `slow_down` per RFC 8628.
 */
export async function pollForToken(
  endpoint: string,
  clientId: string,
  deviceCode: string,
  opts: PollOptions,
): Promise<TokenResponse> {
  const url = `${trimEndpoint(endpoint)}/oauth/token`;
  let interval = Math.max(1, opts.intervalSeconds);
  const deadline = Date.now() + opts.expiresInSeconds * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new CloudAuthError('device code expired before approval', 'expired_token');
    }
    await sleep(interval * 1000, opts.signal);
    opts.onPoll?.();

    const { status, body } = await postForm(
      url,
      { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId },
      opts.signal,
    );
    if (status === 200) return body as unknown as TokenResponse;

    const error = typeof body.error === 'string' ? body.error : 'invalid_grant';
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    // access_denied | expired_token | anything else → terminal
    throw new CloudAuthError(`authorization failed: ${error}`, error);
  }
}

/** Exchange a refresh token for a fresh access+refresh pair (rotation). */
export async function refreshTokens(
  endpoint: string,
  clientId: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const { status, body } = await postForm(
    `${trimEndpoint(endpoint)}/oauth/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    },
    signal,
  );
  if (status !== 200) {
    throw new CloudAuthError(
      `token refresh failed (${String(body.error ?? status)})`,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return body as unknown as TokenResponse;
}
