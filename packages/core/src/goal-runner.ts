import type { AgentEvent } from '@earendil-works/pi-agent-core';

import type { AgentSession } from './agent-session.js';
import { createAgentSession } from './sdk.js';
import { createBashTool, createCodingTools, createReadTool } from './tools/index.js';
import type { GoalPhase, GoalPhaseModel, ResolvedGoalModels } from './goal-config.js';

export type GoalVerdict = 'approve' | 'revise';

export interface GoalIterationRecord {
  iteration: number;
  verdict: GoalVerdict;
  feedback: string;
}

export interface RunGoalOptions {
  goal: string;
  models: ResolvedGoalModels;
  cwd?: string;
  /** Max generator ↔ evaluator rounds before giving up (default 3). */
  maxIterations?: number;
  /** Called when a phase begins. Iteration is 0 for the (single) planner run. */
  onPhaseStart?: (phase: GoalPhase, iteration: number, model: GoalPhaseModel) => void;
  /** Raw agent events from the phase sessions, for rendering. */
  onEvent?: (phase: GoalPhase, event: AgentEvent) => void;
}

export interface RunGoalResult {
  /** True when the evaluator ended a round with VERDICT: APPROVE. */
  approved: boolean;
  /** Generator ↔ evaluator rounds actually run. */
  iterations: number;
  /** The planner's blueprint. */
  plan: string;
  /** Evaluator feedback per round, in order. */
  history: GoalIterationRecord[];
}

const PLANNER_SYSTEM_PROMPT = `You are the PLANNER in a planner → generator → evaluator coding workflow.

Turn the user's goal into a precise implementation blueprint that a separate, smaller coding model will execute. Explore the codebase with the read and bash tools as needed, but make NO changes — no file edits, no state-changing commands. Your output is a specification, not code.

Your final message must be the blueprint, containing:
1. Objective — one-paragraph restatement of the goal.
2. Relevant files — paths the generator must read or modify, and why.
3. Expected behavior — inputs, outputs, and edge cases to handle.
4. Constraints — style, naming, libraries, and patterns to follow (match the existing codebase).
5. Implementation steps — a numbered, file-by-file outline concrete enough to follow without further decisions.

Do not include full code listings; short illustrative snippets are fine.`;

const GENERATOR_SYSTEM_PROMPT = `You are the GENERATOR in a planner → generator → evaluator coding workflow.

You receive an implementation blueprint produced by a planner. Implement it exactly using your tools: read the files it references, make the edits, and verify your work where cheap to do so. Stay within the blueprint's scope — when it is ambiguous, choose the simplest interpretation consistent with the existing code. When you receive evaluator feedback, fix every item it raises.`;

const EVALUATOR_SYSTEM_PROMPT = `You are the EVALUATOR in a planner → generator → evaluator coding workflow.

A generator model has just modified the working tree to implement the blueprint you will be given. Review the actual changes — use bash (git status, git diff) and the read tool. Make no changes yourself.

Assess, against the blueprint:
- Specification compliance — every step implemented, nothing extra.
- Correctness — logic errors and unhandled edge cases the blueprint calls out.
- Integration — imports, types, and style consistent with the surrounding code.
- Safety — obvious security issues or destructive behavior.

End your final message with exactly one line:
VERDICT: APPROVE — the implementation satisfies the blueprint
VERDICT: REVISE — changes are needed

With REVISE, precede the verdict with a numbered list of specific, actionable fixes.`;

function lastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== 'assistant') continue;
    const content = msg.content as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }
  return '';
}

/** Last VERDICT line wins, so a quoted verdict earlier in the critique can't approve. */
export function parseGoalVerdict(text: string): GoalVerdict | undefined {
  const matches = [...text.matchAll(/VERDICT:\s*(APPROVE|REVISE)/gi)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return last[1].toUpperCase() === 'APPROVE' ? 'approve' : 'revise';
}

async function createPhaseSession(
  phase: GoalPhase,
  model: GoalPhaseModel,
  cwd: string,
  onEvent?: RunGoalOptions['onEvent'],
): Promise<AgentSession> {
  const systemPrompt =
    phase === 'planner'
      ? PLANNER_SYSTEM_PROMPT
      : phase === 'generator'
        ? GENERATOR_SYSTEM_PROMPT
        : EVALUATOR_SYSTEM_PROMPT;
  // Planner and evaluator only inspect; the generator gets the full toolbox.
  const tools =
    phase === 'generator'
      ? createCodingTools(cwd)
      : [createReadTool(cwd), createBashTool(cwd)];
  const { session } = await createAgentSession({
    provider: model.provider,
    modelId: model.modelId,
    cwd,
    systemPrompt,
    tools,
    skills: [],
    quiet: true,
    mcpDisabled: true,
  });
  if (onEvent) session.subscribe((event) => onEvent(phase, event));
  return session;
}

async function runPhase(session: AgentSession, prompt: string): Promise<string> {
  await session.prompt(prompt);
  const error = session.state.errorMessage;
  if (error) throw new Error(error);
  return lastAssistantText(session);
}

/**
 * Run a goal through the planner → generator → evaluator pattern: a strong
 * model writes a blueprint, a fast model implements it, and a strong model
 * reviews the working-tree changes, feeding its critique back to the
 * generator until it approves or `maxIterations` rounds are spent. Each
 * phase runs in its own session/context so the evaluator reviews with fresh
 * eyes instead of confirming its own reasoning.
 */
export async function runGoal(options: RunGoalOptions): Promise<RunGoalResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxIterations = options.maxIterations ?? 3;
  const { models, goal, onPhaseStart, onEvent } = options;

  // Phase 1: plan
  const planner = await createPhaseSession('planner', models.planner, cwd, onEvent);
  let plan: string;
  try {
    onPhaseStart?.('planner', 0, models.planner);
    plan = await runPhase(planner, `Goal:\n${goal}`);
  } finally {
    await planner.dispose();
  }
  if (!plan.trim()) {
    throw new Error('Planner produced no blueprint.');
  }

  // Phase 2/3 loop: the generator keeps its session (it knows the code it
  // wrote); the evaluator gets a fresh session every round.
  const generator = await createPhaseSession('generator', models.generator, cwd, onEvent);
  const history: GoalIterationRecord[] = [];
  let approved = false;
  let iteration = 0;
  let feedback = '';
  try {
    while (iteration < maxIterations) {
      iteration++;
      onPhaseStart?.('generator', iteration, models.generator);
      const generatorPrompt =
        iteration === 1
          ? `Implement the following blueprint.\n\nGoal:\n${goal}\n\nBlueprint:\n${plan}`
          : `The evaluator reviewed your changes and requires revisions. Address every item.\n\nEvaluator feedback:\n${feedback}`;
      await runPhase(generator, generatorPrompt);

      const evaluator = await createPhaseSession('evaluator', models.evaluator, cwd, onEvent);
      let verdictText: string;
      try {
        onPhaseStart?.('evaluator', iteration, models.evaluator);
        verdictText = await runPhase(
          evaluator,
          `Review the current working-tree changes against this blueprint.\n\nGoal:\n${goal}\n\nBlueprint:\n${plan}`,
        );
      } finally {
        await evaluator.dispose();
      }

      // A missing verdict counts as revise — never accept unreviewed work.
      const verdict = parseGoalVerdict(verdictText) ?? 'revise';
      history.push({ iteration, verdict, feedback: verdictText });
      if (verdict === 'approve') {
        approved = true;
        break;
      }
      feedback = verdictText;
    }
  } finally {
    await generator.dispose();
  }

  return { approved, iterations: iteration, plan, history };
}
