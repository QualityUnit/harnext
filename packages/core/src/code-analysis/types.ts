/**
 * Public types for the code-analysis pipeline.
 *
 * The pipeline runs during `harnext setup` (and any explicit re-analyze) to
 * survey the user's repository and produce the durable artifacts the
 * coding-agent pipeline relies on: a `TechStack` inventory, a `RiskContract`
 * (Phase 2), `.harnext/scripts/` check scripts (Phase 2), tailored stage
 * prompts, and project-specific skills.
 *
 * Phase 1 exposes `TechStack` and the pipeline's surface; later phases add
 * `RiskContract` and friends without changing this file's existing shapes.
 */

import type { StageEntry } from '../github-connection.js';
import type { CodingAgentId } from '../coding-agents.js';
import type { ExternalAgentSpawner } from '../coding-agent-runner.js';
import type { RiskContract } from './schemas/risk-contract.js';

/**
 * Technology inventory for a single package. For a single-package repo this
 * is only produced for the root (path `""`); for a monorepo we emit one per
 * workspace package *plus* the root entry so repo-wide concerns aren't lost.
 */
export interface PackageTech {
  /** Repo-relative path. `""` for the repo root. */
  path: string;
  /** Package name from package.json / pyproject.toml / Cargo.toml. null when absent. */
  name: string | null;
  /** e.g. "TypeScript", "Python", "Go". Free-form, agent picks. */
  language: string;
  /** e.g. "Next.js", "FastAPI". null when there's no dominant framework. */
  framework: string | null;
  /** "npm", "pnpm", "yarn", "bun", "pip", "poetry", "cargo", … */
  packageManager: string | null;
  /** Exact shell command to run this package's tests. null if unknown. */
  testCommand: string | null;
  /** Exact shell command to lint. null if unknown. */
  lintCommand: string | null;
  /** Exact shell command to build. null if unknown. */
  buildCommand: string | null;
  /** Exact shell command to typecheck. null if unknown. */
  typecheckCommand: string | null;
  /** True iff this package has a browser-facing UI worth screenshot-verifying. */
  hasUI: boolean;
  /** Free-form notes specific to this package. */
  notes: string;
}

/**
 * Full tech inventory for the repo. `root` is always present; `packages` is
 * populated when `isMonorepo` is true.
 */
export interface TechStack {
  version: '1';
  /** ISO 8601 timestamp the inventory was generated. */
  generatedAt: string;
  /** True when the repo has workspaces / Cargo workspace / equivalent. */
  isMonorepo: boolean;
  /** Repo-root inventory. Populated even for monorepos (covers repo-wide tooling). */
  root: PackageTech;
  /** Per-workspace inventory. Empty when `isMonorepo` is false. */
  packages: PackageTech[];
  /** "github-actions", "gitlab-ci", "circleci", null. Repo-wide. */
  ciProvider: string | null;
  /** Repo-wide conventions (naming, imports, error handling, …). */
  conventions: string[];
}

/**
 * One of the discrete phases the pipeline runs. `'all'` is the default and
 * runs every phase in order, stopping on the first hard error.
 */
export type AnalysisPhase =
  | 'tech-stack'
  | 'risk-contract'
  | 'check-scripts'
  | 'project-skills'
  | 'stage-prompts'
  | 'all';

/**
 * Progress event emitted by the orchestrator.
 *
 *   start    — the stage has begun its work (no detail)
 *   activity — a short live update while the underlying agent runs;
 *              `detail` is a human-readable line (tool name, stderr
 *              fragment, first line of an assistant turn). Multiple
 *              `activity` events fire between `start` and the
 *              terminal status.
 *   ok       — the stage finished successfully
 *   warn     — the stage fell back to defaults but the pipeline can
 *              continue; `detail` explains why
 *   error    — the stage threw hard; `detail` is the error message
 */
export interface AnalysisEvent {
  stage: Exclude<AnalysisPhase, 'all'>;
  status: 'start' | 'activity' | 'ok' | 'warn' | 'error';
  detail?: string;
}

export interface RunCodeAnalysisOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  /** Required for external agents (claude-code / codex); ignored for harnext. */
  codingAgentModel?: string;
  /** Stage defaults we tailor prompts against. The wizard passes DEFAULT_STAGES. */
  baselineStages: StageEntry[];
  /**
   * When provided, the tech-stack sub-stage is skipped and this value is
   * fed directly into downstream stages. Used when the wizard offers
   * "reuse existing analysis" so we don't re-invoke the agent just to
   * regenerate something we already have on disk.
   */
  techStack?: TechStack;
  /** Test hook for spawning external agents. */
  spawner?: ExternalAgentSpawner;
  /** Test hook for the in-process harnext path. */
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  /** Optional progress subscriber for CLI rendering. */
  onProgress?: (e: AnalysisEvent) => void;
  /** When omitted, defaults to `'all'`. */
  phase?: AnalysisPhase;
}

export interface AnalysisError {
  stage: Exclude<AnalysisPhase, 'all'>;
  message: string;
}

export interface RunCodeAnalysisResult {
  /** Always populated — pipeline synthesizes a minimal stack on failure. */
  techStack: TechStack;
  /**
   * Always populated when the `risk-contract` phase ran. Set to the
   * default contract on validation failure so downstream consumers
   * (including the check-scripts phase) can always inspect it. Null
   * when the phase was skipped (e.g. `phase: 'tech-stack'`).
   */
  contract: RiskContract | null;
  /** Newly generated check-script file paths. Empty when none were missing. */
  scriptsGenerated: string[];
  /** Check-script files that already existed and were preserved as-is. */
  scriptsPreserved: string[];
  /** Tailored stages when `stage-prompts` ran successfully; baseline otherwise. */
  stages: StageEntry[];
  /** Bundled skills that were newly copied (skipped ones are not listed). */
  skillsInstalled: string[];
  /** Project-specific skill slugs the agent produced successfully. */
  skillsGenerated: string[];
  /** Session scratch dir. Empty when cleanup ran; populated on retain. */
  sessionDir: string;
  /** Populated on any soft-failed sub-stage. Empty on full success. */
  errors: AnalysisError[];
}
