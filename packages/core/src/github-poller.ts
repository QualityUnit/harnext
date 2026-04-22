import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { getProjectStateDir } from './config.js';
import {
  AWAITING_APPROVAL_LABEL,
  GITHUB_CONFIG_FILE,
  NEEDS_JUDGMENT_LABEL,
  getStageRunner,
  runGh,
  type GhResult,
  type GithubConnectionConfig,
  type GithubIssueFilter,
  type NormalStage,
  type ReviewLoopStage,
  type StageEntry,
  type StageMode,
} from './github-connection.js';
import type { WorktreeRecord } from './worktree.js';

/**
 * Hard upper bound on how many stage chains one item can advance through
 * within a single tick. Protects against misconfigurations (e.g. a stage
 * whose next ends up re-pointing at itself) that would otherwise loop
 * forever.
 */
export const MAX_STAGE_CHAIN = 10;

export const GITHUB_POLL_LOG_FILE = 'github-poller.jsonl';
export const GITHUB_POLL_LOCK_FILE = 'github-poller.lock';
/** Per-tick full agent transcripts live under the project state dir. */
export const GITHUB_RUNS_DIR_NAME = 'github-runs';
/** Default retention for per-run logs. Ticks older than this get pruned. */
export const DEFAULT_RUN_LOG_RETENTION_DAYS = 7;

// ── Types returned from the GitHub issues/PR search ─────────────────

export interface GithubIssueItem {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  updated_at: string;
  /** Present (with `html_url`) when the item is actually a PR. */
  pull_request?: { html_url: string };
  user: { login: string };
  assignees: Array<{ login: string }>;
}

export interface StageTickRecord {
  ts: string;
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  stageId: string;
  stageLabel: string;
  mode: StageMode;
  exit: number;
  durationMs: number;
  output: string;
  error?: string;
}

// ── Paths ───────────────────────────────────────────────────────────

export interface GithubPollPaths {
  dir: string;
  log: string;
  lock: string;
}

export function getGithubPollPaths(cwd: string): GithubPollPaths {
  const dir = getProjectStateDir(cwd);
  return {
    dir,
    log: join(dir, GITHUB_POLL_LOG_FILE),
    lock: join(dir, GITHUB_POLL_LOCK_FILE),
  };
}

export function getGithubRunsDir(cwd: string): string {
  return join(getProjectStateDir(cwd), GITHUB_RUNS_DIR_NAME);
}

/** Stable cron tag so we can find/update the line on reconfigure. */
export function getGithubPollCronTag(cwd: string): string {
  const h = createHash('sha256').update(cwd).digest('hex').slice(0, 10);
  return `harnext:github-poll:${h}`;
}

// ── Fetch / detect / prompt compose ─────────────────────────────────

/**
 * Page through `gh api repos/<repo>/issues?since=...` and return all items
 * in ascending-updated_at order. Uses `--paginate`, which for JSON-array
 * responses emits a single concatenated array.
 */
export function fetchUpdatedIssues(
  repo: string,
  sinceIso: string,
): GhResult<GithubIssueItem[]> {
  // `gh api` flips to POST as soon as any -f/-F flag is present. Force GET
  // explicitly so the query params are attached to the URL instead of the
  // body (a POST to /repos/X/issues tries to create an issue and 422s).
  const result = runGh([
    'api',
    '--method',
    'GET',
    `repos/${repo}/issues`,
    '-f',
    `since=${sinceIso}`,
    '-f',
    'state=all',
    '-f',
    'sort=updated',
    '-f',
    'direction=asc',
    '-f',
    'per_page=100',
    '--paginate',
  ]);
  if (!result.ok) return result;
  try {
    const parsed = JSON.parse(result.value) as GithubIssueItem[];
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      message: `could not parse gh issues response: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

/**
 * First-label-match wins. Stage order in the config is authoritative so a
 * team can define which stage takes priority when two labels are present
 * (which should not happen in steady state — poller removes them — but is
 * possible after manual label juggling).
 */
export function detectStageEntryForItem(
  item: GithubIssueItem,
  stages: StageEntry[],
): StageEntry | undefined {
  const labels = new Set(item.labels.map((l) => l.name));
  for (const stage of stages) {
    if (labels.has(stage.label)) return stage;
  }
  return undefined;
}

/**
 * Back-compat wrapper: filters to normal stages only and returns the first
 * match. Retained for existing callers that haven't migrated to stage
 * entries; the poller itself uses `detectStageEntryForItem`.
 */
export function detectStageForItem(
  item: GithubIssueItem,
  stages: NormalStage[],
): NormalStage | undefined {
  const entry = detectStageEntryForItem(item, stages as StageEntry[]);
  if (entry && (entry.kind === 'normal' || entry.kind === undefined)) {
    return entry as NormalStage;
  }
  return undefined;
}

/** Filter predicate that mirrors the wizard's filter options. */
export function passesFilter(item: GithubIssueItem, filter: GithubIssueFilter): boolean {
  switch (filter.kind) {
    case 'none':
      return true;
    case 'label':
      return item.labels.some((l) => l.name === filter.label);
    case 'assignee':
      return item.assignees.some((a) => a.login === filter.assignee);
  }
}

export function isPullRequest(item: GithubIssueItem): boolean {
  return !!item.pull_request;
}

// ── PR-handoff detection ────────────────────────────────────────────

export interface DetectOpenedPrInput {
  repo: string;
  issueNumber: number;
  /** Branch of the worktree the stage ran in, if any. Enables strategy 1. */
  worktreeBranch?: string;
  /** Final assistant output from the stage run; fallback for strategy 3. */
  agentOutput?: string;
}

export type DetectOpenedPrVia = 'worktree-branch' | 'issue-timeline' | 'output-url';

export interface DetectOpenedPrResult {
  number: number;
  via: DetectOpenedPrVia;
}

export interface DetectOpenedPrIO {
  runGh?: (args: string[]) => GhResult<string>;
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * When a stage opens a PR that closes its originating issue, the pipeline has
 * to move from issue → PR. This helper answers "did this stage produce a PR,
 * and if so, which one?" without trusting the agent's output text. Three
 * strategies, in priority order:
 *
 *   1. The worktree branch → we own it; `gh pr list --head <branch>` is O(1).
 *   2. The issue's timeline → GitHub records a `cross-referenced` event for
 *      any PR linked via `closes #<n>`.
 *   3. Regex on the agent's final message → last-resort, fragile.
 *
 * Returns undefined if no strategy finds a PR. The caller then falls back to
 * transitioning the issue's label (today's behaviour).
 */
export async function detectOpenedPr(
  input: DetectOpenedPrInput,
  io: DetectOpenedPrIO = {},
): Promise<DetectOpenedPrResult | undefined> {
  const gh = io.runGh ?? runGh;

  // Strategy 1 — worktree branch.
  if (input.worktreeBranch) {
    const res = gh([
      'pr',
      'list',
      '--repo',
      input.repo,
      '--head',
      input.worktreeBranch,
      '--state',
      'open',
      '--json',
      'number',
      '--limit',
      '1',
    ]);
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.value) as Array<{ number: number }>;
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.number === 'number') {
          return { number: parsed[0].number, via: 'worktree-branch' };
        }
      } catch {
        // fall through to strategy 2
      }
    }
  }

  // Strategy 2 — issue timeline cross-reference.
  {
    const res = gh([
      'api',
      `repos/${input.repo}/issues/${input.issueNumber}/timeline`,
      '--paginate',
      '--jq',
      '[.[] | select(.event == "cross-referenced") | .source.issue | select(.pull_request != null) | .number] | last',
    ]);
    if (res.ok) {
      // --paginate invokes --jq per page; keep the last non-null line across pages.
      const candidates = res.value
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l !== 'null');
      const last = candidates[candidates.length - 1];
      if (last) {
        const n = Number.parseInt(last, 10);
        if (Number.isFinite(n) && n > 0) {
          return { number: n, via: 'issue-timeline' };
        }
      }
    }
  }

  // Strategy 3 — regex on agent output.
  if (input.agentOutput) {
    const [owner, name] = input.repo.split('/');
    if (owner && name) {
      const pattern = new RegExp(
        `github\\.com\\/${escapeRegex(owner)}\\/${escapeRegex(name)}\\/pull\\/(\\d+)`,
        'gi',
      );
      const matches = [...input.agentOutput.matchAll(pattern)];
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        const n = Number.parseInt(lastMatch[1] ?? '', 10);
        if (Number.isFinite(n) && n > 0) {
          return { number: n, via: 'output-url' };
        }
      }
    }
  }

  return undefined;
}

/**
 * Compose the prompt sent to the agent for one stage run. The stage-specific
 * prompt comes first (what to do), followed by a rigid context block (the
 * item). There is no shared/base layer — each stage stands on its own.
 *
 * Split into a promptText-taking helper so review-loop sub-stages (which
 * carry their prompts under `.review.prompt` / `.fix.prompt`) can reuse the
 * same context composition without needing a full `NormalStage` shell.
 */
export function composeStagePrompt(
  promptText: string,
  item: GithubIssueItem,
): string {
  const kind = isPullRequest(item) ? 'pull request' : 'issue';
  const labelList = item.labels.map((l) => l.name).join(', ') || '(no labels)';
  const assigneeList = item.assignees.map((a) => a.login).join(', ') || '(none)';

  const context = [
    `## Context`,
    ``,
    `- Repo: this working directory.`,
    `- Kind: ${kind}.`,
    `- Number: #${item.number}.`,
    `- URL: ${item.html_url}`,
    `- State: ${item.state}.`,
    `- Author: ${item.user.login}.`,
    `- Assignees: ${assigneeList}.`,
    `- Labels: ${labelList}.`,
    ``,
    `### Title`,
    item.title,
    ``,
    `### Body`,
    item.body && item.body.trim().length > 0 ? item.body : '(empty)',
  ].join('\n');

  return [promptText, '', context].join('\n');
}

export function buildStagePrompt(
  stage: NormalStage,
  item: GithubIssueItem,
): string {
  return composeStagePrompt(stage.prompt, item);
}

// ── Label transitions ───────────────────────────────────────────────

/**
 * Remove a label from an item and (optionally) add another. Two `gh api`
 * calls because the labels endpoint does not atomically swap. Errors from
 * either call are surfaced so the caller can log them; we still treat a
 * "label not found on issue" 404 as success (idempotent remove).
 *
 * An empty `removeLabel` skips the remove call entirely, so this doubles as
 * an "add-only" helper — used by the auto-label path that seeds the first
 * stage on issues that arrive unlabeled.
 */
export function transitionLabels(
  repo: string,
  itemNumber: number,
  removeLabel: string,
  addLabel?: string,
): GhResult<null> {
  if (removeLabel) {
    const removeResult = runGh([
      'api',
      '--method',
      'DELETE',
      `repos/${repo}/issues/${itemNumber}/labels/${encodeURIComponent(removeLabel)}`,
    ]);
    if (!removeResult.ok && !/404|Label does not exist/i.test(removeResult.message)) {
      return removeResult;
    }
  }

  if (!addLabel) return { ok: true, value: null };

  const addResult = runGh([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues/${itemNumber}/labels`,
    '-f',
    `labels[]=${addLabel}`,
  ]);
  if (!addResult.ok) return addResult;
  return { ok: true, value: null };
}

/** Re-fetch a single item after a label transition so the next iteration of
 *  the chain sees the updated labels. */
export function refetchItem(repo: string, itemNumber: number): GhResult<GithubIssueItem> {
  const result = runGh(['api', `repos/${repo}/issues/${itemNumber}`]);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.value) as GithubIssueItem };
  } catch (err) {
    return {
      ok: false,
      message: `could not parse gh issue response: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

/**
 * Verdict of the most-recently-submitted review on a PR. `'none'` means the
 * PR has no reviews yet (or the gh query returned nothing useful).
 */
export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented' | 'none';

interface GhReviewItem {
  state: string;
  submitted_at: string | null;
}

/**
 * Fetch the latest PR review's verdict via `gh api`. We sort by
 * `submitted_at` ourselves rather than rely on server ordering so the
 * semantics stay the same if GitHub ever changes the default sort.
 */
export function fetchLatestReviewVerdict(
  repo: string,
  prNumber: number,
): GhResult<ReviewVerdict> {
  const result = runGh([
    'api',
    `repos/${repo}/pulls/${prNumber}/reviews`,
    '--paginate',
  ]);
  if (!result.ok) return result;
  try {
    const reviews = JSON.parse(result.value) as GhReviewItem[];
    if (!Array.isArray(reviews) || reviews.length === 0) {
      return { ok: true, value: 'none' };
    }
    const latest = [...reviews]
      .filter((r) => r.submitted_at)
      .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
      .pop();
    if (!latest) return { ok: true, value: 'none' };
    const state = String(latest.state).toUpperCase();
    if (state === 'APPROVED') return { ok: true, value: 'approved' };
    if (state === 'CHANGES_REQUESTED') return { ok: true, value: 'changes_requested' };
    if (state === 'COMMENTED') return { ok: true, value: 'commented' };
    return { ok: true, value: 'none' };
  } catch (err) {
    return {
      ok: false,
      message: `could not parse gh reviews response: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
    };
  }
}

// ── Tick log ────────────────────────────────────────────────────────

export function appendGithubPollTick(cwd: string, record: StageTickRecord): void {
  const { dir, log } = getGithubPollPaths(cwd);
  mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(record) + '\n', 'utf-8');
}

// ── Per-run transcripts ─────────────────────────────────────────────

/**
 * Snapshot of a single relevant event emitted during one agent run. We
 * intentionally flatten so the log file is readable without pulling in the
 * pi-agent-core types on the reader side.
 */
export interface AgentRunLogEvent {
  ts: string;
  type:
    | 'message_start'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_end'
    | 'turn_end';
  /** Free-form so we can carry upstream message roles (incl. "toolResult") without a type crosscut. */
  role?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
}

/**
 * Full transcript of a single stage run written to <cwd>/.harnext/github-runs/.
 * One file per run keeps grep/less ergonomic; `writeAgentRunLog` returns the
 * path for callers that want to point the user at it.
 */
export interface AgentRunLogRecord {
  ts: string;
  itemNumber: number;
  itemKind: 'issue' | 'pr';
  stageId: string;
  stageLabel: string;
  mode: StageMode;
  exit: number;
  durationMs: number;
  prompt: string;
  events: AgentRunLogEvent[];
  error?: string;
}

function safeTimestampForFilename(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

/**
 * Write one run's transcript. File naming: <iso-ts>-<kind>-<number>-<stage>.json.
 * Returns the absolute path so the mode can reference it in the tick summary.
 */
export function writeAgentRunLog(cwd: string, record: AgentRunLogRecord): string {
  const dir = getGithubRunsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const slug = `${safeTimestampForFilename(record.ts)}-${record.itemKind}-${record.itemNumber}-${record.stageId}.json`;
  const path = join(dir, slug);
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  return path;
}

/**
 * Remove run-log files older than `maxAgeDays`. Returns the number of files
 * deleted. Silently skips files we can't stat/unlink — best-effort cleanup.
 */
export function pruneAgentRunLogs(
  cwd: string,
  maxAgeDays: number = DEFAULT_RUN_LOG_RETENTION_DAYS,
  now: Date = new Date(),
): number {
  const dir = getGithubRunsDir(cwd);
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // best-effort
    }
  }
  return removed;
}

// ── Lockfile ────────────────────────────────────────────────────────

export interface LockHandle {
  path: string;
}

interface LockContents {
  pid: number;
  startedAt: string;
}

/**
 * Acquire the project's poll lock. Returns null if another tick holds a live
 * lock. If the lockfile exists but its pid is no longer running, we treat it
 * as stale and reclaim. Uses O_EXCL for atomic exclusive create.
 */
export function acquireLock(cwd: string): LockHandle | null {
  const { dir, lock } = getGithubPollPaths(cwd);
  mkdirSync(dir, { recursive: true });

  const writeOwnership = (): LockHandle => {
    const fd = openSync(lock, 'w');
    const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
    writeSync(fd, JSON.stringify(contents));
    closeSync(fd);
    return { path: lock };
  };

  try {
    const fd = openSync(lock, 'wx');
    const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
    writeSync(fd, JSON.stringify(contents));
    closeSync(fd);
    return { path: lock };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }

  // Lock exists — check if the holder is still alive.
  let existing: LockContents | null = null;
  try {
    existing = JSON.parse(readFileSync(lock, 'utf-8')) as LockContents;
  } catch {
    // Unreadable lock file — reclaim.
    return writeOwnership();
  }
  if (typeof existing.pid !== 'number') return writeOwnership();
  try {
    process.kill(existing.pid, 0);
    return null; // holder is alive
  } catch {
    // Holder is dead — reclaim.
    return writeOwnership();
  }
}

export function releaseLock(handle: LockHandle): void {
  try {
    unlinkSync(handle.path);
  } catch {
    // best-effort
  }
}

// ── Cron line ───────────────────────────────────────────────────────

export interface GithubPollCronLineOptions {
  schedule: string;
  cliPath: string;
  cwd: string;
  tag: string;
  nodePath?: string;
  /** PATH value to inject so the tick can find `gh` and other user-installed binaries. */
  path?: string;
  /**
   * SSH_AUTH_SOCK from the installing shell. Required for `git fetch origin`
   * over an SSH remote — cron starts with a minimal env so without this the
   * worktree resolver fails with "Permission denied (publickey)".
   */
  sshAuthSock?: string;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a crontab line for this project's GitHub poller. Output is appended
 * to the same log the tick writer uses, so a crashed boot (bad PATH, missing
 * node) leaves a trail.
 */
export function buildGithubPollCronLine(opts: GithubPollCronLineOptions): string {
  const node = opts.nodePath ?? 'node';
  const logPath = getGithubPollPaths(opts.cwd).log;
  const pathPrefix = opts.path ? `PATH=${shellQuote(opts.path)} ` : '';
  const sshPrefix = opts.sshAuthSock
    ? `SSH_AUTH_SOCK=${shellQuote(opts.sshAuthSock)} `
    : '';
  const cmd =
    `cd ${shellQuote(opts.cwd)} && ` +
    `${pathPrefix}${sshPrefix}${shellQuote(node)} ${shellQuote(opts.cliPath)} --github-poll ` +
    `>> ${shellQuote(logPath)} 2>&1`;
  return `${opts.schedule} ${cmd} # ${opts.tag}`;
}

// ── Tick driver ─────────────────────────────────────────────────────

export interface AgentRunResult {
  exit: number;
  durationMs: number;
  output: string;
  error?: string;
  /** Optional full transcript of the run. When present, runPollTick forwards it to writeRunLog. */
  events?: AgentRunLogEvent[];
}

export interface RunAgentOptions {
  /**
   * Per-item worktree path, when `resolveWorktree` is wired. When undefined
   * the runAgent implementation should fall back to its own default cwd
   * (typically the project root).
   */
  cwd?: string;
}

/**
 * IO shims the tick driver depends on. The real CLI mode wires these to gh
 * + the harnext AgentSession; tests stub them to assert chain behaviour
 * without hitting the network or the LLM.
 */
export interface PollTickIO {
  fetch: (repo: string, since: string) => GhResult<GithubIssueItem[]>;
  refetch: (repo: string, itemNumber: number) => GhResult<GithubIssueItem>;
  transition: (
    repo: string,
    itemNumber: number,
    remove: string,
    add?: string,
  ) => GhResult<null>;
  runAgent: (prompt: string, opts: RunAgentOptions) => Promise<AgentRunResult>;
  appendTick: (record: StageTickRecord) => void;
  /**
   * Fetch the latest review verdict on a PR. Only called for `review-loop`
   * stages; other branches of the poller never touch it.
   */
  fetchLatestReviewVerdict?: (repo: string, prNumber: number) => GhResult<ReviewVerdict>;
  /**
   * After a normal stage runs on an issue, detect whether the stage opened a
   * PR. Used to hand the pipeline off from the issue to the new PR by
   * relabeling. Optional — when absent, the poller keeps today's
   * issue-only label transition behaviour.
   */
  detectOpenedPr?: (input: DetectOpenedPrInput) => Promise<DetectOpenedPrResult | undefined>;
  /** If provided, each stage run's full transcript is written here. */
  writeRunLog?: (record: AgentRunLogRecord) => void;
  /**
   * If provided, called at the top of each item's stage chain. The returned
   * record's `path` becomes the cwd passed to `runAgent` for every stage the
   * item goes through during this tick.
   */
  resolveWorktree?: (item: GithubIssueItem) => Promise<WorktreeRecord>;
  /**
   * If provided, called after the chain terminates cleanly — i.e. the item
   * exited the pipeline (no next stage) and isn't parked on awaiting-approval
   * or needs-judgment. Release is best-effort: errors are swallowed into warn.
   */
  releaseWorktree?: (item: GithubIssueItem) => Promise<void>;
  /** Called for warnings that are not fatal (e.g. label transition failed). */
  warn?: (message: string) => void;
  /** Override date source for tests. */
  now?: () => Date;
}

export interface PollTickResult {
  /** New lastSeenUpdatedAt to persist. */
  newPointer: string;
  /** Number of items the loop visited (filtered or not). */
  visited: number;
  /** Number of items that triggered at least one stage run. */
  processed: number;
  /** True if the first-ever tick (no prior pointer) just primed the pointer. */
  primedPointer: boolean;
}

interface ReviewLoopContext {
  item: GithubIssueItem;
  itemKind: 'issue' | 'pr';
  group: ReviewLoopStage;
  nextEntry: StageEntry | undefined;
  cfg: GithubConnectionConfig;
  io: PollTickIO;
  warn: (msg: string) => void;
  now: () => Date;
  workRecord: WorktreeRecord | undefined;
}

interface ReviewLoopOutcome {
  /** True if any sub-stage agent was actually invoked. */
  processed: boolean;
  /** Latest item snapshot — caller propagates to the outer loop. */
  refetchedItem?: GithubIssueItem;
  /** True if the group exited cleanly with no next entry (for worktree release). */
  chainCompleted: boolean;
  /** True if the outer chain should continue to the next stage entry. */
  continueChain: boolean;
}

/**
 * Drive one review ↔ fix loop. Runs the reviewer, parses the verdict, and
 * — if `changes_requested` — runs the fixer and loops. Terminates when a
 * terminating verdict is hit or when `maxIterations` is exhausted.
 *
 * All state is per-tick; if the poller dies mid-loop the entry label
 * remains on the item and the next tick restarts the loop from iteration 0.
 */
async function runReviewLoop(ctx: ReviewLoopContext): Promise<ReviewLoopOutcome> {
  const { group, nextEntry, cfg, io, warn, now, workRecord, itemKind } = ctx;
  let item = ctx.item;
  let processed = false;

  if (itemKind !== 'pr') {
    warn(
      `review-loop stage "${group.id}" requires a PR; #${item.number} is an issue — parking on needs-judgment`,
    );
    io.transition(cfg.repo, item.number, group.label, NEEDS_JUDGMENT_LABEL);
    return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
  }

  const runSubStage = async (
    subId: string,
    promptText: string,
  ): Promise<AgentRunResult> => {
    const prompt = composeStagePrompt(promptText, item);
    const startedAt = now();
    const result = await io.runAgent(prompt, { cwd: workRecord?.path });
    processed = true;
    io.appendTick({
      ts: startedAt.toISOString(),
      itemNumber: item.number,
      itemKind,
      stageId: `${group.id}:${subId}`,
      stageLabel: group.label,
      mode: group.onExit,
      exit: result.exit,
      durationMs: result.durationMs,
      output: result.output,
      error: result.error,
    });
    if (io.writeRunLog) {
      io.writeRunLog({
        ts: startedAt.toISOString(),
        itemNumber: item.number,
        itemKind,
        stageId: `${group.id}:${subId}`,
        stageLabel: group.label,
        mode: group.onExit,
        exit: result.exit,
        durationMs: result.durationMs,
        prompt,
        events: result.events ?? [],
        error: result.error,
      });
    }
    return result;
  };

  const parkOnNeedsJudgment = (reason: string): ReviewLoopOutcome => {
    warn(`review-loop "${group.id}" on #${item.number}: ${reason}`);
    const tr = io.transition(cfg.repo, item.number, group.label, NEEDS_JUDGMENT_LABEL);
    if (!tr.ok) warn(`label transition failed for #${item.number}: ${tr.message}`);
    return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
  };

  const maxIterations = Math.max(1, group.maxIterations);
  for (let iter = 0; iter < maxIterations; iter++) {
    const reviewRes = await runSubStage('review', group.review.prompt);
    if (reviewRes.exit !== 0) {
      return parkOnNeedsJudgment(`review agent failed at iter ${iter} (exit ${reviewRes.exit})`);
    }

    if (!io.fetchLatestReviewVerdict) {
      return parkOnNeedsJudgment('fetchLatestReviewVerdict IO hook is not wired');
    }
    const verdictResult = io.fetchLatestReviewVerdict(cfg.repo, item.number);
    if (!verdictResult.ok) {
      // Transient gh failure — do NOT consume an iteration, just bail; next
      // tick retries the whole loop.
      warn(
        `fetchLatestReviewVerdict failed for #${item.number}: ${verdictResult.message}`,
      );
      return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
    }

    const verdict = verdictResult.value;
    if (verdict === 'approved' || verdict === 'commented') {
      const handoffLabel = group.onExit === 'human-approval'
        ? AWAITING_APPROVAL_LABEL
        : nextEntry?.label;
      const tr = io.transition(cfg.repo, item.number, group.label, handoffLabel);
      if (!tr.ok) {
        warn(`label transition failed for #${item.number}: ${tr.message}`);
        return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
      }
      // Clean exit. If yolo onExit and no next, the group was terminal.
      if (group.onExit === 'human-approval') {
        return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
      }
      if (!nextEntry) {
        return { processed, chainCompleted: true, continueChain: false, refetchedItem: item };
      }
      // yolo onExit with a next stage — continue outer chain. Refetch so the
      // outer loop sees the new label.
      const refetched = io.refetch(cfg.repo, item.number);
      if (!refetched.ok) {
        warn(`refetch after review-loop exit failed for #${item.number}: ${refetched.message}`);
        return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
      }
      return { processed, chainCompleted: false, continueChain: true, refetchedItem: refetched.value };
    }

    // verdict is 'changes_requested' or 'none' — both consume an iteration.
    if (iter + 1 >= maxIterations) {
      return parkOnNeedsJudgment(
        verdict === 'none'
          ? `review agent posted no verdict and max iterations (${maxIterations}) exhausted`
          : `max iterations (${maxIterations}) exhausted without approval`,
      );
    }

    const fixRes = await runSubStage('fix', group.fix.prompt);
    if (fixRes.exit !== 0) {
      return parkOnNeedsJudgment(`fix agent failed at iter ${iter} (exit ${fixRes.exit})`);
    }

    // Refetch so the next review run sees the latest item state (new commits,
    // fresh comments the fix agent may have posted, etc.).
    const refetched = io.refetch(cfg.repo, item.number);
    if (!refetched.ok) {
      warn(`refetch between review iterations failed for #${item.number}: ${refetched.message}`);
      return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
    }
    item = refetched.value;
  }

  // Unreachable — the loop body always returns — but TypeScript needs a terminal statement.
  return { processed, chainCompleted: false, continueChain: false, refetchedItem: item };
}

export async function runPollTick(
  cfg: GithubConnectionConfig,
  io: PollTickIO,
): Promise<PollTickResult> {
  const now = io.now ?? (() => new Date());
  const warn = io.warn ?? (() => {});

  // First tick: no previous pointer — prime it and return without work so we
  // don't catch up on months of history on an already-busy repo.
  if (!cfg.lastSeenUpdatedAt) {
    return {
      newPointer: now().toISOString(),
      visited: 0,
      processed: 0,
      primedPointer: true,
    };
  }

  const fetchResult = io.fetch(cfg.repo, cfg.lastSeenUpdatedAt);
  if (!fetchResult.ok) {
    warn(`fetchUpdatedIssues failed: ${fetchResult.message}`);
    return {
      newPointer: cfg.lastSeenUpdatedAt,
      visited: 0,
      processed: 0,
      primedPointer: false,
    };
  }

  let newPointer = cfg.lastSeenUpdatedAt;
  let processed = 0;
  const items = fetchResult.value;

  for (const initialItem of items) {
    let item = initialItem;

    if (!passesFilter(item, cfg.filter)) {
      newPointer = item.updated_at;
      continue;
    }

    let stage: StageEntry | undefined = detectStageEntryForItem(item, cfg.stages);

    // Auto-entry: an issue with no stage label gets tagged with the first
    // configured stage and enters the pipeline from the top. PRs are left
    // alone — the default stage set enters issues at `triage`, which is not
    // meaningful for PRs, and there's no obvious "first PR stage" to pick
    // generically. If the project later wants PR auto-entry, it should be a
    // separate config knob.
    //
    // Critically, items parked on a control label (awaiting-approval /
    // needs-judgment) are NOT auto-labeled — they're waiting on a human, not
    // sitting unclassified. Without this guard, every tick after a chain
    // completes would re-add the first-stage label and restart the pipeline
    // in an infinite loop.
    if (!stage && !isPullRequest(item) && cfg.stages.length > 0) {
      const labelSet = new Set(item.labels.map((l) => l.name));
      const parkedOnControlLabel =
        labelSet.has(AWAITING_APPROVAL_LABEL) || labelSet.has(NEEDS_JUDGMENT_LABEL);
      if (!parkedOnControlLabel) {
        const firstStage = cfg.stages[0];
        const addResult = io.transition(cfg.repo, item.number, '', firstStage.label);
        if (!addResult.ok) {
          warn(
            `auto-label failed for #${item.number} with ${firstStage.label}: ${addResult.message}`,
          );
          newPointer = item.updated_at;
          continue;
        }
        const refetched = io.refetch(cfg.repo, item.number);
        if (!refetched.ok) {
          warn(`refetch after auto-label failed for #${item.number}: ${refetched.message}`);
          newPointer = item.updated_at;
          continue;
        }
        item = refetched.value;
        stage = firstStage;
      }
    }

    if (!stage) {
      newPointer = item.updated_at;
      continue;
    }

    // Resolve a worktree for this item up front. Any subsequent stage in the
    // chain reuses it. If the resolve hook throws, we surface the error as a
    // warning and skip the item — the next tick will retry.
    let workRecord: WorktreeRecord | undefined;
    if (io.resolveWorktree) {
      try {
        workRecord = await io.resolveWorktree(item);
      } catch (err) {
        warn(
          `worktree resolve failed for #${item.number}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        newPointer = item.updated_at;
        continue;
      }
    }

    let chainDepth = 0;
    let processedThisItem = false;
    /** True iff the item exited the pipeline cleanly this tick. */
    let chainCompleted = false;

    try {
      while (stage && chainDepth < MAX_STAGE_CHAIN) {
        const currentEntry: StageEntry = stage;
        const nextEntry: StageEntry | undefined = cfg.stages[cfg.stages.indexOf(currentEntry) + 1];
        const kind: 'issue' | 'pr' = isPullRequest(item) ? 'pr' : 'issue';

        if (currentEntry.kind === 'review-loop') {
          if (getStageRunner(currentEntry).kind === 'github-actions') {
            // GHA owns the entire loop — agent invocation, label transition,
            // and needs-judgment on failure. The poller just logs and breaks.
            io.appendTick({
              ts: now().toISOString(),
              itemNumber: item.number,
              itemKind: kind,
              stageId: currentEntry.id,
              stageLabel: currentEntry.label,
              mode: currentEntry.onExit,
              exit: 0,
              durationMs: 0,
              output: '(skipped — runner: github-actions; workflow owns transition)',
            });
            break;
          }
          const outcome = await runReviewLoop({
            item,
            itemKind: kind,
            group: currentEntry,
            nextEntry,
            cfg,
            io,
            warn,
            now,
            workRecord,
          });
          if (outcome.processed) processedThisItem = true;
          if (outcome.refetchedItem) item = outcome.refetchedItem;
          if (outcome.chainCompleted) chainCompleted = true;
          if (!outcome.continueChain) break;
          stage = nextEntry;
          chainDepth += 1;
          continue;
        }

        // Normal single-run stage (currentEntry.kind is 'normal' | undefined).
        const currentStage = currentEntry as NormalStage;

        if (getStageRunner(currentStage).kind === 'github-actions') {
          // GHA owns invocation AND the label transition — the poller does
          // not run the agent and does not move the label. The workflow
          // file, fired by the stage label, handles everything from here.
          io.appendTick({
            ts: now().toISOString(),
            itemNumber: item.number,
            itemKind: kind,
            stageId: currentStage.id,
            stageLabel: currentStage.label,
            mode: currentStage.mode,
            exit: 0,
            durationMs: 0,
            output: '(skipped — runner: github-actions; workflow owns transition)',
          });
          break;
        }

        const prompt = buildStagePrompt(currentStage, item);
        const startedAt = now();
        const result = await io.runAgent(prompt, { cwd: workRecord?.path });

        io.appendTick({
          ts: startedAt.toISOString(),
          itemNumber: item.number,
          itemKind: kind,
          stageId: currentStage.id,
          stageLabel: currentStage.label,
          mode: currentStage.mode,
          exit: result.exit,
          durationMs: result.durationMs,
          output: result.output,
          error: result.error,
        });
        if (io.writeRunLog) {
          io.writeRunLog({
            ts: startedAt.toISOString(),
            itemNumber: item.number,
            itemKind: kind,
            stageId: currentStage.id,
            stageLabel: currentStage.label,
            mode: currentStage.mode,
            exit: result.exit,
            durationMs: result.durationMs,
            prompt,
            events: result.events ?? [],
            error: result.error,
          });
        }
        processedThisItem = true;

        if (result.exit !== 0) {
          // Agent failed — leave the label in place so the human can decide to
          // re-queue by touching the issue.
          warn(`agent failed on #${item.number} stage ${currentStage.id} (exit ${result.exit})`);
          break;
        }

        const handoffLabel = currentStage.mode === 'human-approval'
          ? AWAITING_APPROVAL_LABEL
          : nextEntry?.label;

        // If the stage ran on an issue and produced a PR, hand the pipeline
        // over to that PR: drop the stage label from the issue and apply the
        // handoff label to the PR. Detection is best-effort; on failure we
        // fall through to the issue-only transition path.
        let openedPr: DetectOpenedPrResult | undefined;
        if (kind === 'issue' && io.detectOpenedPr) {
          try {
            openedPr = await io.detectOpenedPr({
              repo: cfg.repo,
              issueNumber: item.number,
              worktreeBranch: workRecord?.branch,
              agentOutput: result.output,
            });
          } catch (err) {
            warn(
              `detectOpenedPr failed for #${item.number}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        if (openedPr !== undefined) {
          // Park the issue on awaiting-approval as we hand off. Without this,
          // the issue is left with no harnext:* label and the auto-entry
          // gate will re-label it with the first stage on the next tick —
          // cycling it through triage/plan/implement forever while work
          // already lives on the PR. Awaiting-approval is the right
          // semantic: the issue is done from harnext's side; humans manage
          // the PR from here.
          const parkIssue = io.transition(
            cfg.repo,
            item.number,
            currentStage.label,
            AWAITING_APPROVAL_LABEL,
          );
          if (!parkIssue.ok) {
            warn(
              `issue park failed on #${item.number}: ${parkIssue.message}`,
            );
            break;
          }
          if (handoffLabel) {
            const addOnPr = io.transition(cfg.repo, openedPr.number, '', handoffLabel);
            if (!addOnPr.ok) {
              warn(
                `label add failed on PR #${openedPr.number}: ${addOnPr.message}`,
              );
              break;
            }
          }
          io.appendTick({
            ts: now().toISOString(),
            itemNumber: openedPr.number,
            itemKind: 'pr',
            stageId: '(handoff-to-pr)',
            stageLabel: handoffLabel ?? '',
            mode: currentStage.mode,
            exit: 0,
            durationMs: 0,
            output: `${currentStage.id} handed off to PR #${openedPr.number} (detected via ${openedPr.via}); applied label "${handoffLabel ?? '(none)'}"`,
          });
        } else {
          const transitionResult = io.transition(
            cfg.repo,
            item.number,
            currentStage.label,
            handoffLabel,
          );
          if (!transitionResult.ok) {
            warn(
              `label transition failed for #${item.number}: ${transitionResult.message}`,
            );
            break;
          }
        }

        if (currentStage.mode === 'human-approval') break;
        if (!nextEntry) {
          // Last YOLO stage; nothing further to do on this item.
          chainCompleted = true;
          break;
        }

        // YOLO: reload whichever item is now carrying the handoff label — the
        // PR if we just moved the pipeline over, otherwise the original issue.
        const nextTarget = openedPr?.number ?? item.number;
        const refetched = io.refetch(cfg.repo, nextTarget);
        if (!refetched.ok) {
          warn(`refetch failed for #${nextTarget}: ${refetched.message}`);
          break;
        }
        item = refetched.value;
        stage = nextEntry;
        chainDepth += 1;
      }
    } finally {
      if (io.releaseWorktree && workRecord) {
        const parkedLabels = new Set(item.labels.map((l) => l.name));
        const parked =
          parkedLabels.has(AWAITING_APPROVAL_LABEL) ||
          parkedLabels.has(NEEDS_JUDGMENT_LABEL);
        const closed = item.state === 'closed';
        if (closed || (chainCompleted && !parked)) {
          try {
            await io.releaseWorktree(item);
          } catch (err) {
            warn(
              `worktree release failed for #${item.number}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }

    if (processedThisItem) processed += 1;
    newPointer = item.updated_at;
  }

  return {
    newPointer,
    visited: items.length,
    processed,
    primedPointer: false,
  };
}

/** Best-effort stringify for the config before writing it back. Exposed so
 *  tests can assert atomicity: the pointer advance write uses this. */
export function stringifyConnectionForSave(cfg: GithubConnectionConfig): string {
  return JSON.stringify(cfg, null, 2) + '\n';
}

/** Write-through helper for the pointer so callers can persist without
 *  depending on the save helper's signature. */
export function persistPointer(
  cwd: string,
  cfg: GithubConnectionConfig,
  pointer: string,
): void {
  const path = join(getProjectStateDir(cwd), GITHUB_CONFIG_FILE);
  const next: GithubConnectionConfig = { ...cfg, lastSeenUpdatedAt: pointer, updatedAt: Date.now() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyConnectionForSave(next), { encoding: 'utf-8', mode: 0o600 });
}
