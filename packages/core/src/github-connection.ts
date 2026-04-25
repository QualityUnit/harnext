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
 * Where a workflow's job is scheduled.
 *  - `github-hosted`: runs on a fresh ubuntu-latest VM provisioned by GitHub.
 *  - `self-hosted`:   runs on a self-hosted runner the user has registered
 *    against this repo. Workflows target it via a project-scoped label
 *    (`harnext-<projectHash>`) so cross-project runners can never poach
 *    each other's jobs.
 */
export type RunsOn = 'github-hosted' | 'self-hosted';

/**
 * A stage runner — every stage is backed by a GitHub Actions workflow
 * file. The only thing that varies is whether the workflow targets a
 * GitHub-hosted runner or a self-hosted one on the user's PC.
 */
export interface StageRunner {
  /** Repo-relative path, e.g. '.github/workflows/harnext-triage.yml'. */
  workflowPath: string;
  /**
   * Provenance: `connected` = user pointed at an existing workflow;
   * `generated` = harnext's setup wizard asked the coding agent to write it.
   * Surfaces in the wizard's "regenerate" UI so users can see what harnext
   * authored vs. what they wrote themselves.
   */
  origin: 'connected' | 'generated';
  /** Where the workflow's job actually runs. */
  runsOn: RunsOn;
}

/**
 * A plain single-run stage — the traditional shape. `kind` is optional so
 * configs written before the union existed (no `kind` field) round-trip as
 * normal stages without any migration step.
 */
/**
 * Trigger event for a `NormalStage`'s workflow.
 *  - `labeled` (default): the workflow fires on `issues.labeled` /
 *    `pull_request.labeled` matching the stage's label, plus
 *    `workflow_dispatch` for chained re-entry. This is how the standard
 *    triage → plan → implement → review → verify cascade works.
 *  - `pr-merged`: the workflow fires on `pull_request.closed` filtered by
 *    `merged == true`. Used for post-merge stages like doc-gardening
 *    that have no place in the labeled cascade — they are terminal and
 *    don't transition labels or dispatch a next stage.
 */
export type StageTrigger = 'labeled' | 'pr-merged';

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
   * The workflow file + runner-target for this stage. Required in current
   * configs; legacy configs that omit it (or carry the historical
   * `{ kind: 'local' }` shape) are migrated at load time — see
   * `migrateLegacyStageRunner`.
   */
  runner?: StageRunner;
  /**
   * What event fires this stage's workflow. Absent = `'labeled'` (back-
   * compat for every config written before this field existed). Use
   * `getStageTrigger` to read this safely.
   */
  trigger?: StageTrigger;
}

/** Resolve a stage's trigger, defaulting to `'labeled'` for back-compat. */
export function getStageTrigger(stage: NormalStage | ReviewLoopStage): StageTrigger {
  if (stage.kind === 'review-loop') return 'labeled';
  return stage.trigger ?? 'labeled';
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
   * Workflow file + runner-target for the loop. Same migration story as
   * NormalStage.runner — required in current configs; legacy configs go
   * through `migrateLegacyStageRunner` at load time.
   */
  runner?: StageRunner;
}

/**
 * The default stage-runner shape used when migrating legacy configs that
 * carry `{ kind: 'local' }` or omit the runner entirely. Self-hosted is the
 * spiritual replacement for the old "local" runner — it still runs on the
 * user's machine, but via a registered actions/runner instead of cron. The
 * workflowPath is a placeholder so the wizard's first edit pass can
 * generate the file; runtime code paths should never see this value.
 */
export const LEGACY_RUNNER_FALLBACK: StageRunner = {
  workflowPath: '',
  origin: 'generated',
  runsOn: 'self-hosted',
};

/**
 * Default workflow path harnext writes for a stage when generating one
 * fresh — `.github/workflows/harnext-<id>.yml`. Exposed so the wizard and
 * setup callers stay in sync without duplicating the convention.
 */
export function defaultStageWorkflowPath(stageId: string): string {
  return `.github/workflows/harnext-${stageId}.yml`;
}

/**
 * Resolve a stage's runner. Required in current configs; legacy configs
 * (`{ kind: 'local' }`, or runner absent) fall back to a self-hosted
 * default with the conventional workflow path so callers don't have to
 * scatter migration code.
 */
export function getStageRunner(stage: StageEntry): StageRunner {
  if (stage.runner) return stage.runner;
  return { ...LEGACY_RUNNER_FALLBACK, workflowPath: defaultStageWorkflowPath(stage.id) };
}

/**
 * Migrate a legacy `runner` value into the new shape. Called from
 * `loadGithubConnection`. Returns `undefined` when the legacy value is
 * unrecoverable so the caller can refuse the load.
 */
export function migrateLegacyStageRunner(
  raw: unknown,
  stageId: string,
): StageRunner | undefined {
  if (raw === undefined) {
    return { ...LEGACY_RUNNER_FALLBACK, workflowPath: defaultStageWorkflowPath(stageId) };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.workflowPath === 'string' &&
    (r.origin === 'connected' || r.origin === 'generated') &&
    (r.runsOn === 'github-hosted' || r.runsOn === 'self-hosted')
  ) {
    return { workflowPath: r.workflowPath, origin: r.origin, runsOn: r.runsOn };
  }
  if (r.kind === 'local') {
    return { ...LEGACY_RUNNER_FALLBACK, workflowPath: defaultStageWorkflowPath(stageId) };
  }
  if (r.kind === 'github-actions') {
    if (typeof r.workflowPath !== 'string' || r.workflowPath.length === 0) return undefined;
    if (r.origin !== 'connected' && r.origin !== 'generated') return undefined;
    return {
      workflowPath: r.workflowPath,
      origin: r.origin,
      runsOn: 'github-hosted',
    };
  }
  return undefined;
}

export type StageEntry = NormalStage | ReviewLoopStage;

/**
 * Stage 0: the mandatory intake step. When a new issue arrives with no
 * harnext label, the generated `harnext-tagger.yml` workflow listens for
 * issue events and applies the first stage's label, then dispatches the
 * first stage's workflow. Intake exists as its own config field so users
 * can opt out (e.g. they want to label issues by hand) without dropping
 * the rest of the pipeline.
 */
export interface IntakeStage {
  /**
   * Whether to write the harnext-tagger workflow that auto-labels new
   * issues with the first stage's label. When false, humans add the
   * first label manually and the pipeline picks up from there.
   */
  enabled: boolean;
}

/** Default intake shape used when a config is written or loaded without one. */
export const DEFAULT_INTAKE: IntakeStage = { enabled: true };

/**
 * Back-compat alias: existing call sites referring to `StageDefinition`
 * continue to work. New code should prefer `NormalStage` or `StageEntry`.
 */
export type StageDefinition = NormalStage;

export interface GithubConnectionConfig {
  /** GitHub repository in "owner/name" form. */
  repo: string;
  /**
   * Historical poll interval, retained on the config shape for round-trip
   * stability with older saves. The cron poller is gone — workflows are
   * event-driven now — so this value is not consulted at runtime.
   */
  pollIntervalMinutes: GithubPollIntervalMinutes;
  /** Optional filter used when selecting which issues the agent picks up. */
  filter: GithubIssueFilter;
  /**
   * Stage 0 — whether the harnext-tagger workflow auto-labels new issues
   * with the first stage's label. `loadGithubConnection` fills in
   * `DEFAULT_INTAKE` (enabled) when the field is missing or carries the
   * legacy `{ runner }` shape.
   */
  intake: IntakeStage;
  /**
   * Ordered list of workflow stages. `stages[i+1]` is the "next" stage for
   * YOLO chaining, so order matters. Entries are a union of `NormalStage`
   * (single-run) and `ReviewLoopStage` (review↔fix loop with verdict-driven
   * termination). Each stage is backed by a generated or user-connected
   * GitHub Actions workflow file — see `StageRunner`.
   */
  stages: StageEntry[];
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
    mode: 'yolo',
    prompt: [
      'Stage: plan.',
      '',
      'Before planning, skim `/docs/` (if present) for project conventions,',
      'package layout, and any subsystem docs that touch the affected area.',
      'Cross-reference what you find in the plan so the implementer reuses',
      'documented patterns instead of inventing new ones.',
      '',
      'Produce an implementation plan for this issue as a single issue',
      'comment with these sections:',
      '',
      '  Summary — 2-3 sentences describing the change.',
      '  Files to change — bullet list of paths with rough line counts.',
      '  Approach — short numbered steps.',
      '  Risks — anything that could break or surprise a reviewer.',
      '  Test plan — how correctness will be verified.',
      '  Docs — cite any `/docs/*.md` pages relevant to this change so the',
      '    implementer knows what to read first.',
      '',
      'Do NOT write code. Do NOT open a branch. A human will review this',
      'plan and advance the workflow if they approve.',
    ].join('\n'),
  },
  {
    kind: 'normal',
    id: 'implement',
    label: 'harnext:implement',
    mode: 'yolo',
    prompt: [
      'Stage: implement.',
      '',
      'Before editing, skim `/docs/` (if present) for the project conventions',
      'and subsystem docs relevant to the affected files. Reuse documented',
      'patterns instead of inventing new ones; if the plan referenced a',
      '/docs page, read it first.',
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
    onExit: 'yolo',
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
    kind: 'normal',
    id: 'doc-gardening',
    label: 'harnext:doc-gardening',
    mode: 'yolo',
    trigger: 'pr-merged',
    prompt: [
      'Stage: doc-gardening (post-merge).',
      '',
      'A pull request just merged into the default branch. Your job is to keep',
      '`/docs/` aligned with the codebase. Post-merge stages run terminally —',
      'do not transition labels, do not dispatch anything, do not modify the',
      'merged PR.',
      '',
      'Self-loop guard: if the merged PR\'s head branch starts with',
      '`docs/post-merge-` (i.e. it was opened by a previous run of this',
      'stage), skip immediately. Post no comment, do nothing.',
      '',
      '1. Fetch context for the merged PR:',
      '     gh pr view $PR_NUMBER --json mergeCommit,baseRefName,headRefName,title',
      '     gh pr diff $PR_NUMBER',
      '',
      '2. Decide whether the change is significant enough to merit doc updates.',
      '   Significant: new public API, new module, new env var, new CLI flag,',
      '   behavior change visible to users/integrators, breaking change, new',
      '   dependency surface, architecture shift.',
      '   Trivial: typo, internal refactor with no public-surface change,',
      '   test-only change, formatting, dependency bump with no API impact.',
      '',
      '3. If trivial: post a single comment on the merged PR — "doc-gardening',
      '   skipped — change is internal/trivial." — and exit. No branch, no PR.',
      '',
      '4. If significant: read `/docs/` to learn how docs are structured. For',
      '   monorepos, organize per-module:',
      '     - `/docs/README.md` is the entry point and links out.',
      '     - `/docs/<module>/<topic>.md` for module-specific docs.',
      '     - Cross-link liberally; avoid duplication.',
      '   If `/docs/` does not exist yet and the change warrants it, bootstrap',
      '   it with a `README.md` indexing per-module pages you create.',
      '',
      '5. Make doc edits on a fresh branch named `docs/post-merge-<pr-number>`',
      '   off the default branch. Edit only files under `/docs/`. Open a NEW',
      '   draft PR titled `docs: update for #<pr-number>` describing what was',
      '   added/changed and which merged PR drove it.',
      '',
      'Do NOT touch code outside `/docs/`. Do NOT reopen or comment on the',
      'merged PR beyond the optional skip-comment in step 3.',
    ].join('\n'),
  },
];

export function getGithubConfigPath(cwd: string): string {
  return join(getProjectStateDir(cwd), GITHUB_CONFIG_FILE);
}

function isValidNormalStageShape(x: Record<string, unknown>): boolean {
  return (
    typeof x.id === 'string' &&
    typeof x.label === 'string' &&
    typeof x.prompt === 'string' &&
    (x.mode === 'yolo' || x.mode === 'human-approval') &&
    (x.trigger === undefined || x.trigger === 'labeled' || x.trigger === 'pr-merged')
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
    typeof fix.prompt === 'string'
  );
}

function isValidStageShape(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  if (s.kind === 'review-loop') return isValidReviewLoopStageShape(s);
  if (s.kind === undefined || s.kind === 'normal') return isValidNormalStageShape(s);
  return false;
}

/**
 * Normalize a validated raw stage entry into the modern `StageEntry`
 * shape: fills in `kind: 'normal'` on pre-union configs and migrates the
 * legacy `runner` shape into the new `{ workflowPath; origin; runsOn }`
 * model.
 */
function normalizeStageEntry(raw: Record<string, unknown>): StageEntry | undefined {
  const stageIdValue = typeof raw.id === 'string' ? raw.id : undefined;
  if (!stageIdValue) return undefined;
  const runner = migrateLegacyStageRunner(raw.runner, stageIdValue);
  if (!runner) return undefined;
  if (raw.kind === 'review-loop') {
    return { ...(raw as unknown as ReviewLoopStage), runner };
  }
  return { ...(raw as unknown as NormalStage), kind: 'normal', runner };
}

/**
 * Migrate a legacy `intake` value into the new `{ enabled }` shape. Old
 * configs carried `intake: { runner: { kind: 'local' | 'github-actions' } }`
 * — both meant "auto-tag new issues", so both round-trip to enabled=true.
 */
function migrateLegacyIntake(raw: unknown): IntakeStage {
  if (!raw || typeof raw !== 'object') return DEFAULT_INTAKE;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') return { enabled: r.enabled };
  if (r.runner !== undefined) return { enabled: true };
  return DEFAULT_INTAKE;
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

    let stages: StageEntry[] = DEFAULT_STAGES;
    if (Array.isArray(parsed.stages) && parsed.stages.every(isValidStageShape)) {
      const normalized = (parsed.stages as unknown[])
        .map((raw) => normalizeStageEntry(raw as Record<string, unknown>))
        .filter((s): s is StageEntry => s !== undefined);
      if (normalized.length === parsed.stages.length) stages = normalized;
    }

    const intake = migrateLegacyIntake(parsed.intake);

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
      intake,
      stages,
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
