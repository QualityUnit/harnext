/**
 * Top-level orchestrator for the code-analysis pipeline.
 *
 * Phases (in order; every stage soft-fails):
 *   1. tech-stack     — detect the repo's technology inventory
 *   2. risk-contract  — produce .harnext/contract.json from the stack
 *   3. check-scripts  — materialize .harnext/scripts/<check>.sh per tier
 *   4. project-skills — write project-specific Agent Skills
 *   5. stage-prompts  — tailor per-stage pipeline prompts
 *
 * `phase` option lets callers run a single sub-stage (or `'all'`, the
 * default). A single shared `SessionDir` threads across every stage so
 * later-stage agent runs can read earlier-stage outputs from absolute
 * paths without re-invoking anything.
 *
 * Soft-failure contract: every sub-stage is wrapped; on failure we
 * record the error, emit a `warn`/`error` event, and proceed with the
 * stage's documented fallback. The pipeline never throws, and every
 * return shape is fully populated.
 *
 * On successful completion the session dir is cleaned. On any
 * sub-stage error it's retained so the user can inspect intermediates.
 */

import type { StageEntry } from '../github-connection.js';
import type { RiskContract } from './schemas/risk-contract.js';
import { synthesizeMinimalTechStack } from './schemas/tech-stack.js';
import { createSessionDir } from './session-dir.js';
import { runCheckScriptsStage } from './stages/check-scripts.js';
import { installBundledSkills } from './stages/install-bundled-skills.js';
import {
  DEFAULT_GENERATED_SKILL_SLUGS,
  runProjectSkillsStage,
} from './stages/project-skills.js';
import { runRiskContractStage } from './stages/risk-contract.js';
import {
  applyGeneratedPrompts,
  runStagePromptsStage,
  type StagePromptSpec,
} from './stages/stage-prompts.js';
import { runTechStackStage } from './stages/tech-stack.js';
import type {
  AnalysisError,
  AnalysisEvent,
  AnalysisPhase,
  RunCodeAnalysisOptions,
  RunCodeAnalysisResult,
  TechStack,
} from './types.js';

const ORDER: Exclude<AnalysisPhase, 'all'>[] = [
  'tech-stack',
  'risk-contract',
  'check-scripts',
  'project-skills',
  'stage-prompts',
];

function shouldRun(
  phase: AnalysisPhase | undefined,
  stage: Exclude<AnalysisPhase, 'all'>,
): boolean {
  if (!phase || phase === 'all') return true;
  return phase === stage;
}

export async function runCodeAnalysisPipeline(
  opts: RunCodeAnalysisOptions,
): Promise<RunCodeAnalysisResult> {
  const session = createSessionDir(opts.cwd);
  const errors: AnalysisError[] = [];
  let hadError = false;

  const emit = (e: AnalysisEvent): void => {
    try {
      opts.onProgress?.(e);
    } catch {
      // subscribers never block the pipeline
    }
  };
  const softFail = (stage: AnalysisEvent['stage'], message: string): void => {
    hadError = true;
    errors.push({ stage, message });
    emit({ stage, status: 'error', detail: message });
  };

  // Hoist so `finally` can reference these even if we return early.
  let techStack: TechStack = opts.techStack ?? synthesizeMinimalTechStack(opts.cwd);
  let contract: RiskContract | null = null;
  let stages: StageEntry[] = opts.baselineStages;
  let skillsInstalled: string[] = [];
  let skillsGenerated: string[] = [];
  let scriptsGenerated: string[] = [];
  let scriptsPreserved: string[] = [];

  /**
   * Build a per-stage activity forwarder that tags each line with the
   * current stage id before emitting through `onProgress`. Stages pass
   * this into `runCodingAgent`, which fans out agent tool-use events
   * (harnext in-process) or stdout/stderr lines (external CLI).
   */
  const activityFor = (stage: AnalysisEvent['stage']) => (line: string) => {
    // Truncate so a rogue long line can't wreck terminal wrapping.
    const trimmed = line.length > 160 ? line.slice(0, 157) + '…' : line;
    emit({ stage, status: 'activity', detail: trimmed });
  };

  try {
    // --- tech-stack ----------------------------------------------------
    // Skip when the caller already has a TechStack (e.g. wizard "reuse").
    if (shouldRun(opts.phase, 'tech-stack') && !opts.techStack) {
      emit({ stage: 'tech-stack', status: 'start' });
      try {
        const result = await runTechStackStage({
          cwd: opts.cwd,
          codingAgent: opts.codingAgent,
          codingAgentModel: opts.codingAgentModel,
          session,
          spawner: opts.spawner,
          runHarnextAgent: opts.runHarnextAgent,
          onActivity: activityFor('tech-stack'),
        });
        if (result.techStack) {
          techStack = result.techStack;
          emit({ stage: 'tech-stack', status: 'ok' });
        } else {
          errors.push({
            stage: 'tech-stack',
            message: result.error ?? 'unknown failure',
          });
          hadError = true;
          emit({
            stage: 'tech-stack',
            status: 'warn',
            detail: result.error ?? 'using synthesized fallback',
          });
        }
      } catch (err) {
        softFail('tech-stack', err instanceof Error ? err.message : String(err));
      }
    }

    // --- risk-contract -------------------------------------------------
    if (shouldRun(opts.phase, 'risk-contract')) {
      emit({ stage: 'risk-contract', status: 'start' });
      try {
        const result = await runRiskContractStage({
          cwd: opts.cwd,
          codingAgent: opts.codingAgent,
          codingAgentModel: opts.codingAgentModel,
          session,
          techStack,
          spawner: opts.spawner,
          runHarnextAgent: opts.runHarnextAgent,
          onActivity: activityFor('risk-contract'),
        });
        contract = result.contract;
        if (result.usedFallback) {
          errors.push({
            stage: 'risk-contract',
            message: result.error ?? 'used fallback contract',
          });
          emit({
            stage: 'risk-contract',
            status: 'warn',
            detail: result.error ?? 'fell back to default contract',
          });
          hadError = true;
        } else {
          emit({ stage: 'risk-contract', status: 'ok' });
        }
      } catch (err) {
        softFail('risk-contract', err instanceof Error ? err.message : String(err));
      }
    }

    // --- check-scripts -------------------------------------------------
    // Only run when we have a contract to read the required checks from.
    // A pipeline invoked with `phase: 'check-scripts'` directly still
    // needs the contract — load it from disk as a last resort.
    if (shouldRun(opts.phase, 'check-scripts')) {
      emit({ stage: 'check-scripts', status: 'start' });
      try {
        let contractToUse = contract;
        if (!contractToUse) {
          const { loadRiskContract, defaultRiskContract } = await import(
            './schemas/risk-contract.js'
          );
          contractToUse = loadRiskContract(opts.cwd) ?? defaultRiskContract();
        }
        const result = await runCheckScriptsStage({
          cwd: opts.cwd,
          codingAgent: opts.codingAgent,
          codingAgentModel: opts.codingAgentModel,
          session,
          techStack,
          contract: contractToUse,
          spawner: opts.spawner,
          runHarnextAgent: opts.runHarnextAgent,
          onActivity: activityFor('check-scripts'),
        });
        scriptsGenerated = result.generated;
        scriptsPreserved = result.preserved;

        if (result.error) {
          errors.push({ stage: 'check-scripts', message: result.error });
          emit({ stage: 'check-scripts', status: 'warn', detail: result.error });
          hadError = true;
        } else if (result.failed.length > 0) {
          const detail = `agent did not produce: ${result.failed.map((f) => f.slug).join(', ')}`;
          errors.push({ stage: 'check-scripts', message: detail });
          emit({ stage: 'check-scripts', status: 'warn', detail });
          hadError = true;
        } else {
          emit({ stage: 'check-scripts', status: 'ok' });
        }
      } catch (err) {
        softFail('check-scripts', err instanceof Error ? err.message : String(err));
      }
    }

    // --- project-skills ------------------------------------------------
    if (shouldRun(opts.phase, 'project-skills')) {
      emit({ stage: 'project-skills', status: 'start' });
      try {
        const bundled = installBundledSkills(opts.cwd, opts.codingAgent);
        skillsInstalled = bundled.installed;
        if (bundled.error) {
          errors.push({ stage: 'project-skills', message: bundled.error });
          emit({ stage: 'project-skills', status: 'warn', detail: bundled.error });
          hadError = true;
        }

        const projSkills = await runProjectSkillsStage({
          cwd: opts.cwd,
          codingAgent: opts.codingAgent,
          codingAgentModel: opts.codingAgentModel,
          session,
          techStack,
          skillSlugs: DEFAULT_GENERATED_SKILL_SLUGS,
          spawner: opts.spawner,
          runHarnextAgent: opts.runHarnextAgent,
          onActivity: activityFor('project-skills'),
        });
        skillsGenerated = projSkills.generated;
        if (projSkills.error) {
          errors.push({ stage: 'project-skills', message: projSkills.error });
          emit({
            stage: 'project-skills',
            status: 'warn',
            detail: projSkills.error,
          });
          hadError = true;
        } else {
          emit({ stage: 'project-skills', status: 'ok' });
        }
      } catch (err) {
        softFail('project-skills', err instanceof Error ? err.message : String(err));
      }
    }

    // --- stage-prompts -------------------------------------------------
    if (shouldRun(opts.phase, 'stage-prompts')) {
      emit({ stage: 'stage-prompts', status: 'start' });
      try {
        const specs: StagePromptSpec[] = opts.baselineStages.map((s) => ({
          id: s.id,
          kind: s.kind === 'review-loop' ? 'review-loop' : 'normal',
        }));
        const stageResult = await runStagePromptsStage({
          cwd: opts.cwd,
          codingAgent: opts.codingAgent,
          codingAgentModel: opts.codingAgentModel,
          session,
          techStack,
          specs,
          spawner: opts.spawner,
          runHarnextAgent: opts.runHarnextAgent,
          onActivity: activityFor('stage-prompts'),
        });
        stages = applyGeneratedPrompts(opts.baselineStages, stageResult.prompts);
        if (stageResult.error) {
          errors.push({ stage: 'stage-prompts', message: stageResult.error });
          emit({
            stage: 'stage-prompts',
            status: 'warn',
            detail: stageResult.error,
          });
          hadError = true;
        } else {
          emit({ stage: 'stage-prompts', status: 'ok' });
        }
      } catch (err) {
        softFail('stage-prompts', err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    if (hadError) {
      session.retain(`pipeline completed with ${errors.length} soft error(s)`);
    } else {
      session.cleanup();
    }
  }

  return {
    techStack,
    contract,
    scriptsGenerated,
    scriptsPreserved,
    stages,
    skillsInstalled,
    skillsGenerated,
    sessionDir: hadError ? session.root : '',
    errors,
  };
}

export const ANALYSIS_PHASES: ReadonlyArray<Exclude<AnalysisPhase, 'all'>> = ORDER;