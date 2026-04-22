import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';
import { DEFAULT_MAX_LINES, formatSize } from './truncate.js';

const readSchema = Type.Object({
  path: Type.String({ description: 'File path to read (relative or absolute)' }),
  offset: Type.Optional(
    Type.Number({ description: 'Start reading from this line number (1-based)', default: 1 }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum number of lines to return (default: ${DEFAULT_MAX_LINES})`,
      default: DEFAULT_MAX_LINES,
    }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  path: string;
  totalLines: number;
  shownLines: number;
  bytes: number;
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema, ReadToolDetails> {
  return {
    name: 'read',
    label: 'read',
    description:
      'Read file contents. Returns numbered lines for easy reference. Use offset and limit to read specific sections of large files.',
    parameters: readSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) {
          return {
            content: [{ type: 'text', text: `Error: ${params.path} is a directory, not a file.` }],
            details: { path: params.path, totalLines: 0, shownLines: 0, bytes: 0 },
          };
        }

        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const offset = Math.max(0, (params.offset ?? 1) - 1);
        const limit = params.limit ?? DEFAULT_MAX_LINES;
        const slice = lines.slice(offset, offset + limit);

        const numbered = slice
          .map((line, i) => `${(offset + i + 1).toString().padStart(4)}\t${line}`)
          .join('\n');

        const header =
          lines.length > offset + limit
            ? `(showing lines ${offset + 1}-${offset + limit} of ${lines.length}, ${formatSize(fileStat.size)})\n`
            : '';

        return {
          content: [{ type: 'text', text: header + numbered }],
          details: {
            path: params.path,
            totalLines: lines.length,
            shownLines: slice.length,
            bytes: fileStat.size,
          },
        };
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error reading ${params.path}: ${msg}` }],
          details: { path: params.path, totalLines: 0, shownLines: 0, bytes: 0 },
        };
      }
    },
  };
}

export const readTool = createReadTool(process.cwd());
