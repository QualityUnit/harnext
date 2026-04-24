/**
 * First phase of the code-analysis pipeline: ask the coding agent to
 * survey the repo and produce a {@link TechStack} inventory.
 *
 * Runtime shape mirrors the existing `runCodebaseProfiler` (tmp JSON
 * handshake, validate, clean up) but every piece that used to be inline
 * is now factored:
 *   - the prompt lives in `prompts/tech-stack.yaml`
 *   - the scratch dir is the shared session dir (kept across phases)
 *   - the output is the new `TechStack` shape (monorepo-aware)
 *
 * Soft-fail contract: on any failure the stage writes nothing, returns
 * the thrown reason as a string, and the orchestrator substitutes a
 * synthesized minimal stack so downstream phases still have something
 * to consume.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { CodingAgentId } from '../../coding-agents.js';
import type { ExternalAgentSpawner } from '../../coding-agent-runner.js';
import { CODE_ANALYSIS_MAX_TURNS, runCodingAgent } from '../run-coding-agent.js';
import { loadPrompt, renderPrompt } from '../prompt-loader.js';
import {
  coerceTechStack,
  saveTechStack,
} from '../schemas/tech-stack.js';
import type { SessionDir } from '../session-dir.js';
import type { TechStack } from '../types.js';

export interface RunTechStackStageOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  codingAgentModel?: string;
  session: SessionDir;
  spawner?: ExternalAgentSpawner;
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  onActivity?: (line: string) => void;
}

export interface RunTechStackStageResult {
  techStack: TechStack | null;
  /** Absolute path the agent was told to write to. */
  outputPath: string;
  /** Trailing assistant text captured from the agent. Empty when unavailable. */
  agentOutput: string;
  /** Populated on spawn failure, missing file, parse error, or validation error. */
  error?: string;
}

/** Inline schema snippet we pass into the prompt's `{{schemaJson}}`. */
const SCHEMA_JSON = `{
  "version": "1",
  "generatedAt": "<ISO 8601 timestamp>",
  "isMonorepo": true|false,
  "root": {
    "path": "",
    "name": "<package name or null>",
    "language": "<e.g. TypeScript, Python, Go>",
    "framework": "<e.g. Next.js, FastAPI> or null",
    "packageManager": "<npm|pnpm|yarn|bun|pip|poetry|cargo|...> or null",
    "testCommand": "<exact shell command or null>",
    "lintCommand": "<exact shell command or null>",
    "buildCommand": "<exact shell command or null>",
    "typecheckCommand": "<exact shell command or null>",
    "hasUI": true|false,
    "notes": "<free-form, 40-200 chars>"
  },
  "packages": [
    { "path": "<repo-relative dir>", ...same shape as root... }
  ],
  "ciProvider": "<github-actions|gitlab-ci|...> or null",
  "conventions": ["<short rule>", "..."]
}`;

export async function runTechStackStage(
  opts: RunTechStackStageOptions,
): Promise<RunTechStackStageResult> {
  const outputPath = opts.session.pathFor('tech-stack', 'tech-stack.json');
  const prompt = renderPrompt(loadPrompt('tech-stack'), {
    outputPath,
    sessionDir: opts.session.root,
    cwd: opts.cwd,
    schemaJson: SCHEMA_JSON,
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
    return { techStack: null, outputPath, agentOutput: output, error };
  }

  if (!existsSync(outputPath)) {
    return {
      techStack: null,
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
      techStack: null,
      outputPath,
      agentOutput: output,
      error: `failed to parse ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const techStack = coerceTechStack(parsed);
  if (!techStack) {
    return {
      techStack: null,
      outputPath,
      agentOutput: output,
      error: 'tech-stack JSON is missing required fields (need at least root.language)',
    };
  }

  // Persist the durable copy to `.harnext/tech-stack.json`. The session
  // copy survives until the pipeline's cleanup so later stages can diff
  // / reference it by absolute path.
  saveTechStack(opts.cwd, techStack);
  opts.session.appendManifest({ stage: 'tech-stack', outputs: [outputPath] });

  return { techStack, outputPath, agentOutput: output };
}
