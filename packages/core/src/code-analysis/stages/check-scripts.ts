/**
 * Third phase of the code-analysis pipeline: materialize the shell
 * scripts every required check in the risk contract points at.
 *
 * Behavior:
 *   - Compute the union of `requiredChecks` across all tiers.
 *   - Diff against existing files in `.harnext/scripts/`.
 *   - If any are missing, invoke the agent with the missing list +
 *     pointers to tech-stack.json and contract.json; the agent writes
 *     the files directly to `.harnext/scripts/<slug>.sh`.
 *   - Verify each expected file exists and is non-empty; `chmod 0o755`
 *     on every script the contract references (both pre-existing and
 *     newly generated) so they're runnable out of the box.
 *   - Never overwrite an existing script. User edits survive re-runs.
 *
 * Soft-fail: files the agent failed to produce end up in `failed[]`;
 * the caller (orchestrator) reports them as warnings without aborting.
 */

import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';

import type { CodingAgentId } from '../../coding-agents.js';
import type { ExternalAgentSpawner } from '../../coding-agent-runner.js';
import { CODE_ANALYSIS_MAX_TURNS, runCodingAgent } from '../run-coding-agent.js';
import { loadPrompt, renderPrompt } from '../prompt-loader.js';
import {
  type CheckScriptEntry,
  ensureScriptsDir,
  partitionChecks,
} from '../schemas/check-scripts.js';
import type { RiskContract } from '../schemas/risk-contract.js';
import { unionRequiredChecks } from '../schemas/risk-contract.js';
import type { SessionDir } from '../session-dir.js';
import type { TechStack } from '../types.js';

export interface RunCheckScriptsStageOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  codingAgentModel?: string;
  session: SessionDir;
  techStack: TechStack;
  contract: RiskContract;
  spawner?: ExternalAgentSpawner;
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  onActivity?: (line: string) => void;
}

export interface RunCheckScriptsStageResult {
  /** Absolute paths of scripts that are present and executable after this run. */
  present: string[];
  /** Scripts the agent was asked to produce; only populated when the agent ran. */
  generated: string[];
  /** Scripts that already existed on disk and were left alone. */
  preserved: string[];
  /** Required checks whose script is still missing / empty after the agent run. */
  failed: CheckScriptEntry[];
  /** Populated on spawn failure. Parse errors land in `failed[]`, not here. */
  error?: string;
}

export async function runCheckScriptsStage(
  opts: RunCheckScriptsStageOptions,
): Promise<RunCheckScriptsStageResult> {
  ensureScriptsDir(opts.cwd);

  const required = unionRequiredChecks(opts.contract);
  const { existing, missing } = partitionChecks(opts.cwd, required);
  const outputs: string[] = [];

  // Idempotent short-circuit: every script already on disk, nothing to do.
  if (missing.length === 0) {
    const present = chmodAllExisting(existing);
    opts.session.appendManifest({ stage: 'check-scripts', outputs });
    return {
      present,
      generated: [],
      preserved: existing.map((e) => e.filePath),
      failed: [],
    };
  }

  // Materialize pointers into the session so the agent can read them.
  const techStackPath = opts.session.pathFor('check-scripts', 'tech-stack.json');
  const contractPath = opts.session.pathFor('check-scripts', 'contract.json');
  writeFileSync(techStackPath, JSON.stringify(opts.techStack, null, 2), 'utf-8');
  writeFileSync(contractPath, JSON.stringify(opts.contract, null, 2), 'utf-8');
  outputs.push(techStackPath, contractPath);

  const prompt = renderPrompt(loadPrompt('check-scripts'), {
    missingChecksJson: JSON.stringify(missing, null, 2),
    techStackPath,
    contractPath,
    scriptsDir: opts.cwd + '/.harnext/scripts',
    sessionDir: opts.session.root,
    cwd: opts.cwd,
  });

  const { error } = await runCodingAgent({
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
    opts.session.appendManifest({ stage: 'check-scripts', outputs });
    return {
      present: chmodAllExisting(existing),
      generated: [],
      preserved: existing.map((e) => e.filePath),
      failed: missing,
      error,
    };
  }

  // Verify what the agent produced.
  const generated: string[] = [];
  const failed: CheckScriptEntry[] = [];
  for (const entry of missing) {
    if (fileHasContent(entry.filePath)) {
      chmodRunnable(entry.filePath);
      generated.push(entry.filePath);
    } else {
      failed.push(entry);
    }
  }

  // chmod every pre-existing script too — they may have been authored
  // by a previous run before we enforced the mode, or by a user that
  // forgot to set the bit.
  const present = [...chmodAllExisting(existing), ...generated];

  opts.session.appendManifest({ stage: 'check-scripts', outputs });
  return {
    present,
    generated,
    preserved: existing.map((e) => e.filePath),
    failed,
  };
}

function fileHasContent(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

function chmodRunnable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch {
    // best effort — the file still exists, caller reports if anything
  }
}

function chmodAllExisting(entries: CheckScriptEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (existsSync(e.filePath)) {
      chmodRunnable(e.filePath);
      out.push(e.filePath);
    }
  }
  return out;
}
