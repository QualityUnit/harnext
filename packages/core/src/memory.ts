/**
 * Per-project agent memory, a simplified take on Claude Code's auto-memory.
 *
 * Memory lives in a machine-state directory scoped by the working directory
 * (`getProjectMemoryDir`), so a different project gets a different memory. Each
 * fact is one markdown file with frontmatter; `MEMORY.md` is a hand-maintained
 * index whose head is injected into the system prompt at session start. The
 * agent reads topic files and records/updates facts through the `memory` tool.
 *
 * This module owns the read side: loading the index and building the prompt
 * block. The write side is the `memory` tool (`tools/memory.ts`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProjectMemoryDir } from './config.js';

/** Index filename loaded into the prompt. */
export const MEMORY_INDEX_FILE = 'MEMORY.md';

/** How much of the index to inject — keep it small so memory stays cheap. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/** Absolute path to the project's MEMORY.md index. */
export function memoryIndexPath(cwd: string): string {
  return join(getProjectMemoryDir(cwd), MEMORY_INDEX_FILE);
}

/**
 * Keep the head of `text` within the line/byte caps. Unlike `truncateTail`
 * (which keeps the tail of command output), an index is most useful from the
 * top, so we keep the head and drop the overflow.
 */
export function truncateHead(
  text: string,
  maxLines = MEMORY_INDEX_MAX_LINES,
  maxBytes = MEMORY_INDEX_MAX_BYTES,
): { content: string; truncated: boolean } {
  const lines = text.split('\n');
  let kept = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  let content = kept.join('\n');
  let truncated = kept.length < lines.length;

  while (Buffer.byteLength(content, 'utf-8') > maxBytes && kept.length > 1) {
    kept = kept.slice(0, -1);
    content = kept.join('\n');
    truncated = true;
  }
  return { content, truncated };
}

/**
 * Read the project's `MEMORY.md` index, head-truncated to the caps. Returns an
 * empty string when no index exists yet or it is blank.
 */
export function loadMemoryIndex(cwd: string): string {
  const path = memoryIndexPath(cwd);
  try {
    if (!existsSync(path)) return '';
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length === 0) return '';
    const { content, truncated } = truncateHead(raw);
    return truncated
      ? `${content}\n\n_(index truncated — read individual memory files for the rest)_`
      : content;
  } catch {
    return '';
  }
}

/**
 * The memory protocol: tells the agent where memory lives, the one-fact-per-file
 * format, and how to keep the index. Embeds the current index (or a note that
 * memory is empty). Returned as a `\n\n`-prefixed block to append to the system
 * prompt, matching `loadProjectContext`.
 */
export function buildMemorySection(cwd: string): string {
  const dir = getProjectMemoryDir(cwd);
  const index = loadMemoryIndex(cwd);

  const protocol = `# Memory

You have a persistent, per-project memory at \`${dir}\`. It survives across
sessions for this working directory. Manage it with the \`memory\` tool — all
paths are relative to that directory.

When to record: durable facts that will help future sessions — the user's stable
preferences, project conventions and constraints not obvious from the code, and
guidance the user gives you on how to work. Do NOT record what the repo already
makes clear (code structure, git history, CLAUDE.md), transient task state, or
secrets.

Format: one fact per file, \`<short-kebab-slug>.md\`, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-slug>
description: <one-line summary used to judge relevance>
metadata:
  type: user | feedback | project | reference
---

<the fact. Link related memories with [[their-slug]].>
\`\`\`

\`MEMORY.md\` is the index loaded into context each session: one line per memory
(\`- [Title](slug.md) — hook\`), never the full content. After writing a memory
file, add or update its index line. Before saving, check for an existing file
covering the same fact and update it rather than duplicating; delete memories
that turn out to be wrong. Recalled memory reflects what was true when written —
if it names a file or flag, verify it still exists before relying on it.`;

  const body = index
    ? `Current memory index (\`${MEMORY_INDEX_FILE}\`):\n\n${index}`
    : `Memory is currently empty. Start it when you learn something durable about this project or the user.`;

  return `\n\n${protocol}\n\n${body}`;
}
