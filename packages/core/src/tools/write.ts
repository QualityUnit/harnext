import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

const writeSchema = Type.Object({
  path: Type.String({ description: 'File path to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  path: string;
  bytes: number;
}

export function createWriteTool(cwd: string): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: 'write',
    label: 'write',
    description:
      'Write content to a file. Creates parent directories if needed. Overwrites existing files.',
    parameters: writeSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, params.content, 'utf-8');
        const bytes = Buffer.byteLength(params.content, 'utf-8');
        return {
          content: [{ type: 'text', text: `Wrote ${bytes} bytes to ${params.path}` }],
          details: { path: params.path, bytes },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error writing ${params.path}: ${msg}` }],
          details: { path: params.path, bytes: 0 },
        };
      }
    },
  };
}

export const writeTool = createWriteTool(process.cwd());
