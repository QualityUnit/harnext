import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;

const webSearchSchema = Type.Object({
  query: Type.String({ description: 'The search query.' }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Only include results whose host matches one of these domains.',
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Exclude results whose host matches one of these domains.',
    }),
  ),
  count: Type.Optional(
    Type.Number({ description: `Number of results to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).` }),
  ),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolDetails {
  query: string;
  backend?: string;
  resultCount: number;
  error?: string;
}

export type SearchBackendKind = 'tavily' | 'searxng' | 'serper' | 'brave';

export interface SearchBackend {
  kind: SearchBackendKind;
  /** API key (tavily/serper/brave) or instance base URL (searxng). */
  credential: string;
}

/**
 * Pick a search backend from environment variables. harnext is provider-agnostic,
 * so rather than leaning on one model provider's hosted search we support several
 * pluggable backends, preferring the ones with the least setup. `HARNEXT_SEARCH_BACKEND`
 * forces a specific backend; otherwise the first configured one wins.
 */
export function selectBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend | undefined {
  const candidates: { kind: SearchBackendKind; credential: string | undefined }[] = [
    { kind: 'tavily', credential: env.TAVILY_API_KEY },
    { kind: 'searxng', credential: env.SEARXNG_URL ?? env.SEARXNG_INSTANCE_URL },
    { kind: 'serper', credential: env.SERPER_API_KEY },
    { kind: 'brave', credential: env.BRAVE_API_KEY ?? env.BRAVE_SEARCH_API_KEY },
  ];

  const forced = env.HARNEXT_SEARCH_BACKEND?.trim().toLowerCase();
  if (forced) {
    const match = candidates.find((c) => c.kind === forced);
    if (match?.credential) return { kind: match.kind, credential: match.credential };
    return undefined;
  }

  for (const c of candidates) {
    if (c.credential) return { kind: c.kind, credential: c.credential };
  }
  return undefined;
}

export const NO_BACKEND_MESSAGE =
  'No web search backend is configured. Set one of these environment variables and retry:\n' +
  '  - TAVILY_API_KEY    — Tavily (1,000 free searches/mo, no card; https://tavily.com)\n' +
  '  - SEARXNG_URL       — a SearXNG instance base URL (keyless, self-hostable)\n' +
  '  - SERPER_API_KEY    — Serper.dev (https://serper.dev)\n' +
  '  - BRAVE_API_KEY     — Brave Search API (https://brave.com/search/api)\n' +
  'Force a specific backend with HARNEXT_SEARCH_BACKEND=tavily|searxng|serper|brave.';

// ── Result parsing (pure; exported for tests) ────────────────────────

export function parseTavily(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? ''),
        url: String(o.url ?? ''),
        snippet: String(o.content ?? o.snippet ?? ''),
      };
    })
    .filter((r) => r.url);
}

export function parseSearxng(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? ''),
        url: String(o.url ?? ''),
        snippet: String(o.content ?? ''),
      };
    })
    .filter((r) => r.url);
}

export function parseSerper(json: unknown): SearchResult[] {
  const organic = (json as { organic?: unknown[] })?.organic;
  if (!Array.isArray(organic)) return [];
  return organic
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? ''),
        url: String(o.link ?? ''),
        snippet: String(o.snippet ?? ''),
      };
    })
    .filter((r) => r.url);
}

export function parseBrave(json: unknown): SearchResult[] {
  const results = (json as { web?: { results?: unknown[] } })?.web?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o.title ?? ''),
        url: String(o.url ?? ''),
        snippet: String(o.description ?? ''),
      };
    })
    .filter((r) => r.url);
}

// ── Domain filtering (pure; exported for tests) ──────────────────────

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\*?\.?/, '').replace(/\/+$/, '');
  return h === d || h.endsWith(`.${d}`);
}

export function filterByDomains(
  results: SearchResult[],
  allowed?: string[],
  blocked?: string[],
): SearchResult[] {
  return results.filter((r) => {
    let host: string;
    try {
      host = new URL(r.url).hostname;
    } catch {
      return false;
    }
    if (allowed && allowed.length > 0 && !allowed.some((d) => hostMatches(host, d))) return false;
    if (blocked && blocked.length > 0 && blocked.some((d) => hostMatches(host, d))) return false;
    return true;
  });
}

/** Format results as a compact, agent-readable text block. */
export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = [`Results for "${query}":`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || r.url}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

// ── Backend requests ─────────────────────────────────────────────────

async function runBackend(
  backend: SearchBackend,
  query: string,
  count: number,
  allowed: string[] | undefined,
  blocked: string[] | undefined,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  switch (backend.kind) {
    case 'tavily': {
      const res = await doFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${backend.credential}`,
        },
        body: JSON.stringify({
          api_key: backend.credential,
          query,
          max_results: count,
          include_domains: allowed,
          exclude_domains: blocked,
        }),
        signal,
      });
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${await safeText(res)}`);
      return parseTavily(await res.json());
    }
    case 'searxng': {
      const base = backend.credential.replace(/\/+$/, '');
      const u = new URL(`${base}/search`);
      u.searchParams.set('q', query);
      u.searchParams.set('format', 'json');
      const res = await doFetch(u.toString(), {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}: ${await safeText(res)}`);
      return parseSearxng(await res.json());
    }
    case 'serper': {
      const res = await doFetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': backend.credential },
        body: JSON.stringify({ q: query, num: count }),
        signal,
      });
      if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${await safeText(res)}`);
      return parseSerper(await res.json());
    }
    case 'brave': {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(count));
      const res = await doFetch(u.toString(), {
        headers: { Accept: 'application/json', 'X-Subscription-Token': backend.credential },
        signal,
      });
      if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${await safeText(res)}`);
      return parseBrave(await res.json());
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

export interface CreateWebSearchToolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createWebSearchTool(
  options: CreateWebSearchToolOptions = {},
): AgentTool<typeof webSearchSchema, WebSearchToolDetails> {
  const env = options.env ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'web_search',
    label: 'web_search',
    description:
      'Search the web and return a ranked list of {title, url, snippet} results. Supports allowed_domains / ' +
      'blocked_domains filtering. Requires a configured backend (Tavily, SearXNG, Serper, or Brave via env vars); ' +
      'if none is set, returns instructions for configuring one.',
    parameters: webSearchSchema,
    async execute(_toolCallId, params) {
      const query = params.query.trim();
      if (!query) {
        return {
          content: [{ type: 'text', text: 'Error: query must not be empty.' }],
          details: { query, resultCount: 0, error: 'empty query' },
        };
      }

      const backend = selectBackend(env);
      if (!backend) {
        return {
          content: [{ type: 'text', text: NO_BACKEND_MESSAGE }],
          details: { query, resultCount: 0, error: 'no backend configured' },
        };
      }

      const count = Math.min(MAX_COUNT, Math.max(1, params.count ?? DEFAULT_COUNT));
      let results: SearchResult[];
      try {
        results = await runBackend(
          backend,
          query,
          count,
          params.allowed_domains,
          params.blocked_domains,
          doFetch,
          timeoutMs,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Web search failed (${backend.kind}): ${message}` }],
          details: { query, backend: backend.kind, resultCount: 0, error: message },
        };
      }

      // Some backends honor include/exclude server-side; apply locally too so
      // filtering is uniform across backends.
      results = filterByDomains(results, params.allowed_domains, params.blocked_domains).slice(0, count);

      return {
        content: [{ type: 'text', text: formatResults(query, results) }],
        details: { query, backend: backend.kind, resultCount: results.length },
      };
    },
  };
}

export const webSearchTool = createWebSearchTool();
