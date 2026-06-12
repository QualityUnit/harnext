import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

const editSchema = Type.Object({
  path: Type.String({ description: 'File path to edit (relative or absolute)' }),
  old_string: Type.String({ description: 'The exact string to find and replace' }),
  new_string: Type.String({ description: 'The replacement string' }),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
  path: string;
}

export function createEditTool(cwd: string): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a file by replacing an exact string match. The old_string must appear exactly once in the file to avoid ambiguity.',
    parameters: editSchema,
    async execute(_toolCallId, params) {
      const filePath = resolve(cwd, params.path);
      try {
        const content = await readFile(filePath, 'utf-8');
        const occurrences = content.split(params.old_string).length - 1;

        if (occurrences === 0) {
          return {
            content: [{ type: 'text', text: `Error: old_string not found in ${params.path}` }],
            details: { path: params.path },
          };
        }
        if (occurrences > 1) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: old_string found ${occurrences} times in ${params.path}. Must be unique — provide more context.`,
              },
            ],
            details: { path: params.path },
          };
        }

        const updated = content.replace(params.old_string, params.new_string);
        await writeFile(filePath, updated, 'utf-8');
        return {
          content: [{ type: 'text', text: `Edited ${params.path}` }],
          details: { path: params.path },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error editing ${params.path}: ${msg}` }],
          details: { path: params.path },
        };
      }
    },
  };
}

export const editTool = createEditTool(process.cwd());
