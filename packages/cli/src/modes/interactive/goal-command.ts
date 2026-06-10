import type { AgentEvent } from '@mariozechner/pi-agent-core';
import { runGoal } from '@harnext/core';
import type { GoalPhase, GoalPhaseModel, ResolvedGoalModels } from '@harnext/core';
import chalk from 'chalk';

import { createMarkdownStreamer } from './markdown-stream.js';
import * as render from './render.js';

const PHASE_LABELS: Record<GoalPhase, string> = {
  planner: 'Plan',
  generator: 'Generate',
  evaluator: 'Evaluate',
};

const MAX_ITERATIONS = 3;

function phaseBanner(phase: GoalPhase, iteration: number, model: GoalPhaseModel): string {
  const round = iteration > 0 ? chalk.dim(` round ${iteration}/${MAX_ITERATIONS}`) : '';
  return (
    '\n' +
    chalk.bold.magenta(`  ── ${PHASE_LABELS[phase]}`) +
    round +
    chalk.dim(`  ${model.provider}/${model.modelId}`)
  );
}

function extractAssistantText(message: { content: unknown }): string {
  const content = message.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

/**
 * Run /goal: planner → generator → evaluator over the user's goal, streaming
 * phase banners, assistant text, and tool blocks to stdout. Runs while the
 * textarea is paused, so plain console output is the rendering surface.
 */
export async function runGoalCommand(goal: string, models: ResolvedGoalModels): Promise<void> {
  console.log();
  console.log(render.userMessage(`/goal ${goal}`));

  const pendingTools = new Map<string, { args: Record<string, unknown>; startedAt: number }>();

  const onEvent = (_phase: GoalPhase, event: AgentEvent): void => {
    switch (event.type) {
      case 'message_end': {
        if (event.message.role !== 'assistant') break;
        const text = extractAssistantText(event.message);
        if (text.trim().length === 0) break;
        const md = createMarkdownStreamer();
        const styled = (md.feed(text) + md.flush()).replace(/\n+$/, '');
        console.log('\n' + styled);
        break;
      }
      case 'tool_execution_start':
        pendingTools.set(event.toolCallId, { args: event.args, startedAt: Date.now() });
        console.log('\n' + render.toolStart(event.toolName, event.args));
        break;
      case 'tool_execution_end': {
        const pending = pendingTools.get(event.toolCallId);
        pendingTools.delete(event.toolCallId);
        const resultText = event.result?.content?.[0]?.text ?? '';
        const body = render.toolEnd(event.toolName, pending?.args ?? {}, resultText, event.isError, {
          durationMs: pending ? Date.now() - pending.startedAt : undefined,
        });
        if (body.length > 0) console.log(body.replace(/\n+$/, ''));
        break;
      }
    }
  };

  try {
    const result = await runGoal({
      goal,
      models,
      cwd: process.cwd(),
      maxIterations: MAX_ITERATIONS,
      onPhaseStart: (phase, iteration, model) => {
        console.log(phaseBanner(phase, iteration, model));
      },
      onEvent,
    });
    console.log();
    if (result.approved) {
      console.log(
        chalk.green('  ✓ Evaluator approved') +
          chalk.dim(
            ` after ${result.iterations} round${result.iterations === 1 ? '' : 's'}`,
          ),
      );
    } else {
      console.log(
        chalk.yellow(
          `  ⚠ No approval after ${result.iterations} rounds — review the working tree manually.`,
        ),
      );
    }
  } catch (err) {
    console.log();
    console.log(
      chalk.red('  /goal failed: ') + (err instanceof Error ? err.message : String(err)),
    );
  }
  console.log();
}
