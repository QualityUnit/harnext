import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatSize } from '@harnext/core';

// Preview caps for an injected file: at most this many leading lines, and at
// most this many bytes (whichever bites first). The agent is told to use the
// read tool for the full, current contents.
const PREVIEW_LINES = 50;
const PREVIEW_BYTES = 16 * 1024;
// Directory listings are capped so a huge folder can't flood the prompt.
const DIR_LISTING_CAP = 100;
// Bytes sniffed for a NUL when deciding whether a file is binary.
const BINARY_SNIFF_BYTES = 8000;

// A mention is `@<token>` where the `@` sits at start-of-input or right after
// whitespace (so `email@example.com` never matches) and the token runs until
// the next whitespace or `@`.
const AT_TOKEN = /(^|\s)@([^\s@]+)/g;

/**
 * Expand `@path` mentions in `input` into the payload sent to the agent. Each
 * resolvable mention appends a preview block inside a trailing
 * `<attached-files>` section; the raw `input` text is left untouched so the
 * terminal echo and the agent both still see what the user typed, followed by
 * the attachments.
 *
 * Files inject a numbered preview of their first lines plus their full path so
 * the agent can `read` the rest. Directories inject a listing. Unresolvable
 * tokens are skipped (left only in the raw text); if nothing resolves the
 * input is returned unchanged.
 */
export function expandAtMentions(input: string, cwd: string): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const token of collectTokens(input)) {
    if (seen.has(token)) continue;
    seen.add(token);
    const block = renderToken(token, cwd);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return input;
  return `${input}\n\n<attached-files>\n${blocks.join('\n')}\n</attached-files>`;
}

function collectTokens(input: string): string[] {
  const out: string[] = [];
  AT_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AT_TOKEN.exec(input)) !== null) out.push(m[2]);
  return out;
}

function renderToken(token: string, cwd: string): string | null {
  const clean = token.endsWith('/') ? token.slice(0, -1) : token;
  const abs = resolve(cwd, clean);
  let st: import('node:fs').Stats;
  try {
    st = statSync(abs);
  } catch {
    return null; // unresolvable → passthrough
  }
  if (st.isDirectory()) return renderDir(clean, abs);
  if (st.isFile()) return renderFile(clean, abs, st.size);
  return null;
}

function renderDir(rel: string, abs: string): string | null {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  const shown = names.slice(0, DIR_LISTING_CAP);
  const more = names.length > DIR_LISTING_CAP ? `\n… and ${names.length - DIR_LISTING_CAP} more` : '';
  return `<dir path="${rel}/">\n${shown.join('\n')}${more}\n</dir>`;
}

function renderFile(rel: string, abs: string, size: number): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (isBinary(buf)) {
    return `<file path="${rel}" note="binary file (${formatSize(size)}); use the read tool if you need it" />`;
  }
  const lines = buf.toString('utf-8').split('\n');
  let slice = lines.slice(0, PREVIEW_LINES);
  let numbered = numberLines(slice);
  // Trim from the end until the preview fits the byte cap (keep at least one).
  while (Buffer.byteLength(numbered, 'utf-8') > PREVIEW_BYTES && slice.length > 1) {
    slice = slice.slice(0, -1);
    numbered = numberLines(slice);
  }
  const truncated = slice.length < lines.length;
  const note = truncated
    ? `\n[preview: first ${slice.length} of ${lines.length} lines, ${formatSize(size)} — ` +
      `use the read tool on "${rel}" for the full, current contents]`
    : '';
  return `<file path="${rel}">\n${numbered}${note}\n</file>`;
}

// Mirrors the read tool's numbered-line format (1-based, 4-wide line numbers).
function numberLines(lines: string[]): string {
  return lines.map((line, i) => `${(i + 1).toString().padStart(4)}\t${line}`).join('\n');
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
