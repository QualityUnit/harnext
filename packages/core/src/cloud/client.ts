/**
 * Authenticated client for the context engine's store-only ingest API. Holds an
 * access+refresh token pair, transparently refreshing (and rotating) the access
 * token before it expires or on a 401, and exposes the open → append → finalize
 * lifecycle the uploader drives.
 */

import { refreshTokens, CloudAuthError } from './device-auth.js';
import { saveCloudTokens, type CloudTokens } from './tokens.js';

/** Refresh this many ms before the access token's stated expiry. */
const EXPIRY_SKEW_MS = 60_000;
/** Per-request ceiling so a hanging/black-holing server can't stall a call forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface CloudIngestClientOptions {
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /**
   * External abort signal. When it fires, every in-flight request is cancelled
   * immediately — the uploader uses this to guarantee nothing lingers at exit.
   */
  signal?: AbortSignal;
}

export interface AgentSessionMeta {
  client_session_id: string;
  harness: string;
  model?: string;
  cwd?: string;
  title?: string;
}

export interface AgentEventInput {
  seq: number;
  type: string;
  payload: unknown;
}

export interface OpenSessionResult {
  id: string;
  status: string;
}

export interface AppendResult {
  session_id: string;
  accepted: number;
  duplicates: number;
  max_seq: number | null;
}

export interface FinalizeInput {
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export class CloudIngestClient {
  private tokens: CloudTokens;
  private readonly persist: (tokens: CloudTokens) => void;
  private readonly timeoutMs: number;
  private readonly externalSignal?: AbortSignal;

  constructor(
    tokens: CloudTokens,
    persist: (tokens: CloudTokens) => void = saveCloudTokens,
    options: CloudIngestClientOptions = {},
  ) {
    this.tokens = tokens;
    this.persist = persist;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.externalSignal = options.signal;
  }

  get endpoint(): string {
    return trimEndpoint(this.tokens.endpoint);
  }

  /** A signal that aborts on either the external cancel or the per-request timeout. */
  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return this.externalSignal ? AbortSignal.any([this.externalSignal, timeout]) : timeout;
  }

  /** Ensure a non-expired access token, refreshing+rotating if needed. */
  private async ensureAccessToken(): Promise<string> {
    if (Date.now() < this.tokens.accessExpiresAt - EXPIRY_SKEW_MS) {
      return this.tokens.accessToken;
    }
    await this.rotate();
    return this.tokens.accessToken;
  }

  private async rotate(): Promise<void> {
    const fresh = await refreshTokens(
      this.tokens.endpoint,
      this.tokens.clientId,
      this.tokens.refreshToken,
      this.requestSignal(),
    );
    this.tokens = {
      ...this.tokens,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      accessExpiresAt: Date.now() + fresh.expires_in * 1000,
    };
    this.persist(this.tokens);
  }

  private async request<T>(path: string, body: unknown, retryOn401 = true): Promise<T> {
    const token = await this.ensureAccessToken();
    const res = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: this.requestSignal(),
    });
    if (res.status === 401 && retryOn401) {
      // Access token rejected (e.g. secret rotated mid-flight) — rotate once and retry.
      await this.rotate();
      return this.request<T>(path, body, false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CloudAuthError(`ingest ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  openSession(meta: AgentSessionMeta): Promise<OpenSessionResult> {
    return this.request<OpenSessionResult>('/agent/sessions', meta);
  }

  appendEvents(sessionId: string, events: AgentEventInput[]): Promise<AppendResult> {
    return this.request<AppendResult>(`/agent/sessions/${sessionId}/events`, { events });
  }

  finalize(sessionId: string, input: FinalizeInput): Promise<OpenSessionResult> {
    return this.request<OpenSessionResult>(`/agent/sessions/${sessionId}/finalize`, input);
  }
}
