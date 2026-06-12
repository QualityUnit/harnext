/**
 * The `memory` tool: the agent's affordance for managing its per-project
 * memory. Modeled on Anthropic's official memory tool — a small set of
 * filesystem commands (`view`, `create`, `str_replace`, `insert`, `delete`,
 * `rename`) confined to the project's memory directory.
 *
 * Every path is resolved relative to `getProjectMemoryDir(cwd)` and guarded
 * against traversal, so the model can never read or write outside that
 * directory. The tool creates the memory directory lazily on first write.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

import { getProjectMemoryDir } from '../config.js';

const memorySchema = Type.Object({
  command: Type.Union(
    [
      Type.Literal('view'),
      Type.Literal('create'),
      Type.Literal('str_replace'),
      Type.Literal('insert'),
      Type.Literal('delete'),
      Type.Literal('rename'),
    ],
    {
      description:
        'view: list the memory dir or read a file. create: write/overwrite a file. ' +
        'str_replace: replace a unique substring. insert: insert text at a line. ' +
        'delete: remove a file. rename: move a file.',
    },
  ),
  path: Type.Optional(
    Type.String({
      description:
        'Path relative to the memory directory (e.g. "MEMORY.md" or "preferences.md"). ' +
        'Omit for `view` to list the whole memory directory.',
    }),
  ),
  text: Type.Optional(
    Type.String({ description: 'Content for `create`, or the text to add for `insert`.' }),
  ),
  old_str: Type.Optional(
    Type.String({ description: 'For `str_replace`: the exact, unique substring to replace.' }),
  ),
  new_str: Type.Optional(
    Type.String({ description: 'For `str_replace`: the replacement text.' }),
  ),
  insert_line: Type.Optional(
    Type.Number({ description: 'For `insert`: the 1-based line number to insert after (0 = top).' }),
  ),
  new_path: Type.Optional(
    Type.String({ description: 'For `rename`: the destination path relative to the memory dir.' }),
  ),
});

export type MemoryToolInput = Static<typeof memorySchema>;

export interface MemoryToolDetails {
  command: string;
  path?: string;
  ok: boolean;
}

function ok(text: string, command: string, path?: string) {
  return { content: [{ type: 'text' as const, text }], details: { command, path, ok: true } };
}

function fail(text: string, command: string, path?: string) {
  return { content: [{ type: 'text' as const, text }], details: { command, path, ok: false } };
}

/**
 * Resolve a memory-relative path to an absolute one, rejecting anything that
 * escapes the memory root (via `..` or an absolute path elsewhere).
 */
function resolveInside(root: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return abs;
}

export function createMemoryTool(cwd: string): AgentTool<typeof memorySchema, MemoryToolDetails> {
  const root = getProjectMemoryDir(cwd);

  return {
    name: 'memory',
    label: 'memory',
    description:
      'Manage your persistent per-project memory (markdown files in the memory directory). ' +
      'Use it to record durable facts and read them back across sessions. Paths are relative ' +
      'to the memory directory; MEMORY.md is the index loaded into context each session.',
    parameters: memorySchema,
    async execute(_toolCallId, params) {
      const { command } = params;
      try {
        // `view` with no path lists the directory.
        if (command === 'view' && (!params.path || params.path.trim() === '')) {
          let entries: string[] = [];
          try {
            entries = await readdir(root);
          } catch {
            return ok('Memory is empty (no files yet).', command);
          }
          if (entries.length === 0) return ok('Memory is empty (no files yet).', command);
          const listing = entries.sort().join('\n');
          return ok(`Memory directory (${root}):\n${listing}`, command);
        }

        const rel = params.path?.trim();
        if (!rel) return fail(`Error: \`${command}\` requires a path.`, command);
        const abs = resolveInside(root, rel);
        if (!abs) return fail(`Error: path "${rel}" escapes the memory directory.`, command, rel);

        switch (command) {
          case 'view': {
            const info = await stat(abs).catch(() => undefined);
            if (!info) return fail(`Error: ${rel} does not exist.`, command, rel);
            if (info.isDirectory()) {
              const entries = (await readdir(abs)).sort();
              return ok(`${rel}/:\n${entries.join('\n')}`, command, rel);
            }
            const content = await readFile(abs, 'utf-8');
            const numbered = content
              .split('\n')
              .map((line, i) => `${(i + 1).toString().padStart(4)}\t${line}`)
              .join('\n');
            return ok(numbered, command, rel);
          }

          case 'create': {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, params.text ?? '', 'utf-8');
            return ok(`Saved memory ${rel}.`, command, rel);
          }

          case 'str_replace': {
            if (params.old_str === undefined)
              return fail('Error: str_replace requires old_str.', command, rel);
            const content = await readFile(abs, 'utf-8');
            const count = content.split(params.old_str).length - 1;
            if (count === 0) return fail(`Error: old_str not found in ${rel}.`, command, rel);
            if (count > 1)
              return fail(
                `Error: old_str found ${count} times in ${rel}. Must be unique — add context.`,
                command,
                rel,
              );
            await writeFile(abs, content.replace(params.old_str, params.new_str ?? ''), 'utf-8');
            return ok(`Updated ${rel}.`, command, rel);
          }

          case 'insert': {
            const content = await readFile(abs, 'utf-8');
            const lines = content.split('\n');
            const at = Math.max(0, Math.min(params.insert_line ?? lines.length, lines.length));
            lines.splice(at, 0, params.text ?? '');
            await writeFile(abs, lines.join('\n'), 'utf-8');
            return ok(`Inserted into ${rel} at line ${at}.`, command, rel);
          }

          case 'delete': {
            await rm(abs, { recursive: true, force: true });
            return ok(`Deleted ${rel}.`, command, rel);
          }

          case 'rename': {
            const destRel = params.new_path?.trim();
            if (!destRel) return fail('Error: rename requires new_path.', command, rel);
            const dest = resolveInside(root, destRel);
            if (!dest)
              return fail(`Error: new_path "${destRel}" escapes the memory directory.`, command, rel);
            await mkdir(dirname(dest), { recursive: true });
            await rename(abs, dest);
            return ok(`Renamed ${rel} → ${destRel}.`, command, rel);
          }

          default:
            return fail(`Error: unknown command "${command as string}".`, command, rel);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return fail(`Error (${command}): ${msg}`, command, params.path);
      }
    },
  };
}

export const memoryTool = createMemoryTool(process.cwd());
