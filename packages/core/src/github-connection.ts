import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { isCodingAgentId, type CodingAgentId } from './coding-agents.js';
import { getProjectStateDir } from './config.js';
import { HEARTBEAT_INTERVAL_PRESETS, type HeartbeatIntervalMinutes } from './heartbeat.js';

export const GITHUB_CONFIG_FILE = 'github.json';

/**
 * We reuse the heartbeat interval presets so the "poll every N minutes"
 * semantics (divides 60, or a whole-hour multiple that divides 24) stay
 * identical across the app and cron semantics remain predictable.
 */
export const GITHUB_POLL_INTERVAL_PRESETS = HEARTBEAT_INTERVAL_PRESETS;
export type GithubPollIntervalMinutes = HeartbeatIntervalMinutes;

export type GithubIssueFilter =
  | { kind: 'label'; label: string }
  | { kind: 'assignee'; assignee: string }
  | { kind: 'none' };

/**
 * What happens when the agent finishes a stage.
 * - `yolo`: poller removes the stage label, adds the next stage's label, and
 *   immediately chains into it within the same tick.
 * - `human-approval`: poller removes the stage label, adds an
 *   awaiting-approval label, and stops the chain. A human advances the
 *   workflow by adding the next stage label.
 */
export type StageMode = 'yolo' | 'human-approval';

/**
 * Where a stage executes. `local` runs through the cron-driven poller on the
 * user's machine; `github-actions` hands the stage off to a generated (or
 * user-connected) workflow file that owns the entire lifecycle — agent
 * invocation, label transition, PR handoff, needs-judgment on failure. The
 * poller skips GHA-marked stages entirely so there is exactly one writer per
 * label boundary.
 */
export type StageRunnerKind = 'local' | 'github-actions';

export interface LocalRunner {
  kind: 'local';
}

export interface GithubActionsRunner {
  kind: 'github-actions';
  /** Repo-relative path, e.g. '.github/workflows/harnext-triage.yml'. */
  workflowPath: string;
  /**
   * Provenance: `connected` = user pointed at an existing workflow;
   * `generated` = harnext's setup wizard asked the coding agent to write it.
   * Surfaces in the wizard's "regenerate" UI so users can see what harnext
   * authored vs. what they wrote themselves.
   */
  origin: 'connected' | 'generated';
}

export type StageRunner = LocalRunner | GithubActionsRunner;

/**
 * A plain single-run stage — the traditional shape. `kind` is optional so
 * configs written before the union existed (no `kind` field) round-trip as
 * normal stages without any migration step.
 */
export interface NormalStage {
  kind?: 'normal';
  /** Stable identifier, e.g. 'triage'. Used in logs and reorder UI. */
  id: string;
  /** Label string as it appears on GitHub, e.g. 'harnext:triage'. */
  label: string;
  /** Prompt sent to the agent when it runs this stage. */
  prompt: string;
  /** How to advance the workflow once the agent finishes. */
  mode: StageMode;
  /**
   * Where this stage runs. Absent = local (back-compat for every
   * github.json written before runner existed). Use `getStageRunner` to
   * read this safely.
   */
  runner?: StageRunner;
}

/**
 * A review ↔ fix loop. On entry the poller runs the `review` agent, parses
 * the latest PR review verdict, and — if `changes_requested` — runs `fix`
 * and loops. Terminates when the verdict is `approved` or `commented`, or
 * when `maxIterations` is exhausted (in which case the item is parked on
 * `needs-judgment`). All iteration state lives only within a single tick;
 * no per-iteration GitHub labels are created.
 */
export interface ReviewLoopStage {
  kind: 'review-loop';
  /** Stable identifier used in logs. */
  id: string;
  /** Entry label on GitHub, e.g. 'harnext:review-loop'. */
  label: string;
  /** Upper bound on review runs within one tick. */
  maxIterations: number;
  /** Prompt for the reviewer agent (runs first; produces the verdict). */
  review: { prompt: string };
  /** Prompt for the fixer agent (runs when the verdict is changes_requested). */
  fix: { prompt: string };
  /**
   * Handoff mode after a terminating verdict — yolo chains to the next
   * entry, human-approval parks on `awaiting-approval`.
   */
  onExit: StageMode;
  /**
   * Where the review↔fix loop runs. Absent = local. When `github-actions`,
   * the entire loop executes inside a single Actions run; see workflow
   * generator docs for the maxIterations caveat.
   */
  runner?: StageRunner;
}

/**
 * Resolve a stage's runner, defaulting to local when the field is absent so
 * existing configs (and stage definitions that omit `runner`) keep working
 * without migration.
 */
export function getStageRunner(stage: StageEntry): StageRunner {
  return stage.runner ?? { kind: 'local' };
}

export type StageEntry = NormalStage | ReviewLoopStage;

/**
 * Back-compat alias: existing call sites referring to `StageDefinition`
 * continue to work. New code should prefer `NormalStage` or `StageEntry`.
 */
export type StageDefinition = NormalStage;

export interface GithubConnectionConfig {
  /** GitHub repository in "owner/name" form. */
  repo: string;
  /** Polling interval in minutes. */
  pollIntervalMinutes: GithubPollIntervalMinutes;
  /** Optional filter used when selecting which issues the agent picks up. */
  filter: GithubIssueFilter;
  /**
   * Ordered list of workflow stages. The poller treats `stages[i+1]` as the
   * "next" stage for YOLO chaining, so order matters. Entries are a union of
   * `NormalStage` (the traditional single-run stage) and `ReviewLoopStage`
   * (a review ↔ fix loop with verdict-driven termination).
   */
  stages: StageEntry[];
  /**
   * Pointer for incremental polling (ISO 8601). First tick writes `now()`.
   * Advanced per-item even on agent failure so a broken issue does not block
   * the queue.
   */
  lastSeenUpdatedAt?: string;
  /**
   * Which coding agent runs the pipeline for this project. Defaults to
   * `harnext` for configs written before this field existed.
   */
  codingAgent: CodingAgentId;
  /**
   * Model id passed to the coding agent's CLI via its native model flag.
   * Only set when `codingAgent !== 'harnext'` — harnext resolves its model
   * from user-level preferences via the provider registry.
   */
  codingAgentModel?: string;
  /** Epoch ms when the config was last written. */
  updatedAt: number;
}

/** Label added by the poller when a human-approval stage finishes. */
export const AWAITING_APPROVAL_LABEL = 'harnext:awaiting-approval';
/** Label added by the poller when it cannot make progress on an item. */
export const NEEDS_JUDGMENT_LABEL = 'harnext:needs-judgment';

export const DEFAULT_STAGES: StageEntry[] = [
  {
    kind: 'normal',
    id: 'triage',
    label: 'harnext:triage',
    mode: 'yolo',
    prompt: [
      'Stage: triage.',
      '',
      'Read the issue title, body, and existing comments. Post a single',
      'triage comment with: (a) a 1-2 sentence restatement of the problem,',
      '(b) classification — severity (p0/p1/p2) and scope (small/medium/',
      'large), (c) whether the issue is ready to plan or blocked on missing',
      'information.',
      '',
      'Do not write code, do not open branches, do not modify files on disk.',
    ].join('\n'),
  },
  {
    kind: 'normal',
    id: 'plan',
    label: 'harnext:plan',
    mode: 'human-approval',
    prompt: [
      'Stage: plan.',
      '',
      'Produce an implementation plan for this issue as a single issue',
      'comment with these sections:',
      '',
      '  Summary — 2-3 sentences describing the change.',
      '  Files to change — bullet list of paths with rough line counts.',
      '  Approach — short numbered steps.',
      '  Risks — anything that could break or surprise a reviewer.',
      '  Test plan — how correctness will be verified.',
      '',
      'Do NOT write code. Do NOT open a branch. A human will review this',
      'plan and advance the workflow if they approve.',
    ].join('\n'),
  },
  {
    kind: 'normal',
    id: 'implement',
    label: 'harnext:implement',
    mode: 'human-approval',
    prompt: [
      'Stage: implement.',
      '',
      'Implement the most recent plan comment on this issue. Create a branch',
      'named issue/<number>-<short-slug>, make the code changes, commit with',
      'a clear message, and open a DRAFT pull request that includes',
      '"closes #<issue-number>" in the description.',
      '',
      'Do not merge. Do not mark the PR ready-for-review.',
    ].join('\n'),
  },
  {
    kind: 'normal',
    id: 'verify',
    label: 'harnext:verify',
    mode: 'yolo',
    prompt: [
      'Stage: verify.',
      '',
      "Check out the pull request branch. Run the project's tests, lint, and",
      'typecheck. Post a single PR comment with the command exit codes and a',
      'short excerpt of the failing output (if any). If a check fails and',
      'the fix is mechanical (formatting, import order, obvious typos),',
      'commit the fix to the same branch and push.',
    ].join('\n'),
  },
  {
    kind: 'review-loop',
    id: 'review',
    label: 'harnext:review',
    maxIterations: 3,
    review: {
      prompt: [
        'Stage: review (reviewer pass).',
        '',
        'Review this pull request as a senior engineer would. Focus on:',
        'correctness, edge cases, test coverage, error handling, and obvious',
        'security concerns. Post a single PR review with an explicit verdict:',
        'approve, request changes, or comment. Do not merge.',
        '',
        'If the PR is good as-is, approve it. If there are issues, request',
        'changes and list them as review comments on the relevant lines.',
      ].join('\n'),
    },
    fix: {
      prompt: [
        'Stage: review (fix pass).',
        '',
        'The most recent PR review requested changes. Read the review body and',
        'any line-level comments, then address each item: edit the code on the',
        'PR branch, commit with a clear message, and push. Do not open a new',
        'PR. Do not resolve review threads yourself — the reviewer will do',
        'that on the next pass.',
        '',
        'Keep the scope tight: only fix what the review asked for.',
      ].join('\n'),
    },
    onExit: 'human-approval',
  },
];

export function getGithubConfigPath(cwd: string): string {
  return join(getProjectStateDir(cwd), GITHUB_CONFIG_FILE);
}

/**
 * Validate a raw `runner` sub-object. Absent is allowed (caller treats it as
 * local). A present value must be one of the two discriminated shapes with
 * the right field types — anything else is rejected so a typo doesn't
 * silently resolve to local and mask the error.
 */
function isValidStageRunner(x: unknown): boolean {
  if (x === undefined) return true;
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (r.kind === 'local') return true;
  if (r.kind === 'github-actions') {
    return (
      typeof r.workflowPath === 'string' &&
      r.workflowPath.length > 0 &&
      (r.origin === 'connected' || r.origin === 'generated')
    );
  }
  return false;
}

function isValidNormalStageShape(x: Record<string, unknown>): boolean {
  return (
    typeof x.id === 'string' &&
    typeof x.label === 'string' &&
    typeof x.prompt === 'string' &&
    (x.mode === 'yolo' || x.mode === 'human-approval') &&
    isValidStageRunner(x.runner)
  );
}

function isValidReviewLoopStageShape(x: Record<string, unknown>): boolean {
  const review = x.review as Record<string, unknown> | undefined;
  const fix = x.fix as Record<string, unknown> | undefined;
  return (
    typeof x.id === 'string' &&
    typeof x.label === 'string' &&
    typeof x.maxIterations === 'number' &&
    x.maxIterations >= 1 &&
    (x.onExit === 'yolo' || x.onExit === 'human-approval') &&
    !!review &&
    typeof review.prompt === 'string' &&
    !!fix &&
    typeof fix.prompt === 'string' &&
    isValidStageRunner(x.runner)
  );
}

function isValidStageEntry(x: unknown): x is StageEntry {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  // `kind` absent or 'normal' → validate as a NormalStage (back-compat for
  // pre-union configs). 'review-loop' → validate the loop shape. Any other
  // explicit kind is rejected.
  if (s.kind === 'review-loop') return isValidReviewLoopStageShape(s);
  if (s.kind === undefined || s.kind === 'normal') return isValidNormalStageShape(s);
  return false;
}

/**
 * Normalize a validated stage entry before handing it to callers — fills in
 * `kind: 'normal'` on pre-union configs so downstream code can always rely on
 * the discriminator being present.
 */
function normalizeStageEntry(s: StageEntry): StageEntry {
  if (s.kind === 'review-loop') return s;
  return { ...s, kind: 'normal' };
}

export function loadGithubConnection(cwd: string): GithubConnectionConfig | null {
  const path = getGithubConfigPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GithubConnectionConfig>;
    if (
      typeof parsed.repo !== 'string' ||
      typeof parsed.pollIntervalMinutes !== 'number' ||
      !parsed.filter ||
      typeof parsed.filter.kind !== 'string'
    ) {
      return null;
    }

    // Backfill: configs written before the stages field existed default to
    // DEFAULT_STAGES so existing setups keep working without manual editing.
    // Also normalizes each entry so the `kind` discriminator is always set.
    const stages =
      Array.isArray(parsed.stages) && parsed.stages.every(isValidStageEntry)
        ? (parsed.stages as StageEntry[]).map(normalizeStageEntry)
        : DEFAULT_STAGES;

    const codingAgent: CodingAgentId = isCodingAgentId(parsed.codingAgent)
      ? parsed.codingAgent
      : 'harnext';
    const codingAgentModel =
      codingAgent !== 'harnext' && typeof parsed.codingAgentModel === 'string'
        ? parsed.codingAgentModel
        : undefined;

    return {
      repo: parsed.repo,
      pollIntervalMinutes: parsed.pollIntervalMinutes as GithubPollIntervalMinutes,
      filter: parsed.filter as GithubIssueFilter,
      stages,
      lastSeenUpdatedAt: typeof parsed.lastSeenUpdatedAt === 'string'
        ? parsed.lastSeenUpdatedAt
        : undefined,
      codingAgent,
      codingAgentModel,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveGithubConnection(cwd: string, cfg: GithubConnectionConfig): void {
  const path = getGithubConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

export function deleteGithubConnection(cwd: string): boolean {
  const path = getGithubConfigPath(cwd);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── gh CLI wrappers ─────────────────────────────────────────────────

export interface GhCommandError {
  ok: false;
  /** Captured stderr from gh (trimmed). */
  message: string;
  /** Non-zero exit status from gh. */
  exitCode: number;
}

export interface GhCommandOk<T> {
  ok: true;
  value: T;
}

export type GhResult<T> = GhCommandOk<T> | GhCommandError;

export function runGh(args: string[], cwd?: string): GhResult<string> {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, value: stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '';
    const message = stderr.trim() || e.message || 'gh command failed';
    return { ok: false, message, exitCode: e.status ?? 1 };
  }
}

export interface GhAuthStatus {
  username: string;
  host: string;
}

/**
 * Verify that gh is installed and authenticated. We parse `gh auth status`
 * output rather than `gh api user` so we pick up whatever identity gh itself
 * is using (including enterprise hosts and token env vars).
 */
export function verifyGhAuth(): GhResult<GhAuthStatus> {
  const versionCheck = runGh(['--version']);
  if (!versionCheck.ok) {
    return { ok: false, message: 'gh CLI is not installed or not on PATH', exitCode: 127 };
  }

  const result = runGh(['auth', 'status']);
  if (!result.ok) {
    return result;
  }

  const output = result.value;
  const userMatch = output.match(/account\s+([^\s]+)/i) ?? output.match(/as\s+([^\s]+)/);
  const hostMatch = output.match(/([\w.-]+)\s+account/) ?? output.match(/Logged in to\s+(\S+)/i);
  return {
    ok: true,
    value: {
      username: userMatch?.[1] ?? 'unknown',
      host: hostMatch?.[1] ?? 'github.com',
    },
  };
}

/** Read the repo's "owner/name" from the given directory via `gh repo view`. */
export function getRepoFromCwd(cwd: string): GhResult<string> {
  const result = runGh(['repo', 'view', '--json', 'nameWithOwner'], cwd);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.value) as { nameWithOwner?: string };
    if (!parsed.nameWithOwner) {
      return { ok: false, message: 'gh repo view returned no nameWithOwner', exitCode: 1 };
    }
    return { ok: true, value: parsed.nameWithOwner };
  } catch (err) {
    return {
      ok: false,
      message: `could not parse gh repo view output: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

export interface GhLabel {
  name: string;
  description: string;
}

export function listRepoLabels(repo: string): GhResult<GhLabel[]> {
  const result = runGh([
    'label',
    'list',
    '--repo',
    repo,
    '--limit',
    '200',
    '--json',
    'name,description',
  ]);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.value) as GhLabel[];
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      message: `could not parse gh label list output: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

/** Default color + description for every harnext-managed label. */
export interface HarnextLabelSpec {
  name: string;
  color: string;
  description: string;
}

const LABEL_DESCRIPTION = 'Managed by harnext — controls the issue/PR pipeline.';

/**
 * Build the set of labels harnext needs on the repo for a given stage list.
 * Ordering mirrors the pipeline: stage labels, then the shared control labels.
 */
export function buildHarnextLabelSpecs(stages: StageEntry[]): HarnextLabelSpec[] {
  // Distinct-ish colors per stage position so the timeline is readable at a glance.
  const palette = ['0e8a16', '0366d6', 'a2eeef', 'd4c5f9', 'fbca04', 'c5def5', '7057ff'];
  const specs: HarnextLabelSpec[] = stages.map((stage, idx) => ({
    name: stage.label,
    color: palette[idx % palette.length],
    description: LABEL_DESCRIPTION,
  }));
  specs.push({ name: AWAITING_APPROVAL_LABEL, color: 'fbca04', description: LABEL_DESCRIPTION });
  specs.push({ name: NEEDS_JUDGMENT_LABEL, color: 'd93f0b', description: LABEL_DESCRIPTION });
  return specs;
}

export interface EnsureLabelsResult {
  created: string[];
  existed: string[];
  failed: Array<{ name: string; message: string }>;
}

/**
 * Ensure every label in `specs` exists on `repo`. Idempotent: lists existing
 * labels once and only calls `gh label create` for the missing ones. Name
 * comparison is case-insensitive because GitHub treats labels that way.
 */
export function ensureRepoLabels(repo: string, specs: HarnextLabelSpec[]): EnsureLabelsResult {
  const result: EnsureLabelsResult = { created: [], existed: [], failed: [] };

  const listResult = listRepoLabels(repo);
  if (!listResult.ok) {
    // Couldn't list — try creating each and let `gh` report "already exists".
    for (const spec of specs) {
      const created = createLabel(repo, spec);
      if (created.ok) result.created.push(spec.name);
      else if (/already exists/i.test(created.message)) result.existed.push(spec.name);
      else result.failed.push({ name: spec.name, message: created.message });
    }
    return result;
  }

  const existing = new Set(listResult.value.map((l) => l.name.toLowerCase()));
  for (const spec of specs) {
    if (existing.has(spec.name.toLowerCase())) {
      result.existed.push(spec.name);
      continue;
    }
    const created = createLabel(repo, spec);
    if (created.ok) result.created.push(spec.name);
    else if (/already exists/i.test(created.message)) result.existed.push(spec.name);
    else result.failed.push({ name: spec.name, message: created.message });
  }
  return result;
}

function createLabel(repo: string, spec: HarnextLabelSpec): GhResult<null> {
  const result = runGh([
    'label',
    'create',
    spec.name,
    '--repo',
    repo,
    '--color',
    spec.color,
    '--description',
    spec.description,
  ]);
  if (!result.ok) return { ok: false, message: result.message, exitCode: result.exitCode };
  return { ok: true, value: null };
}

/**
 * List users that can be assigned issues on this repo. Uses the REST
 * assignees endpoint (returns collaborators with triage+ access).
 */
export function listRepoAssignableUsers(repo: string): GhResult<string[]> {
  const result = runGh(['api', `repos/${repo}/assignees`, '--paginate', '--jq', '.[].login']);
  if (!result.ok) return result;
  const users = result.value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { ok: true, value: users };
}
