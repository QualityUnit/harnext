import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF protection for the web tools, modeled on Claude Code's WebFetch safety:
 * restrict the scheme to http/https, upgrade http→https, and refuse any URL
 * whose host resolves to a private, loopback, link-local, or otherwise
 * internal address (including the cloud metadata IP 169.254.169.254). The
 * target is re-validated on every redirect hop by the fetch pipeline.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Parse a raw URL, enforce an http/https scheme, and upgrade http→https.
 * Throws {@link SsrfError} for unsupported schemes or unparseable input.
 */
export function normalizeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Invalid URL: ${raw}`);
  }
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }
  if (url.protocol !== 'https:') {
    throw new SsrfError(
      `Unsupported URL scheme "${url.protocol.replace(/:$/, '')}" — only http and https are allowed.`,
    );
  }
  return url;
}

/** Hostnames that are always internal regardless of DNS resolution. */
function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  // Reserved / internal TLDs that should never leave the machine.
  if (/\.(local|localhost|internal|intranet|home|lan|corp)$/.test(host)) return true;
  return false;
}

/** True for an IPv4 address string in a private / reserved / internal range. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

/** True for an IPv6 address string in a loopback / ULA / link-local / mapped range. */
export function isPrivateIPv6(ip: string): boolean {
  let addr = ip.toLowerCase();
  // Strip a zone id (e.g. fe80::1%eth0).
  const pct = addr.indexOf('%');
  if (pct !== -1) addr = addr.slice(0, pct);

  // IPv4-mapped / -compatible (::ffff:127.0.0.1, ::127.0.0.1) — judge the v4 part.
  const v4 = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return isPrivateIPv4(v4[1]);

  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fe80') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
  if (addr.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/** True if a literal IP address (v4 or v6) is private / internal. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate that a (already scheme-normalized) URL's host is safe to fetch:
 * reject internal hostnames outright, and resolve DNS names to confirm every
 * resolved address is public. Throws {@link SsrfError} on any violation.
 */
export async function assertHostAllowed(
  url: URL,
  resolver: (host: string) => Promise<string[]> = defaultResolver,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1]-style literals

  if (isBlockedHostname(host)) {
    throw new SsrfError(`Refusing to fetch internal host "${host}".`);
  }

  // Literal IP — no DNS needed.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfError(`Refusing to fetch private/internal address "${host}".`);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new SsrfError(
      `Could not resolve host "${host}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfError(`Host "${host}" did not resolve to any address.`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new SsrfError(`Host "${host}" resolves to a private/internal address (${addr}).`);
    }
  }
}

async function defaultResolver(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}
