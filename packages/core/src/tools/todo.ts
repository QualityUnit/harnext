import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

const todoItemSchema = Type.Object({
  text: Type.String({ description: 'Short imperative description of the step' }),
  status: Type.Union(
    [Type.Literal('pending'), Type.Literal('active'), Type.Literal('done')],
    { description: 'pending = not started, active = in progress, done = completed' },
  ),
});

const todoSchema = Type.Object({
  title: Type.Optional(
    Type.String({ description: 'Short label for the plan (e.g. "add openrouter provider")' }),
  ),
  items: Type.Array(todoItemSchema, {
    description: 'The full task list. Each call replaces the previous list entirely.',
  }),
});

export type TodoToolInput = Static<typeof todoSchema>;
export type TodoItem = TodoToolInput['items'][number];

export interface TodoToolDetails {
  title?: string;
  items: TodoItem[];
}

export function createTodoTool(): AgentTool<typeof todoSchema, TodoToolDetails> {
  return {
    name: 'todo',
    label: 'todo',
    description:
      'Set the visible task plan for a multi-step job. Pass the full list each call ' +
      '(it replaces the previous one); update statuses as steps start and finish.',
    parameters: todoSchema,
    async execute(_toolCallId, params) {
      const counts = { done: 0, active: 0, pending: 0 };
      for (const item of params.items) counts[item.status]++;
      return {
        content: [
          {
            type: 'text',
            text: `Plan updated: ${counts.done} done · ${counts.active} active · ${counts.pending} pending`,
          },
        ],
        details: { title: params.title, items: params.items },
      };
    },
  };
}

export const todoTool = createTodoTool();
