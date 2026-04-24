/**
 * Second phase of the code-analysis pipeline: generate a
 * {@link RiskContract} from the previously-detected TechStack.
 *
 * The agent reads the tech-stack JSON the tech-stack stage persisted to
 * the session scratch dir and writes a contract JSON the orchestrator
 * parses, validates, and persists to `<cwd>/.harnext/contract.json`.
 * On every re-run we overwrite cleanly (user decision — no merge, no
 * .bak backup; the agent is the source of truth for the policy).
 *
 * Soft-fail: on any failure the stage falls back to a minimal default
 * contract (`low: ['**']` → `CI Pipeline`) so downstream tooling always
 * has something to reference.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { CodingAgentId } from '../../coding-agents.js';
import type { ExternalAgentSpawner } from '../../coding-agent-runner.js';
import { CODE_ANALYSIS_MAX_TURNS, runCodingAgent } from '../run-coding-agent.js';
import { loadPrompt, renderPrompt } from '../prompt-loader.js';
import {
  coerceRiskContract,
  defaultRiskContract,
  saveRiskContract,
  type RiskContract,
} from '../schemas/risk-contract.js';
import type { SessionDir } from '../session-dir.js';
import type { TechStack } from '../types.js';

export interface RunRiskContractStageOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  codingAgentModel?: string;
  session: SessionDir;
  techStack: TechStack;
  spawner?: ExternalAgentSpawner;
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  onActivity?: (line: string) => void;
}

export interface RunRiskContractStageResult {
  contract: RiskContract | null;
  /** True when we fell back to `defaultRiskContract()` because the agent output was rejected. */
  usedFallback: boolean;
  /** Absolute path the agent was told to write to. */
  outputPath: string;
  /** Trailing assistant text captured from the agent. */
  agentOutput: string;
  /** Populated on spawn failure, missing file, parse error, or validation error. */
  error?: string;
}

/** Inline schema snippet we pass into the prompt's `{{schemaJson}}`. */
const SCHEMA_JSON = `{
  "version": "1",
  "riskTierRules": {
    "<tier>": ["<glob>", "..."]
  },
  "mergePolicy": {
    "<tier>": { "requiredChecks": ["<check-id>", "..."] }
  }
}`;

export async function runRiskContractStage(
  opts: RunRiskContractStageOptions,
): Promise<RunRiskContractStageResult> {
  // Materialize the tech-stack at a known path inside the session so the
  // agent can cat/read it. Other stages will reference the same file.
  const techStackPath = opts.session.pathFor('risk-contract', 'tech-stack.json');
  writeFileSync(techStackPath, JSON.stringify(opts.techStack, null, 2), 'utf-8');

  const outputPath = opts.session.pathFor('risk-contract', 'contract.json');
  const prompt = renderPrompt(loadPrompt('risk-contract'), {
    outputPath,
    techStackPath,
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
    return fallback(opts, outputPath, output, error);
  }

  if (!existsSync(outputPath)) {
    return fallback(opts, outputPath, output, `agent did not write ${outputPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputPath, 'utf-8'));
  } catch (err) {
    return fallback(
      opts,
      outputPath,
      output,
      `failed to parse ${outputPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { contract, reason } = coerceRiskContract(parsed);
  if (!contract) {
    return fallback(opts, outputPath, output, reason ?? 'contract failed validation');
  }

  // Overwrite cleanly every run — no merge, no .bak.
  saveRiskContract(opts.cwd, contract);
  opts.session.appendManifest({
    stage: 'risk-contract',
    outputs: [techStackPath, outputPath],
  });

  return {
    contract,
    usedFallback: false,
    outputPath,
    agentOutput: output,
  };
}

/**
 * Persist the default contract and return it as the stage result. Keeps
 * the `.harnext/contract.json` file present and well-formed even when
 * the agent produces garbage, so downstream consumers (including a human
 * opening the file) never see a missing or malformed file.
 */
function fallback(
  opts: RunRiskContractStageOptions,
  outputPath: string,
  agentOutput: string,
  error: string,
): RunRiskContractStageResult {
  const contract = defaultRiskContract();
  try {
    saveRiskContract(opts.cwd, contract);
  } catch {
    // best effort; we still return the contract in-memory
  }
  return {
    contract,
    usedFallback: true,
    outputPath,
    agentOutput,
    error,
  };
}
