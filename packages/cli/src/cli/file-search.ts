import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { CompletionItem } from './input.js';

// Hard cap so a giant repo can't blow up memory or the ranking pass.
const MAX_ENTRIES = 5000;
// How long a cached path listing stays fresh before the next query reloads it.
const CACHE_TTL_MS = 10_000;
// Directories never walked into during the non-git fallback scan.
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

/**
 * List candidate paths (files **and** directories) under `cwd`, relative to it.
 * Directories carry a trailing `/` so the picker can mark them and so an
 * inserted `@dir/` naturally narrows to its children.
 *
 * Prefers `git ls-files` (tracked + untracked-but-not-ignored) so the listing
 * honours `.gitignore`; falls back to a bounded recursive walk for non-git
 * directories. Capped at MAX_ENTRIES.
 */
export function listRepoPaths(cwd: string): string[] {
  let files: string[];
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    files = out.split('\0').filter((p) => p.length > 0);
  } catch {
    files = walkDir(cwd, cwd, []);
  }

  // Derive directory entries from the file paths' prefixes. A Set dedupes the
  // many files that share a parent.
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/') + '/');
    }
  }

  const all = [...dirs, ...files];
  return all.length > MAX_ENTRIES ? all.slice(0, MAX_ENTRIES) : all;
}

// Bounded recursive walk used when `cwd` is not a git repo. Returns forward-
// slashed relative file paths; stops once MAX_ENTRIES files are collected.
function walkDir(root: string, dir: string, acc: string[]): string[] {
  if (acc.length >= MAX_ENTRIES) return acc;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_ENTRIES) break;
    if (entry.name.startsWith('.git') || IGNORED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(root, abs, acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, abs).split(sep).join('/'));
    }
  }
  return acc;
}

// Last path segment ("foo/bar/baz.ts" → "baz.ts", "foo/bar/" → "bar/").
function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Filter `entries` by a case-insensitive substring `query` and rank the hits:
 * basename-prefix match first, then basename-substring, then a match that only
 * appears in the directory portion — ties broken by shorter path. An empty
 * query returns the first `limit` entries unranked.
 */
export function rankPaths(entries: string[], query: string, limit = 8): CompletionItem[] {
  const q = query.toLowerCase();
  if (q.length === 0) {
    return entries.slice(0, limit).map(toItem);
  }

  const scored: { path: string; score: number }[] = [];
  for (const path of entries) {
    const lower = path.toLowerCase();
    const base = basename(lower);
    const baseIdx = base.indexOf(q);
    let score: number;
    if (baseIdx === 0) score = 0;
    else if (baseIdx > 0) score = 1;
    else if (lower.includes(q)) score = 2; // matched only in the directory part
    else continue;
    scored.push({ path, score });
  }

  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => toItem(s.path));
}

function toItem(path: string): CompletionItem {
  return { text: path, hint: path.endsWith('/') ? 'dir' : undefined };
}

/**
 * Build a synchronous path completer for `cwd` with a short-lived cache. Safe
 * to call from a keypress handler: any failure (e.g. listing error) resolves
 * to an empty list rather than throwing.
 */
export function createPathCompleter(cwd: string): (query: string) => CompletionItem[] {
  let cache: string[] | null = null;
  let loadedAt = 0;
  return (query: string): CompletionItem[] => {
    try {
      const now = Date.now();
      if (cache === null || now - loadedAt > CACHE_TTL_MS) {
        cache = listRepoPaths(cwd);
        loadedAt = now;
      }
      return rankPaths(cache, query);
    } catch {
      return [];
    }
  };
}
