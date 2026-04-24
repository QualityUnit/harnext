/**
 * Generate tailored stage prompts from a TechStack.
 *
 * Phase 3 replacement for the legacy `generateStagePrompts` in
 * `packages/core/src/analysis/stage-prompts.ts`. Same tmp-JSON handshake
 * (agent writes a JSON map keyed by stage id → prompt to an absolute
 * path; we read, validate, merge onto the baseline) but now driven by
 * the bundled YAML prompt and consuming TechStack directly.
 *
 * Why one call for all stages? Because the agent can compose prompts
 * that reference each other (e.g. `verify` reuses the test command
 * mentioned in `plan`) and stays consistent in tone across the
 * pipeline. Splitting per-stage would force the user to wait N times
 * and risk tonal drift.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { CodingAgentId } from '../../coding-agents.js';
import type { ExternalAgentSpawner } from '../../coding-agent-runner.js';
import { CODE_ANALYSIS_MAX_TURNS, runCodingAgent } from '../run-coding-agent.js';
import type { StageEntry } from '../../github-connection.js';
import { loadPrompt, renderPrompt } from '../prompt-loader.js';
import type { SessionDir } from '../session-dir.js';
import type { TechStack } from '../types.js';

/** Shape of an individual stage we request prompts for. */
export interface StagePromptSpec {
  id: string;
  kind: 'normal' | 'review-loop';
}

/**
 * For a normal stage, `prompt` is set. For a review-loop stage, `review`
 * and `fix` are set and `prompt` is absent.
 */
export interface GeneratedStagePrompt {
  id: string;
  prompt?: string;
  review?: string;
  fix?: string;
}

export interface RunStagePromptsStageOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  codingAgentModel?: string;
  session: SessionDir;
  techStack: TechStack;
  specs: StagePromptSpec[];
  spawner?: ExternalAgentSpawner;
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  onActivity?: (line: string) => void;
}

export interface RunStagePromptsStageResult {
  /** Keyed by stage id. May be empty (or partial) when parsing fails. */
  prompts: Record<string, GeneratedStagePrompt>;
  outputPath: string;
  agentOutput: string;
  error?: string;
}

export async function runStagePromptsStage(
  opts: RunStagePromptsStageOptions,
): Promise<RunStagePromptsStageResult> {
  const outputPath = opts.session.pathFor('stage-prompts', 'stages.json');

  const stageLines = opts.specs
    .map((s) =>
      s.kind === 'review-loop'
        ? `  "${s.id}": { "review": "<prompt for reviewer agent>", "fix": "<prompt for fixer agent>" }`
        : `  "${s.id}": { "prompt": "<prompt text>" }`,
    )
    .join(',\n');

  const prompt = renderPrompt(loadPrompt('stage-prompts'), {
    outputPath,
    techStackJson: JSON.stringify(opts.techStack, null, 2),
    stageLines,
    sessionDir: opts.session.root,
    cwd: opts.cwd,
  });

  const { output, error } = await runCodingAgent({
    cwd: opts.cwd,
    codingAgent: opts.codingAgent,
    codingAgentModel: opts.codingAgentModel,
    prompt,
    maxTurns: CODE_ANALYSIS_MAX_TURNS,
    spawner: opts.spawner,
    runHarnextAgent: opts.runHarnextAgent,
    onActivity: opts.onActivity,
  });

  if (error) {
    return { prompts: {}, outputPath, agentOutput: output, error };
  }

  if (!existsSync(outputPath)) {
    return {
      prompts: {},
      outputPath,
      agentOutput: output,
      error: `agent did not write ${outputPath}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputPath, 'utf-8'));
  } catch (err) {
    return {
      prompts: {},
      outputPath,
      agentOutput: output,
      error: `failed to parse ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const prompts = coerceStagePrompts(parsed, opts.specs);
  opts.session.appendManifest({ stage: 'stage-prompts', outputs: [outputPath] });
  return { prompts, outputPath, agentOutput: output };
}

/**
 * Accept only the entries we asked for — the agent might emit extras and
 * we don't want to silently pollute the user's stage list. Entries with
 * the wrong shape for their kind are dropped with no error so the caller
 * can fall back to `baseline` for the missing slots.
 */
export function coerceStagePrompts(
  value: unknown,
  specs: StagePromptSpec[],
): Record<string, GeneratedStagePrompt> {
  if (!value || typeof value !== 'object') return {};
  const root = value as Record<string, unknown>;
  const out: Record<string, GeneratedStagePrompt> = {};

  for (const spec of specs) {
    const entry = root[spec.id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (spec.kind === 'normal') {
      if (typeof e.prompt === 'string' && e.prompt.trim().length > 0) {
        out[spec.id] = { id: spec.id, prompt: e.prompt };
      }
      continue;
    }

    if (
      typeof e.review === 'string' &&
      e.review.trim().length > 0 &&
      typeof e.fix === 'string' &&
      e.fix.trim().length > 0
    ) {
      out[spec.id] = { id: spec.id, review: e.review, fix: e.fix };
    }
  }

  return out;
}

/**
 * Apply generated prompts on top of a baseline stage list (typically
 * `DEFAULT_STAGES`). Stages we have tailored prompts for get updated in
 * place; others are left untouched so nothing accidentally regresses to
 * a blank prompt.
 */
export function applyGeneratedPrompts(
  baseline: StageEntry[],
  generated: Record<string, GeneratedStagePrompt>,
): StageEntry[] {
  return baseline.map((stage) => {
    const hit = generated[stage.id];
    if (!hit) return stage;
    if (stage.kind === 'review-loop') {
      if (!hit.review || !hit.fix) return stage;
      return {
        ...stage,
        review: { ...stage.review, prompt: hit.review },
        fix: { ...stage.fix, prompt: hit.fix },
      };
    }
    if (!hit.prompt) return stage;
    return { ...stage, prompt: hit.prompt };
  });
}
