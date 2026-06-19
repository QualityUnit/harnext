import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

import { VERSION } from '../config.js';
import { extractTitle, htmlToMarkdown } from './html-to-markdown.js';
import { assertHostAllowed, normalizeUrl, SsrfError } from './ssrf.js';
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from './truncate.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024; // 10 MB hard cap on the response body
const MAX_REDIRECTS = 10;

const USER_AGENT = `harnext/${VERSION} (+https://github.com/QualityUnit/harnext)`;

const webFetchSchema = Type.Object({
  url: Type.String({ description: 'The URL to fetch (http or https; http is upgraded to https).' }),
  prompt: Type.Optional(
    Type.String({
      description:
        'Optional: what to extract or look for in the page. Recorded with the result to focus your reading.',
    }),
  ),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
  url: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  bytes: number;
  truncated: boolean;
  title?: string;
  error?: string;
}

export interface CreateWebFetchToolOptions {
  /** Overall request timeout in milliseconds (default 30s). */
  timeoutMs?: number;
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
  /** Override DNS resolution used by the SSRF guard (for tests). */
  resolver?: (host: string) => Promise<string[]>;
}

interface FetchOutcome {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** Set when a cross-host redirect was encountered and not followed. */
  crossHostRedirect?: string;
}

export function createWebFetchTool(
  options: CreateWebFetchToolOptions = {},
): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const resolver = options.resolver;

  return {
    name: 'web_fetch',
    label: 'web_fetch',
    description:
      'Fetch a URL and return its readable content. HTML is converted to Markdown; other text is returned as-is. ' +
      'Enforces SSRF protections (private/internal hosts are refused, http is upgraded to https) and re-validates on ' +
      'redirects (same-host redirects are followed; cross-host redirects return the new URL for you to re-issue). ' +
      `Large pages are truncated to ${formatSize(DEFAULT_MAX_BYTES)}. Optionally pass a prompt describing what to look for.`,
    parameters: webFetchSchema,
    async execute(_toolCallId, params) {
      const { url: rawUrl, prompt } = params;
      let start: URL;
      try {
        start = normalizeUrl(rawUrl);
      } catch (err) {
        return errorResult(rawUrl, err);
      }

      let outcome: FetchOutcome;
      try {
        outcome = await fetchWithRedirects(start, { timeoutMs, doFetch, resolver });
      } catch (err) {
        return errorResult(rawUrl, err);
      }

      if (outcome.crossHostRedirect) {
        const text =
          `The URL redirected to a different host: ${outcome.crossHostRedirect}\n` +
          `Cross-host redirects are not followed automatically. Re-issue web_fetch with that URL if you want to follow it.`;
        return {
          content: [{ type: 'text', text }],
          details: {
            url: rawUrl,
            finalUrl: outcome.crossHostRedirect,
            status: outcome.status,
            bytes: 0,
            truncated: false,
          },
        };
      }

      if (outcome.status >= 400) {
        return {
          content: [
            { type: 'text', text: `HTTP ${outcome.status} fetching ${outcome.finalUrl}` },
          ],
          details: {
            url: rawUrl,
            finalUrl: outcome.finalUrl,
            status: outcome.status,
            contentType: outcome.contentType,
            bytes: outcome.body.length,
            truncated: false,
            error: `HTTP ${outcome.status}`,
          },
        };
      }

      const { text, title } = renderBody(outcome);
      const truncation = truncateTail(text);
      const header: string[] = [];
      if (prompt) header.push(`Requested: ${prompt}`);
      header.push(`URL: ${outcome.finalUrl}`);
      if (title) header.push(`Title: ${title}`);
      header.push(`Content-Type: ${outcome.contentType || 'unknown'}`);
      if (truncation.truncated) {
        header.push(
          `(truncated to last ${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(DEFAULT_MAX_BYTES)} cap)`,
        );
      }

      return {
        content: [{ type: 'text', text: `${header.join('\n')}\n\n${truncation.content}` }],
        details: {
          url: rawUrl,
          finalUrl: outcome.finalUrl,
          status: outcome.status,
          contentType: outcome.contentType,
          bytes: outcome.body.length,
          truncated: truncation.truncated,
          title,
        },
      };
    },
  };
}

/** Decide how to present the response body based on its content type. */
function renderBody(outcome: FetchOutcome): {
  text: string;
  title?: string;
  rendered: boolean;
} {
  const ct = outcome.contentType.toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  const isText =
    isHtml ||
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct === '';

  if (!isText) {
    return {
      text: `[non-text content: ${outcome.contentType || 'unknown'}, ${formatSize(outcome.body.length)}] — not rendered.`,
      rendered: false,
    };
  }

  const raw = outcome.body.toString('utf-8');
  if (isHtml) {
    return { text: htmlToMarkdown(raw), title: extractTitle(raw), rendered: true };
  }
  return { text: raw, rendered: false };
}

/**
 * Fetch a URL, following same-host redirects up to {@link MAX_REDIRECTS} hops and
 * re-validating the SSRF guard at every hop. A cross-host redirect stops the loop
 * and is reported back rather than followed.
 */
async function fetchWithRedirects(
  start: URL,
  opts: {
    timeoutMs: number;
    doFetch: typeof fetch;
    resolver?: (host: string) => Promise<string[]>;
  },
): Promise<FetchOutcome> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertHostAllowed(current, opts.resolver);

    const res = await opts.doFetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

    // Redirect status with a Location header → validate and decide.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        // No Location — treat as a terminal response.
        return finalize(res, current);
      }
      let next: URL;
      try {
        next = normalizeUrl(new URL(location, current).toString());
      } catch (err) {
        throw err instanceof SsrfError ? err : new SsrfError(`Invalid redirect target: ${location}`);
      }
      if (next.host !== current.host) {
        return {
          finalUrl: current.toString(),
          status: res.status,
          contentType: '',
          body: Buffer.alloc(0),
          crossHostRedirect: next.toString(),
        };
      }
      current = next;
      continue;
    }

    return finalize(res, current);
  }

  throw new SsrfError(`Too many redirects (>${MAX_REDIRECTS}) starting from ${start.toString()}`);
}

async function finalize(res: Response, current: URL): Promise<FetchOutcome> {
  const contentType = res.headers.get('content-type') ?? '';
  const body = await readCapped(res, MAX_FETCH_BYTES);
  return { finalUrl: current.toString(), status: res.status, contentType, body };
}

/** Read a response body up to a byte cap, stopping early once the cap is hit. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > cap ? buf.subarray(0, cap) : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  try {
    await reader.cancel();
  } catch {
    // best-effort: body may already be drained
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.length > cap ? buf.subarray(0, cap) : buf;
}

function errorResult(url: string, err: unknown): {
  content: { type: 'text'; text: string }[];
  details: WebFetchToolDetails;
} {
  const message = err instanceof Error ? err.message : String(err);
  const prefix = err instanceof SsrfError ? 'Blocked' : 'Error fetching';
  return {
    content: [{ type: 'text', text: `${prefix} ${url}: ${message}` }],
    details: { url, bytes: 0, truncated: false, error: message },
  };
}

export const webFetchTool = createWebFetchTool();
