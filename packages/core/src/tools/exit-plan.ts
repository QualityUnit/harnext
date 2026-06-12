import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

const exitPlanSchema = Type.Object({
  plan: Type.String({
    description:
      'The proposed implementation plan, in markdown. Concise but complete: ' +
      'what you intend to change and in what order.',
  }),
});

export type ExitPlanToolInput = Static<typeof exitPlanSchema>;

export interface ExitPlanToolDetails {
  plan: string;
}

/**
 * The model calls `exit_plan` (canonical `ExitPlanMode`) once it has finished
 * researching in plan mode and wants to start implementing. In an interactive
 * session the harness intercepts the call before it executes, shows the plan,
 * and asks the user to approve — approval switches the session out of plan mode
 * so subsequent edits run. Headless callers (no TTY) have nothing to prompt, so
 * the tool simply acknowledges and lets the agent continue.
 */
export function createExitPlanTool(): AgentTool<typeof exitPlanSchema, ExitPlanToolDetails> {
  return {
    name: 'exit_plan',
    label: 'exit_plan',
    description:
      'Present your implementation plan and request approval to start editing. ' +
      'Call this only after you have researched the task in plan mode and have a ' +
      'concrete plan. Do not edit or write files before the plan is approved.',
    parameters: exitPlanSchema,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: 'Plan recorded. Proceeding with implementation.' }],
        details: { plan: params.plan },
      };
    },
  };
}

export const exitPlanTool = createExitPlanTool();
