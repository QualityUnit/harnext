/**
 * Ask the configured coding agent to write a GitHub Actions workflow for a
 * single harnext stage. The generator picks a {@link WorkflowPromptBundle}
 * based on the connection's codingAgent, dispatches the agent (in-process
 * for `harnext`, external CLI for `claude-code` / `codex`), and reports
 * whether the expected file now exists on disk.
 *
 * The generator never commits, pushes, or touches anything beyond the
 * workflow file — the setup wizard owns preview + keep/discard and the
 * user is responsible for the git step.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { getCodingAgentSpec } from './coding-agents.js';
import { CODE_ANALYSIS_MAX_TURNS } from './code-analysis/run-coding-agent.js';
import { runExternalCodingAgent, type ExternalAgentSpawner } from './coding-agent-runner.js';
import { getStageRunner, type GithubConnectionConfig, type StageEntry } from './github-connection.js';
import { defaultRunnerLabels } from './self-hosted-runner.js';
import { createAgentSession } from './sdk.js';
import { toStageWorkflowStage, WORKFLOW_PROMPT_BUNDLES } from './workflow-prompts.js';
import type { StageWorkflowInput } from './workflow-prompts.js';

export interface GenerateStageWorkflowInput {
  /**
   * Project root (NOT a worktree). The agent runs here so it can read
   * repo context and write under `.github/workflows/`. The wizard resolves
   * the absolute workflow path from this cwd + `relativeWorkflowPath`.
   */
  cwd: string;
  stage: StageEntry;
  cfg: GithubConnectionConfig;
  /** Repo-relative target path, e.g. '.github/workflows/harnext-triage.yml'. */
  relativeWorkflowPath: string;
  /** Label the workflow must apply on success; undefined for terminal stages. */
  nextLabel?: string;
  /** Label applied when a human-approval stage finishes. */
  awaitingLabel: string;
  /** Label applied on agent failure. */
  needsJudgmentLabel: string;
  /**
   * Basename (e.g. `harnext-plan.yml`) of the next stage's workflow to
   * dispatch via `gh workflow run` after this stage adds the next-stage
   * label. Required for any yolo chain between two GHA-backed stages —
   * without it, the label-add does not fire the next workflow's
   * `labeled` trigger (GitHub suppresses those when `GITHUB_TOKEN`
   * applied the label). See StageWorkflowInput.nextWorkflowFilename
   * for the full rationale.
   */
  nextWorkflowFilename?: string;
  /** GHA trigger spec. See `StageWorkflowInput.triggerOn`. */
  triggerOn: 'issues' | 'pull_request' | 'both' | 'pr-merged';
  /**
   * For review-loop stages, indicates which workflow file is being
   * generated. The wizard generates two workflows per review-loop stage
   * (review entry + fix companion). Must be set when `stage.kind ===
   * 'review-loop'`; ignored otherwise.
   */
  phase?: 'review' | 'fix';
  /**
   * Filename (basename) of the companion workflow in a review-loop pair.
   * Required when `phase` is set:
   *  - phase='review' → companion is the fix workflow this review
   *    workflow dispatches when the verdict is changes_requested.
   *  - phase='fix'    → companion is the review workflow this fix
   *    workflow dispatches after pushing fixup commits.
   */
  companionWorkflowFilename?: string;
  /** Override for tests — skips the real `claude`/`codex` subprocess. */
  spawner?: ExternalAgentSpawner;
  /**
   * Test-only escape hatch for the harnext in-process path. When provided,
   * the generator calls this instead of `createAgentSession` so unit tests
   * don't need a real provider key. The runner is expected to run the
   * prompt and return the assistant's textual output.
   */
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
}

export interface GenerateStageWorkflowResult {
  /** Absolute path where the workflow file was expected to land. */
  workflowPath: string;
  /** Trailing assistant text from the agent run (useful for wizard display). */
  agentOutput: string;
  /** True iff the expected file exists after the agent run. */
  wroteFile: boolean;
  /** The exact prompt the generator sent — surfaced for logging. */
  promptSent: string;
  /** Populated only when `wroteFile` is true — the file contents for preview. */
  workflowContent?: string;
  /** Any error message from the agent run (timeout, bad exit, spawn failure). */
  error?: string;
}

export async function generateStageWorkflow(
  input: GenerateStageWorkflowInput,
): Promise<GenerateStageWorkflowResult> {
  const workflowPath = isAbsolute(input.relativeWorkflowPath)
    ? input.relativeWorkflowPath
    : join(input.cwd, input.relativeWorkflowPath);

  const bundle = WORKFLOW_PROMPT_BUNDLES[input.cfg.codingAgent];
  if (!bundle) {
    throw new Error(
      `no workflow prompt bundle registered for coding agent "${input.cfg.codingAgent}"`,
    );
  }

  const runner = getStageRunner(input.stage);
  const runsOnYaml =
    runner.runsOn === 'self-hosted'
      ? `[${defaultRunnerLabels(input.cwd).map((l) => `'${l}'`).join(', ')}]`
      : 'ubuntu-latest';
  const promptInput: StageWorkflowInput = {
    stage: toStageWorkflowStage(input.stage),
    repo: input.cfg.repo,
    nextLabel: input.nextLabel,
    awaitingLabel: input.awaitingLabel,
    needsJudgmentLabel: input.needsJudgmentLabel,
    nextWorkflowFilename: input.nextWorkflowFilename,
    triggerOn: input.triggerOn,
    codingAgent: input.cfg.codingAgent,
    codingAgentModel: input.cfg.codingAgentModel,
    workflowPath,
    runsOnYaml,
    phase: input.phase,
    companionWorkflowFilename: input.companionWorkflowFilename,
  };
  const promptSent = bundle.buildGeneratorPrompt(promptInput);

  let agentOutput = '';
  let error: string | undefined;

  if (input.cfg.codingAgent === 'harnext') {
    if (input.runHarnextAgent) {
      try {
        agentOutput = await input.runHarnextAgent(promptSent, input.cwd);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    } else {
      try {
        const { session } = await createAgentSession({ cwd: input.cwd, quiet: true });
        // `session.prompt` doesn't return the assistant text directly; we
        // subscribe to capture the last assistant message_end. Keeping this
        // inline avoids a dependency on the poller's event plumbing.
        let lastText = '';
        const unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const content = event.message.content;
            if (typeof content === 'string') {
              lastText = content;
              return;
            }
            if (Array.isArray(content)) {
              lastText = content
                .map((c) =>
                  c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string'
                    ? (c as { text: string }).text
                    : '',
                )
                .filter(Boolean)
                .join('');
            }
          }
        });
        try {
          await session.prompt(promptSent);
        } finally {
          unsubscribe();
        }
        agentOutput = lastText;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
  } else {
    const spec = getCodingAgentSpec(input.cfg.codingAgent);
    if (!input.cfg.codingAgentModel) {
      error = `coding agent "${spec.id}" requires codingAgentModel in config`;
    } else {
      const result = await runExternalCodingAgent(spec, promptSent, {
        cwd: input.cwd,
        modelId: input.cfg.codingAgentModel,
        maxTurns: CODE_ANALYSIS_MAX_TURNS,
        spawner: input.spawner,
      });
      agentOutput = result.output;
      if (result.exit !== 0) error = result.error ?? `agent exited ${result.exit}`;
    }
  }

  const wroteFile = existsSync(workflowPath);
  let workflowContent: string | undefined;
  if (wroteFile) {
    try {
      workflowContent = readFileSync(workflowPath, 'utf-8');
    } catch (err) {
      // File vanished between stat and read — rare but possible. Treat as not-written.
      return {
        workflowPath,
        agentOutput,
        wroteFile: false,
        promptSent,
        error:
          error ?? (err instanceof Error ? err.message : 'failed to read generated workflow'),
      };
    }
  }

  return { workflowPath, agentOutput, wroteFile, promptSent, workflowContent, error };
}

/**
 * Derive the fix workflow path from a review workflow path. Convention:
 * `<dir>/<basename-without-ext>-fix.<ext>`. Used by the wizard so the
 * pair is always named consistently and tests can predict the fix path
 * without a second user prompt.
 */
export function deriveFixWorkflowPath(reviewWorkflowPath: string): string {
  const dotIdx = reviewWorkflowPath.lastIndexOf('.');
  if (dotIdx < 0) return `${reviewWorkflowPath}-fix`;
  const base = reviewWorkflowPath.slice(0, dotIdx);
  const ext = reviewWorkflowPath.slice(dotIdx);
  return `${base}-fix${ext}`;
}
