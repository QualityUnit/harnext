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
import { runExternalCodingAgent, type ExternalAgentSpawner } from './coding-agent-runner.js';
import type { GithubConnectionConfig, StageEntry } from './github-connection.js';
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
  /** GHA trigger — `issues`, `pull_request`, or `both` (safe default). */
  triggerOn: 'issues' | 'pull_request' | 'both';
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

  const promptInput: StageWorkflowInput = {
    stage: toStageWorkflowStage(input.stage),
    repo: input.cfg.repo,
    nextLabel: input.nextLabel,
    awaitingLabel: input.awaitingLabel,
    needsJudgmentLabel: input.needsJudgmentLabel,
    triggerOn: input.triggerOn,
    codingAgent: input.cfg.codingAgent,
    codingAgentModel: input.cfg.codingAgentModel,
    workflowPath,
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
