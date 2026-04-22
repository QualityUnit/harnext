import { readFile, writeFile } from 'node:fs/promises';

const REDACT_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
]);

function redactHeaders(headers) {
  if (!Array.isArray(headers)) return headers;
  return headers.map((h) => {
    if (!h || typeof h.name !== 'string') return h;
    if (REDACT_HEADERS.has(h.name.toLowerCase())) {
      return { name: h.name, value: '<redacted>' };
    }
    return h;
  });
}

export async function redactHarFile(path) {
  const raw = await readFile(path, 'utf8');
  const har = JSON.parse(raw);
  const entries = har?.log?.entries ?? [];
  for (const entry of entries) {
    if (entry.request) entry.request.headers = redactHeaders(entry.request.headers);
    if (entry.response) entry.response.headers = redactHeaders(entry.response.headers);
    if (entry.request?.cookies) entry.request.cookies = [];
    if (entry.response?.cookies) entry.response.cookies = [];
  }
  await writeFile(path, JSON.stringify(har));
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--har');
  if (idx === -1 || !args[idx + 1]) {
    console.error('usage: redact-har.mjs --har <path>');
    process.exit(2);
  }
  await redactHarFile(args[idx + 1]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
