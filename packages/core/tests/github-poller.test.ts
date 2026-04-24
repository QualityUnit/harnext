import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getProjectStateDir } from '../src/config.js';
import {
  AWAITING_APPROVAL_LABEL,
  DEFAULT_STAGES,
  loadGithubConnection,
  saveGithubConnection,
  type GithubConnectionConfig,
  type GithubIssueFilter,
  type StageDefinition,
} from '../src/github-connection.js';
import {
  DEFAULT_RUN_LOG_RETENTION_DAYS,
  MAX_STAGE_CHAIN,
  acquireLock,
  buildGithubPollCronLine,
  buildStagePrompt,
  detectOpenedPr,
  detectStageForItem,
  getGithubPollPaths,
  getGithubRunsDir,
  passesFilter,
  pruneAgentRunLogs,
  releaseLock,
  runPollTick,
  writeAgentRunLog,
  type AgentRunLogRecord,
  type AgentRunResult,
  type DetectOpenedPrInput,
  type DetectOpenedPrResult,
  type GithubIssueItem,
  type PollTickIO,
  type RunAgentOptions,
  type StageTickRecord,
} from '../src/github-poller.js';
import type { GhResult } from '../src/github-connection.js';
import type { WorktreeRecord } from '../src/worktree.js';
import { NEEDS_JUDGMENT_LABEL } from '../src/github-connection.js';

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'harnext-gh-poll-'));
}

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;

beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-gh-poll-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

function makeItem(overrides: Partial<GithubIssueItem> = {}): GithubIssueItem {
  return {
    number: 1,
    title: 'Example issue',
    body: 'Some body',
    state: 'open',
    html_url: 'https://github.com/example/repo/issues/1',
    labels: [],
    updated_at: '2026-04-19T12:00:00Z',
    user: { login: 'alice' },
    assignees: [],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<GithubConnectionConfig> = {}): GithubConnectionConfig {
  return {
    repo: 'example/repo',
    pollIntervalMinutes: 15,
    filter: { kind: 'none' },
    intake: { runner: { kind: 'local' } },
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
    lastSeenUpdatedAt: '2026-04-19T10:00:00Z',
    codingAgent: 'harnext',
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Scriptable IO stub for runPollTick. Each field records calls so tests
 * can assert exactly what the poller asked gh/the agent to do.
 */
function makeIo(opts: {
  items: GithubIssueItem[];
  agentResults: AgentRunResult[];
  /**
   * When a refetch is requested, we pop from this queue so YOLO chains see
   * the correct "next" label without touching real gh.
   */
  refetchResults?: GithubIssueItem[];
  transitionFailOn?: Array<{ itemNumber: number; removeLabel: string; message: string }>;
  /**
   * FIFO of review verdicts returned by fetchLatestReviewVerdict. Tests that
   * don't exercise review-loop stages can leave this unset.
   */
  verdictResults?: Array<'approved' | 'changes_requested' | 'commented' | 'none'>;
  /**
   * FIFO of detectOpenedPr results. When absent, the IO does not supply a
   * detector (the poller falls back to today's issue-only transition).
   * Each entry can be either a concrete result or `undefined` to simulate
   * "no PR detected this run".
   */
  detectOpenedPrResults?: Array<DetectOpenedPrResult | undefined>;
}): PollTickIO & {
  ticks: StageTickRecord[];
  prompts: string[];
  promptOpts: RunAgentOptions[];
  transitions: Array<{ remove: string; add?: string; itemNumber: number }>;
  refetches: number[];
  warnings: string[];
  verdictQueries: number[];
  detectCalls: DetectOpenedPrInput[];
} {
  const ticks: StageTickRecord[] = [];
  const prompts: string[] = [];
  const promptOpts: RunAgentOptions[] = [];
  const transitions: Array<{ remove: string; add?: string; itemNumber: number }> = [];
  const refetches: number[] = [];
  const warnings: string[] = [];
  const verdictQueries: number[] = [];
  const detectCalls: DetectOpenedPrInput[] = [];

  const agentQueue = [...opts.agentResults];
  const refetchQueue = [...(opts.refetchResults ?? [])];
  const verdictQueue = [...(opts.verdictResults ?? [])];
  const detectQueue = opts.detectOpenedPrResults ? [...opts.detectOpenedPrResults] : undefined;

  const io: PollTickIO = {
    fetch: () => ({ ok: true, value: opts.items }),
    refetch: (_repo, itemNumber) => {
      refetches.push(itemNumber);
      const next = refetchQueue.shift();
      if (!next) throw new Error(`test missing refetch for #${itemNumber}`);
      return { ok: true, value: next };
    },
    transition: (_repo, itemNumber, remove, add) => {
      transitions.push({ itemNumber, remove, add });
      const fail = opts.transitionFailOn?.find(
        (f) => f.itemNumber === itemNumber && f.removeLabel === remove,
      );
      if (fail) {
        return { ok: false, message: fail.message, exitCode: 1 };
      }
      return { ok: true, value: null };
    },
    runAgent: async (prompt, opts) => {
      prompts.push(prompt);
      promptOpts.push({ ...opts });
      const next = agentQueue.shift();
      if (!next) throw new Error('test ran out of scripted agent results');
      return next;
    },
    appendTick: (r) => {
      ticks.push(r);
    },
    warn: (m) => {
      warnings.push(m);
    },
    fetchLatestReviewVerdict: (_repo, prNumber) => {
      verdictQueries.push(prNumber);
      const next = verdictQueue.shift();
      if (!next) throw new Error(`test ran out of scripted verdict results for PR #${prNumber}`);
      return { ok: true, value: next };
    },
  };

  if (detectQueue) {
    io.detectOpenedPr = async (input) => {
      detectCalls.push(input);
      if (detectQueue.length === 0) {
        throw new Error(`test ran out of scripted detectOpenedPr results for #${input.issueNumber}`);
      }
      return detectQueue.shift();
    };
  }

  return Object.assign(io, {
    ticks,
    prompts,
    promptOpts,
    transitions,
    refetches,
    warnings,
    verdictQueries,
    detectCalls,
  });
}

// ─────────────────────────────────────────────────────────────────────

describe('detectStageForItem', () => {
  const stages: StageDefinition[] = [
    { id: 'triage', label: 'harnext:triage', prompt: 'p', mode: 'yolo' },
    { id: 'plan', label: 'harnext:plan', prompt: 'p', mode: 'human-approval' },
    { id: 'implement', label: 'harnext:implement', prompt: 'p', mode: 'human-approval' },
  ];

  it('returns undefined when no stage label is present', () => {
    const item = makeItem({ labels: [{ name: 'bug' }, { name: 'priority:low' }] });
    expect(detectStageForItem(item, stages)).toBeUndefined();
  });

  it('returns the matching stage when one label matches', () => {
    const item = makeItem({ labels: [{ name: 'harnext:plan' }, { name: 'bug' }] });
    expect(detectStageForItem(item, stages)?.id).toBe('plan');
  });

  it('picks the earliest stage in config order when multiple labels match', () => {
    const item = makeItem({
      labels: [{ name: 'harnext:implement' }, { name: 'harnext:triage' }],
    });
    expect(detectStageForItem(item, stages)?.id).toBe('triage');
  });
});

describe('passesFilter', () => {
  it('none always passes', () => {
    expect(passesFilter(makeItem(), { kind: 'none' })).toBe(true);
  });

  it('label filter matches only when label is present', () => {
    const filter: GithubIssueFilter = { kind: 'label', label: 'team:me' };
    expect(passesFilter(makeItem({ labels: [{ name: 'team:me' }] }), filter)).toBe(true);
    expect(passesFilter(makeItem({ labels: [{ name: 'team:other' }] }), filter)).toBe(false);
  });

  it('assignee filter checks the assignees list', () => {
    const filter: GithubIssueFilter = { kind: 'assignee', assignee: 'alice' };
    expect(passesFilter(makeItem({ assignees: [{ login: 'alice' }] }), filter)).toBe(true);
    expect(passesFilter(makeItem({ assignees: [{ login: 'bob' }] }), filter)).toBe(false);
  });
});

describe('buildStagePrompt', () => {
  const stage: StageDefinition = {
    id: 'triage',
    label: 'harnext:triage',
    prompt: 'STAGE PROMPT',
    mode: 'yolo',
  };

  it('composes stage prompt + issue context, with no shared base layer', () => {
    const item = makeItem({ labels: [{ name: 'harnext:triage' }] });
    const out = buildStagePrompt(stage, item);
    expect(out).toContain('STAGE PROMPT');
    expect(out).toContain('Kind: issue.');
    expect(out).toContain(`Number: #${item.number}`);
    expect(out).toContain(item.title);
  });

  it('identifies pull requests via pull_request field', () => {
    const pr = makeItem({ pull_request: { html_url: 'https://example/pr' } });
    const out = buildStagePrompt(stage, pr);
    expect(out).toContain('Kind: pull request.');
  });

  it('handles empty body and no labels gracefully', () => {
    const item = makeItem({ body: '', labels: [] });
    const out = buildStagePrompt(stage, item);
    expect(out).toContain('(empty)');
    expect(out).toContain('(no labels)');
  });

  it('substitutes $ISSUE_NUMBER / $PR_NUMBER / braced variants with the real item number', () => {
    // Live bug: flowhunt's verify stage's stored prompt used
    // `$PR_NUMBER` (and `$ISSUE_NUMBER` in earlier stages) as if it
    // were a shell variable. When the local poller spawns claude
    // directly via argv, there is no shell expansion — so the agent
    // got literal `$PR_NUMBER` text. Substitution here makes the
    // placeholders plain-text numbers before the prompt is handed
    // to the subprocess.
    const item = makeItem({ number: 5339 });
    const withPlaceholders: StageDefinition = {
      id: 'verify',
      label: 'harnext:verify',
      mode: 'yolo',
      prompt:
        'Verify PR #$PR_NUMBER. Checkout: `gh pr checkout $PR_NUMBER`. ' +
        'Branch: `issue/${ISSUE_NUMBER}`. Close with #${PR_NUMBER}.',
    };
    const out = buildStagePrompt(withPlaceholders, item);
    // No literal placeholders survive anywhere in the output.
    expect(out).not.toContain('$PR_NUMBER');
    expect(out).not.toContain('${PR_NUMBER}');
    expect(out).not.toContain('$ISSUE_NUMBER');
    expect(out).not.toContain('${ISSUE_NUMBER}');
    // All four placeholder sites should have resolved to the number.
    expect(out).toContain('Verify PR #5339.');
    expect(out).toContain('gh pr checkout 5339');
    expect(out).toContain('Branch: `issue/5339`');
    expect(out).toContain('Close with #5339.');
  });

  it('leaves similar-but-non-placeholder text alone (word-boundary on bare $VAR)', () => {
    // `$ISSUE_NUMBER_SUFFIX` must NOT partial-match.
    const item = makeItem({ number: 42 });
    const stage: StageDefinition = {
      id: 'verify',
      label: 'harnext:verify',
      mode: 'yolo',
      prompt: 'Keep $ISSUE_NUMBER_SUFFIX untouched; resolve $PR_NUMBER only.',
    };
    const out = buildStagePrompt(stage, item);
    expect(out).toContain('$ISSUE_NUMBER_SUFFIX untouched');
    expect(out).toContain('resolve 42 only');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('runPollTick', () => {
  it('primes the pointer and does no work on first tick', async () => {
    const fixed = new Date('2026-04-19T09:00:00Z');
    const cfg = baseConfig({ lastSeenUpdatedAt: undefined });
    const io = makeIo({ items: [], agentResults: [] });
    const result = await runPollTick(cfg, { ...io, now: () => fixed });
    expect(result.primedPointer).toBe(true);
    expect(result.newPointer).toBe(fixed.toISOString());
    expect(io.ticks).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
  });

  it('auto-labels an issue with no stage label as the first stage and runs it', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'human-approval' },
    ];
    const initial = makeItem({
      number: 5,
      labels: [{ name: 'bug' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const afterLabel = makeItem({
      ...initial,
      labels: [{ name: 'bug' }, { name: 'harnext:triage' }],
    });
    const cfg = baseConfig({ stages });
    const io = makeIo({
      items: [initial],
      refetchResults: [afterLabel],
      agentResults: [{ exit: 0, durationMs: 1, output: 'triaged' }],
    });
    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(1);
    // First transition is the auto-label (empty remove, add first stage).
    expect(io.transitions[0]).toEqual({
      itemNumber: 5,
      remove: '',
      add: 'harnext:triage',
    });
    expect(io.prompts).toHaveLength(1);
    expect(io.ticks[0].stageId).toBe('triage');
  });

  it('does NOT auto-label items parked on awaiting-approval (would restart chain in a loop)', async () => {
    const item = makeItem({
      number: 6,
      labels: [{ name: AWAITING_APPROVAL_LABEL }, { name: 'cleanup' }],
      updated_at: '2026-04-19T13:00:00Z',
    });
    const cfg = baseConfig();
    const io = makeIo({ items: [item], agentResults: [] });
    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(0);
    expect(result.newPointer).toBe(item.updated_at);
    expect(io.transitions).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
  });

  it('does NOT auto-label items parked on needs-judgment', async () => {
    const item = makeItem({
      number: 8,
      labels: [{ name: NEEDS_JUDGMENT_LABEL }],
      updated_at: '2026-04-19T13:05:00Z',
    });
    const cfg = baseConfig();
    const io = makeIo({ items: [item], agentResults: [] });
    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(0);
    expect(io.transitions).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
  });

  it('skips PRs that have no stage label (auto-entry is issues-only)', async () => {
    const pr = makeItem({
      number: 99,
      labels: [{ name: 'bug' }],
      pull_request: { html_url: 'https://example/pr' },
      updated_at: '2026-04-19T12:30:00Z',
    });
    const cfg = baseConfig();
    const io = makeIo({ items: [pr], agentResults: [] });
    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(0);
    expect(result.newPointer).toBe(pr.updated_at);
    expect(io.transitions).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
  });

  it('does NOT auto-label when intake runs on github-actions (tagger workflow owns that boundary)', async () => {
    // When intake is delegated to github-actions the generated tagger
    // workflow is the sole writer for the first-stage label on new
    // issues. The poller must stay silent — two writers on the same
    // boundary produce duplicate runs.
    const initial = makeItem({
      number: 42,
      labels: [{ name: 'bug' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const cfg = baseConfig({
      intake: {
        runner: {
          kind: 'github-actions',
          workflowPath: '.github/workflows/harnext-tagger.yml',
          origin: 'generated',
        },
      },
    });
    const io = makeIo({ items: [initial], agentResults: [] });
    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(0);
    expect(result.newPointer).toBe(initial.updated_at);
    expect(io.transitions).toHaveLength(0);
    expect(io.prompts).toHaveLength(0);
  });

  it('stops and adds awaiting-approval label for human-approval stage', async () => {
    const stages: StageDefinition[] = [
      { id: 'plan', label: 'harnext:plan', prompt: 'plan it', mode: 'human-approval' },
      { id: 'implement', label: 'harnext:implement', prompt: 'do it', mode: 'human-approval' },
    ];
    const item = makeItem({ number: 7, labels: [{ name: 'harnext:plan' }] });
    const cfg = baseConfig({ stages });
    const io = makeIo({
      items: [item],
      agentResults: [{ exit: 0, durationMs: 123, output: 'planned.' }],
    });

    const result = await runPollTick(cfg, io);
    expect(result.processed).toBe(1);
    expect(io.prompts).toHaveLength(1);
    expect(io.transitions).toEqual([
      { itemNumber: 7, remove: 'harnext:plan', add: AWAITING_APPROVAL_LABEL },
    ]);
    expect(io.refetches).toHaveLength(0);
    expect(io.ticks[0].stageId).toBe('plan');
    expect(io.ticks[0].mode).toBe('human-approval');
  });

  it('chains multiple YOLO stages within a single tick, refetching between', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'yolo' },
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'yolo' },
      { id: 'review', label: 'harnext:review', prompt: 'review', mode: 'human-approval' },
    ];
    const initial = makeItem({ number: 9, labels: [{ name: 'harnext:triage' }] });
    const afterFirst = makeItem({ number: 9, labels: [{ name: 'harnext:verify' }] });
    const afterSecond = makeItem({ number: 9, labels: [{ name: 'harnext:review' }] });

    const cfg = baseConfig({ stages });
    const io = makeIo({
      items: [initial],
      agentResults: [
        { exit: 0, durationMs: 10, output: 'triaged' },
        { exit: 0, durationMs: 20, output: 'verified' },
        { exit: 0, durationMs: 30, output: 'reviewed' },
      ],
      refetchResults: [afterFirst, afterSecond],
    });

    await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(3);
    expect(io.ticks.map((t) => t.stageId)).toEqual(['triage', 'verify', 'review']);
    // After the human-approval terminal stage, we add awaiting-approval.
    expect(io.transitions).toEqual([
      { itemNumber: 9, remove: 'harnext:triage', add: 'harnext:verify' },
      { itemNumber: 9, remove: 'harnext:verify', add: 'harnext:review' },
      { itemNumber: 9, remove: 'harnext:review', add: AWAITING_APPROVAL_LABEL },
    ]);
    // Only YOLO steps refetch — human-approval terminal step doesn't.
    expect(io.refetches).toEqual([9, 9]);
  });

  it('halts the chain on agent failure without transitioning labels', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'yolo' },
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'yolo' },
    ];
    const item = makeItem({ number: 3, labels: [{ name: 'harnext:triage' }] });
    const cfg = baseConfig({ stages });
    const io = makeIo({
      items: [item],
      agentResults: [{ exit: 2, durationMs: 7, output: 'tool err', error: 'boom' }],
    });

    await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(1);
    expect(io.transitions).toHaveLength(0);
    expect(io.ticks[0].exit).toBe(2);
    expect(io.warnings.some((w) => w.includes('agent failed'))).toBe(true);
  });

  it('halts chain when label transition fails', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'yolo' },
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'yolo' },
    ];
    const item = makeItem({ number: 4, labels: [{ name: 'harnext:triage' }] });
    const cfg = baseConfig({ stages });
    const io = makeIo({
      items: [item],
      agentResults: [{ exit: 0, durationMs: 5, output: 'ok' }],
      transitionFailOn: [
        { itemNumber: 4, removeLabel: 'harnext:triage', message: 'rate limited' },
      ],
    });

    await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(1);
    expect(io.transitions).toHaveLength(1);
    expect(io.refetches).toHaveLength(0);
    expect(io.warnings.some((w) => w.includes('label transition failed'))).toBe(true);
  });

  it('last-stage YOLO removes the label and stops without a next-stage add', async () => {
    const stages: StageDefinition[] = [
      { id: 'only', label: 'harnext:only', prompt: 'only', mode: 'yolo' },
    ];
    const io = makeIo({
      items: [makeItem({ number: 12, labels: [{ name: 'harnext:only' }] })],
      agentResults: [{ exit: 0, durationMs: 1, output: '' }],
    });
    const result = await runPollTick(baseConfig({ stages }), io);
    expect(result.processed).toBe(1);
    expect(io.transitions).toEqual([
      { itemNumber: 12, remove: 'harnext:only', add: undefined },
    ]);
  });

  it('caps YOLO chain at MAX_STAGE_CHAIN when a cycle would otherwise loop', async () => {
    // Ten stages, each YOLO, each label-named after its index. The chain of
    // agent runs is capped by MAX_STAGE_CHAIN = 10. We queue exactly that
    // many agent results; if the cap weren't enforced, the test would throw
    // on the 11th runAgent call.
    const stages: StageDefinition[] = Array.from({ length: MAX_STAGE_CHAIN + 2 }, (_, i) => ({
      id: `s${i}`,
      label: `harnext:s${i}`,
      prompt: `p${i}`,
      mode: 'yolo' as const,
    }));
    const initial = makeItem({ number: 20, labels: [{ name: 'harnext:s0' }] });
    const refetchResults = Array.from({ length: MAX_STAGE_CHAIN }, (_, i) =>
      makeItem({ number: 20, labels: [{ name: `harnext:s${i + 1}` }] }),
    );
    const agentResults: AgentRunResult[] = Array.from(
      { length: MAX_STAGE_CHAIN },
      () => ({ exit: 0, durationMs: 1, output: '' }),
    );

    const io = makeIo({ items: [initial], agentResults, refetchResults });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts.length).toBe(MAX_STAGE_CHAIN);
  });

  it('returns the pointer unchanged when fetch fails', async () => {
    const cfg = baseConfig();
    const io: PollTickIO & { warnings: string[] } = {
      fetch: () => ({ ok: false, message: 'nope', exitCode: 1 }),
      refetch: () => {
        throw new Error('unexpected refetch');
      },
      transition: () => {
        throw new Error('unexpected transition');
      },
      runAgent: async () => {
        throw new Error('unexpected agent');
      },
      appendTick: () => {},
      warn: (m) => io.warnings.push(m),
      warnings: [],
    } satisfies PollTickIO & { warnings: string[] };
    const result = await runPollTick(cfg, io);
    expect(result.newPointer).toBe(cfg.lastSeenUpdatedAt);
    expect(result.processed).toBe(0);
    expect(io.warnings[0]).toContain('fetchUpdatedIssues failed');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('schema backfill', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpCwd();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('loads an old github.json without stages and backfills defaults', () => {
    const dir = getProjectStateDir(cwd);
    mkdirSync(dir, { recursive: true });
    const old = {
      repo: 'example/repo',
      pollIntervalMinutes: 15,
      filter: { kind: 'none' },
      updatedAt: 1700000000000,
    };
    writeFileSync(join(dir, 'github.json'), JSON.stringify(old), 'utf-8');

    const loaded = loadGithubConnection(cwd);
    expect(loaded).not.toBeNull();
    expect(loaded?.stages).toHaveLength(DEFAULT_STAGES.length);
    expect(loaded?.stages.map((s) => s.id)).toEqual(DEFAULT_STAGES.map((s) => s.id));
    expect(loaded?.lastSeenUpdatedAt).toBeUndefined();
  });

  it('preserves stages and pointer through a save/load round-trip', () => {
    const cfg = baseConfig({
      stages: [
        { id: 'triage', label: 'harnext:triage', prompt: 'p', mode: 'yolo' },
        { id: 'plan', label: 'harnext:plan', prompt: 'q', mode: 'human-approval' },
      ],
      lastSeenUpdatedAt: '2026-04-19T12:00:00Z',
    });
    saveGithubConnection(cwd, cfg);
    const loaded = loadGithubConnection(cwd);
    expect(loaded?.stages.map((s) => s.id)).toEqual(['triage', 'plan']);
    expect(loaded?.lastSeenUpdatedAt).toBe('2026-04-19T12:00:00Z');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('lockfile', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpCwd();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('second acquire while first is held returns null', () => {
    const first = acquireLock(cwd);
    expect(first).not.toBeNull();
    const second = acquireLock(cwd);
    expect(second).toBeNull();
    if (first) releaseLock(first);
  });

  it('release allows re-acquire', () => {
    const first = acquireLock(cwd);
    if (first) releaseLock(first);
    const second = acquireLock(cwd);
    expect(second).not.toBeNull();
    if (second) releaseLock(second);
  });

  it('reclaims a lock whose pid is no longer running', () => {
    const { dir, lock } = getGithubPollPaths(cwd);
    mkdirSync(dir, { recursive: true });
    // pid 2^30 is almost certainly not a live process on this host.
    const fd = openSync(lock, 'w');
    writeSync(fd, JSON.stringify({ pid: 1 << 30, startedAt: new Date().toISOString() }));
    closeSync(fd);

    const handle = acquireLock(cwd);
    expect(handle).not.toBeNull();
    const contents = JSON.parse(readFileSync(lock, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid);
    if (handle) releaseLock(handle);
  });

  it('reclaims an unreadable lockfile', () => {
    const { dir, lock } = getGithubPollPaths(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'not json', 'utf-8');
    const handle = acquireLock(cwd);
    expect(handle).not.toBeNull();
    if (handle) releaseLock(handle);
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('buildGithubPollCronLine', () => {
  it('emits a --github-poll invocation tagged for this cwd', () => {
    const line = buildGithubPollCronLine({
      schedule: '*/15 * * * *',
      cliPath: '/usr/local/bin/harnext',
      cwd: '/home/user/project',
      tag: 'harnext:github-poll:abcdef0123',
      nodePath: '/usr/bin/node',
    });
    expect(line).toMatch(/^\*\/15 \* \* \* \* /);
    expect(line).toContain('--github-poll');
    expect(line).toContain('# harnext:github-poll:abcdef0123');
    expect(line).toContain('cd /home/user/project');
    expect(line).toContain('/usr/bin/node /usr/local/bin/harnext --github-poll');
  });

  it('shell-quotes paths with spaces', () => {
    const line = buildGithubPollCronLine({
      schedule: '0 */1 * * *',
      cliPath: '/path with space/harnext',
      cwd: '/dir with space',
      tag: 'harnext:github-poll:xyz',
    });
    expect(line).toContain(`'/dir with space'`);
    expect(line).toContain(`'/path with space/harnext'`);
  });

  it('injects PATH when provided so cron ticks can find gh', () => {
    const line = buildGithubPollCronLine({
      schedule: '*/3 * * * *',
      cliPath: '/opt/harnext/cli.js',
      cwd: '/home/user/project',
      tag: 'harnext:github-poll:xyz',
      nodePath: '/usr/bin/node',
      path: '/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin',
    });
    // PATH must sit between `cd ... && ` and the node invocation.
    expect(line).toContain('PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin');
    expect(line).toMatch(
      /cd \/home\/user\/project && PATH=\S+ \/usr\/bin\/node \/opt\/harnext\/cli\.js --github-poll/,
    );
  });

  it('shell-quotes PATH when it contains shell-unsafe characters', () => {
    const line = buildGithubPollCronLine({
      schedule: '*/3 * * * *',
      cliPath: '/opt/cli.js',
      cwd: '/tmp',
      tag: 'harnext:github-poll:xyz',
      path: "/home/u/my bin:/usr/bin",
    });
    expect(line).toContain(`PATH='/home/u/my bin:/usr/bin'`);
  });

  it('omits the PATH prefix when path is not provided', () => {
    const line = buildGithubPollCronLine({
      schedule: '*/15 * * * *',
      cliPath: '/opt/cli.js',
      cwd: '/tmp',
      tag: 'harnext:github-poll:abc',
    });
    expect(line).not.toContain('PATH=');
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('writeAgentRunLog / pruneAgentRunLogs', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const record = (overrides: Partial<AgentRunLogRecord> = {}): AgentRunLogRecord => ({
    ts: '2026-04-19T12:45:00.000Z',
    itemNumber: 46,
    itemKind: 'issue',
    stageId: 'triage',
    stageLabel: 'harnext:triage',
    mode: 'yolo',
    exit: 0,
    durationMs: 1234,
    prompt: 'Stage: triage.',
    events: [
      { ts: '2026-04-19T12:45:00.500Z', type: 'message_end', role: 'assistant', text: 'hi' },
    ],
    ...overrides,
  });

  it('writes a JSON file named after the timestamp, kind, number, and stage', () => {
    const path = writeAgentRunLog(cwd, record());
    expect(path).toBe(
      join(
        getGithubRunsDir(cwd),
        '2026-04-19T12-45-00-000Z-issue-46-triage.json',
      ),
    );
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AgentRunLogRecord;
    expect(parsed.itemNumber).toBe(46);
    expect(parsed.prompt).toBe('Stage: triage.');
    expect(parsed.events).toHaveLength(1);
  });

  it('does not touch files when the runs dir is missing', () => {
    // No runs dir yet — prune is a no-op and returns 0.
    expect(pruneAgentRunLogs(cwd)).toBe(0);
  });

  it('removes files whose mtime is older than the retention window', () => {
    const oldRecord = record({ itemNumber: 1, stageId: 'triage' });
    const freshRecord = record({ itemNumber: 2, stageId: 'triage' });
    const oldPath = writeAgentRunLog(cwd, oldRecord);
    const freshPath = writeAgentRunLog(cwd, freshRecord);

    // Backdate the first file past the retention window.
    const older = (DEFAULT_RUN_LOG_RETENTION_DAYS + 2) * 24 * 60 * 60;
    const past = Date.now() / 1000 - older;
    // utimesSync: access + modified time in seconds. Using fs util via a small helper.
    // We use require-free node:fs utimesSync for portability.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { utimesSync } = require('node:fs') as typeof import('node:fs');
    utimesSync(oldPath, past, past);

    const removed = pruneAgentRunLogs(cwd);
    expect(removed).toBe(1);
    // Fresh file remains.
    expect(() => readFileSync(freshPath)).not.toThrow();
    // Old file is gone.
    expect(() => readFileSync(oldPath)).toThrow();
  });

  it('is a no-op when every file is within the retention window', () => {
    writeAgentRunLog(cwd, record());
    expect(pruneAgentRunLogs(cwd)).toBe(0);
  });
});

describe('runPollTick · writeRunLog', () => {
  it('forwards the full transcript to writeRunLog when the io provides it', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'Triage this.', mode: 'human-approval' },
    ];
    const item = makeItem({
      number: 46,
      labels: [{ name: 'harnext:triage' }],
      updated_at: '2026-04-19T12:45:00Z',
    });
    const io = makeIo({
      items: [item],
      agentResults: [
        {
          exit: 0,
          durationMs: 100,
          output: 'done',
          events: [
            { ts: 'x', type: 'message_end', role: 'assistant', text: 'done' },
          ],
        },
      ],
    });
    const runLogs: AgentRunLogRecord[] = [];
    const io2 = { ...io, writeRunLog: (rec: AgentRunLogRecord) => runLogs.push(rec) };
    await runPollTick(baseConfig({ stages }), io2);

    expect(runLogs).toHaveLength(1);
    expect(runLogs[0].itemNumber).toBe(46);
    expect(runLogs[0].stageId).toBe('triage');
    expect(runLogs[0].prompt).toContain('Triage this.');
    expect(runLogs[0].events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────

describe('runPollTick · worktree hooks', () => {
  function worktreeIo(itemsOpts: {
    items: GithubIssueItem[];
    agentResults: AgentRunResult[];
    refetchResults?: GithubIssueItem[];
  }) {
    const io = makeIo(itemsOpts);
    const resolveCalls: number[] = [];
    const releaseCalls: number[] = [];
    const record = (itemNumber: number): WorktreeRecord => ({
      itemNumber,
      itemKind: 'issue',
      path: `/tmp/fake-wt/issue-${itemNumber}`,
      branch: `harnext/issue-${itemNumber}`,
      createdAt: '2026-04-19T00:00:00Z',
      lastStageAt: '2026-04-19T00:00:00Z',
    });
    const withHooks: PollTickIO & typeof io & {
      resolveCalls: number[];
      releaseCalls: number[];
    } = Object.assign(io, {
      resolveWorktree: async (item: GithubIssueItem) => {
        resolveCalls.push(item.number);
        return record(item.number);
      },
      releaseWorktree: async (item: GithubIssueItem) => {
        releaseCalls.push(item.number);
      },
      resolveCalls,
      releaseCalls,
    });
    return withHooks;
  }

  it('threads worktree cwd into every runAgent call for the item', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'yolo' },
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'yolo' },
    ];
    const initial = makeItem({ number: 11, labels: [{ name: 'harnext:triage' }] });
    const after = makeItem({ number: 11, labels: [{ name: 'harnext:verify' }] });
    const afterLast = makeItem({ number: 11, labels: [] });
    const io = worktreeIo({
      items: [initial],
      agentResults: [
        { exit: 0, durationMs: 1, output: '' },
        { exit: 0, durationMs: 1, output: '' },
      ],
      refetchResults: [after, afterLast],
    });

    await runPollTick(baseConfig({ stages }), io);

    expect(io.resolveCalls).toEqual([11]);
    expect(io.prompts).toHaveLength(2);
    for (const opts of io.promptOpts) {
      expect(opts.cwd).toBe('/tmp/fake-wt/issue-11');
    }
  });

  it('releases the worktree after a YOLO chain exhausts with no parking label', async () => {
    const stages: StageDefinition[] = [
      { id: 'only', label: 'harnext:only', prompt: 'only', mode: 'yolo' },
    ];
    const item = makeItem({ number: 12, labels: [{ name: 'harnext:only' }] });
    const io = worktreeIo({
      items: [item],
      agentResults: [{ exit: 0, durationMs: 1, output: '' }],
    });

    await runPollTick(baseConfig({ stages }), io);
    expect(io.releaseCalls).toEqual([12]);
  });

  it('does NOT release when the stage is human-approval (parks on awaiting-approval)', async () => {
    const stages: StageDefinition[] = [
      { id: 'plan', label: 'harnext:plan', prompt: 'plan', mode: 'human-approval' },
    ];
    // After the stage runs, transition adds awaiting-approval — but the
    // in-memory item object still has its original labels. The poller's
    // "parked?" check reads item.labels, so seed them to include the parking label.
    const parked = makeItem({
      number: 13,
      labels: [{ name: 'harnext:plan' }, { name: AWAITING_APPROVAL_LABEL }],
    });
    const io = worktreeIo({
      items: [parked],
      agentResults: [{ exit: 0, durationMs: 1, output: '' }],
    });
    await runPollTick(baseConfig({ stages }), io);
    expect(io.releaseCalls).toEqual([]);
  });

  it('does NOT release when the item is parked on needs-judgment', async () => {
    const stages: StageDefinition[] = [
      { id: 'only', label: 'harnext:only', prompt: 'only', mode: 'yolo' },
    ];
    const item = makeItem({
      number: 14,
      labels: [{ name: 'harnext:only' }, { name: NEEDS_JUDGMENT_LABEL }],
    });
    const io = worktreeIo({
      items: [item],
      agentResults: [{ exit: 0, durationMs: 1, output: '' }],
    });
    await runPollTick(baseConfig({ stages }), io);
    expect(io.releaseCalls).toEqual([]);
  });

  it('releases when the item is closed, regardless of stage mode', async () => {
    const stages: StageDefinition[] = [
      { id: 'plan', label: 'harnext:plan', prompt: 'plan', mode: 'human-approval' },
    ];
    const item = makeItem({
      number: 15,
      labels: [{ name: 'harnext:plan' }],
      state: 'closed',
    });
    const io = worktreeIo({
      items: [item],
      agentResults: [{ exit: 0, durationMs: 1, output: '' }],
    });
    await runPollTick(baseConfig({ stages }), io);
    expect(io.releaseCalls).toEqual([15]);
  });

  it('skips the item and does NOT release when resolveWorktree throws', async () => {
    const stages: StageDefinition[] = [
      { id: 'only', label: 'harnext:only', prompt: 'only', mode: 'yolo' },
    ];
    const item = makeItem({ number: 16, labels: [{ name: 'harnext:only' }] });
    const io = makeIo({
      items: [item],
      agentResults: [],
    });
    const releaseCalls: number[] = [];
    const io2: PollTickIO & typeof io & { releaseCalls: number[] } = Object.assign(io, {
      resolveWorktree: async () => {
        throw new Error('git boom');
      },
      releaseWorktree: async (item: GithubIssueItem) => {
        releaseCalls.push(item.number);
      },
      releaseCalls,
    });
    await runPollTick(baseConfig({ stages }), io2);

    expect(io2.prompts).toHaveLength(0);
    expect(io2.releaseCalls).toEqual([]);
    expect(io2.warnings.some((w) => w.includes('worktree resolve failed'))).toBe(true);
  });

  it('does NOT release when the agent failed mid-chain', async () => {
    const stages: StageDefinition[] = [
      { id: 'a', label: 'harnext:a', prompt: 'a', mode: 'yolo' },
      { id: 'b', label: 'harnext:b', prompt: 'b', mode: 'yolo' },
    ];
    const item = makeItem({ number: 17, labels: [{ name: 'harnext:a' }] });
    const io = worktreeIo({
      items: [item],
      agentResults: [{ exit: 2, durationMs: 1, output: '', error: 'boom' }],
    });
    await runPollTick(baseConfig({ stages }), io);
    expect(io.releaseCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// review-loop stage
// ─────────────────────────────────────────────────────────────────────

import { NEEDS_JUDGMENT_LABEL as NJL } from '../src/github-connection.js';
import type { StageEntry, ReviewLoopStage } from '../src/github-connection.js';

describe('runPollTick — review-loop stage', () => {
  function makePr(overrides: Partial<GithubIssueItem> = {}): GithubIssueItem {
    return makeItem({
      number: 100,
      pull_request: { html_url: 'https://github.com/example/repo/pull/100' },
      labels: [{ name: 'harnext:review-loop' }],
      ...overrides,
    });
  }

  const reviewLoop: ReviewLoopStage = {
    kind: 'review-loop',
    id: 'review-loop',
    label: 'harnext:review-loop',
    maxIterations: 3,
    review: { prompt: 'REVIEW' },
    fix: { prompt: 'FIX' },
    onExit: 'human-approval',
  };

  it('approves on first pass — advances to awaiting-approval, no fix', async () => {
    const pr = makePr();
    const stages: StageEntry[] = [reviewLoop];
    const io = makeIo({
      items: [pr],
      agentResults: [{ exit: 0, durationMs: 5, output: 'reviewed' }],
      verdictResults: ['approved'],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(1);
    expect(io.prompts[0]).toContain('REVIEW');
    expect(io.verdictQueries).toEqual([pr.number]);
    expect(io.transitions).toEqual([
      { itemNumber: pr.number, remove: 'harnext:review-loop', add: AWAITING_APPROVAL_LABEL },
    ]);
    expect(io.ticks.map((t) => t.stageId)).toEqual(['review-loop:review']);
  });

  it('changes_requested triggers fix, then approves on second review', async () => {
    const pr = makePr();
    const stages: StageEntry[] = [reviewLoop];
    const io = makeIo({
      items: [pr],
      agentResults: [
        { exit: 0, durationMs: 5, output: 'review-1' },
        { exit: 0, durationMs: 5, output: 'fix-1' },
        { exit: 0, durationMs: 5, output: 'review-2' },
      ],
      verdictResults: ['changes_requested', 'approved'],
      // One refetch between iterations (after fix).
      refetchResults: [makePr()],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(3);
    expect(io.prompts[0]).toContain('REVIEW');
    expect(io.prompts[1]).toContain('FIX');
    expect(io.prompts[2]).toContain('REVIEW');
    expect(io.verdictQueries).toEqual([pr.number, pr.number]);
    expect(io.refetches).toEqual([pr.number]);
    expect(io.ticks.map((t) => t.stageId)).toEqual([
      'review-loop:review',
      'review-loop:fix',
      'review-loop:review',
    ]);
    expect(io.transitions).toEqual([
      { itemNumber: pr.number, remove: 'harnext:review-loop', add: AWAITING_APPROVAL_LABEL },
    ]);
  });

  it('exhausts maxIterations — parks on needs-judgment', async () => {
    const pr = makePr();
    const capped: ReviewLoopStage = { ...reviewLoop, maxIterations: 2 };
    const stages: StageEntry[] = [capped];
    const io = makeIo({
      items: [pr],
      agentResults: [
        { exit: 0, durationMs: 5, output: 'review-1' },
        { exit: 0, durationMs: 5, output: 'fix-1' },
        { exit: 0, durationMs: 5, output: 'review-2' },
      ],
      verdictResults: ['changes_requested', 'changes_requested'],
      refetchResults: [makePr()],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(3);
    expect(io.ticks.map((t) => t.stageId)).toEqual([
      'review-loop:review',
      'review-loop:fix',
      'review-loop:review',
    ]);
    expect(io.transitions).toEqual([
      { itemNumber: pr.number, remove: 'harnext:review-loop', add: NJL },
    ]);
    expect(io.warnings.some((w) => w.includes('max iterations'))).toBe(true);
  });

  it('non-PR issue immediately parks on needs-judgment', async () => {
    // Issue (no pull_request field) labeled with the review-loop entry label.
    const issue = makeItem({
      number: 77,
      labels: [{ name: 'harnext:review-loop' }],
    });
    const stages: StageEntry[] = [reviewLoop];
    const io = makeIo({
      items: [issue],
      agentResults: [],
      verdictResults: [],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(0);
    expect(io.verdictQueries).toEqual([]);
    expect(io.transitions).toEqual([
      { itemNumber: issue.number, remove: 'harnext:review-loop', add: NJL },
    ]);
  });

  it('review agent non-zero exit parks on needs-judgment', async () => {
    const pr = makePr();
    const stages: StageEntry[] = [reviewLoop];
    const io = makeIo({
      items: [pr],
      agentResults: [{ exit: 2, durationMs: 5, output: '', error: 'boom' }],
      verdictResults: [],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(1);
    expect(io.verdictQueries).toEqual([]);
    expect(io.transitions).toEqual([
      { itemNumber: pr.number, remove: 'harnext:review-loop', add: NJL },
    ]);
  });

  it('yolo onExit advances to next stage after approval', async () => {
    const pr = makePr({ labels: [{ name: 'harnext:review-loop' }] });
    const yoloLoop: ReviewLoopStage = { ...reviewLoop, onExit: 'yolo' };
    const nextStage: StageDefinition = {
      id: 'after',
      label: 'harnext:after',
      prompt: 'after',
      mode: 'human-approval',
    };
    const stages: StageEntry[] = [yoloLoop, nextStage];
    const prWithNextLabel = makePr({ labels: [{ name: 'harnext:after' }] });
    const io = makeIo({
      items: [pr],
      agentResults: [
        { exit: 0, durationMs: 5, output: 'review' },
        { exit: 0, durationMs: 5, output: 'after-ran' },
      ],
      verdictResults: ['approved'],
      refetchResults: [prWithNextLabel],
    });
    await runPollTick(baseConfig({ stages }), io);

    expect(io.prompts).toHaveLength(2);
    expect(io.transitions).toEqual([
      { itemNumber: pr.number, remove: 'harnext:review-loop', add: 'harnext:after' },
      { itemNumber: pr.number, remove: 'harnext:after', add: AWAITING_APPROVAL_LABEL },
    ]);
    expect(io.ticks.map((t) => t.stageId)).toEqual(['review-loop:review', 'after']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PR handoff — detectOpenedPr + runPollTick normal-stage branch
// ─────────────────────────────────────────────────────────────────────

describe('runPollTick — PR handoff (issue → PR)', () => {
  it('human-approval stage opens a PR: issue de-labeled, PR gets awaiting-approval', async () => {
    const stages: StageDefinition[] = [
      { id: 'implement', label: 'harnext:implement', prompt: 'implement', mode: 'human-approval' },
    ];
    const issue = makeItem({
      number: 56,
      labels: [{ name: 'harnext:implement' }],
      updated_at: '2026-04-21T21:10:00Z',
    });
    const io = makeIo({
      items: [issue],
      agentResults: [{ exit: 0, durationMs: 100, output: 'opened PR' }],
      detectOpenedPrResults: [{ number: 57, via: 'worktree-branch' }],
    });

    await runPollTick(baseConfig({ stages }), io);

    expect(io.detectCalls).toHaveLength(1);
    expect(io.detectCalls[0].issueNumber).toBe(56);
    // First transition: park issue on awaiting-approval (remove stage, add AA).
    // Second transition: add handoff label to PR.
    expect(io.transitions).toEqual([
      { itemNumber: 56, remove: 'harnext:implement', add: AWAITING_APPROVAL_LABEL },
      { itemNumber: 57, remove: '', add: AWAITING_APPROVAL_LABEL },
    ]);
    // Two ticks: the stage tick + the synthetic handoff tick.
    expect(io.ticks.map((t) => t.stageId)).toEqual(['implement', '(handoff-to-pr)']);
    const handoffTick = io.ticks[1];
    expect(handoffTick.itemNumber).toBe(57);
    expect(handoffTick.itemKind).toBe('pr');
    expect(handoffTick.output).toContain('handed off to PR #57');
    expect(handoffTick.output).toContain('via worktree-branch');
  });

  it('yolo stage opens a PR: refetch rebinds next stage to the PR', async () => {
    const stages: StageDefinition[] = [
      { id: 'implement', label: 'harnext:implement', prompt: 'implement', mode: 'yolo' },
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'yolo' },
    ];
    const issue = makeItem({
      number: 56,
      labels: [{ name: 'harnext:implement' }],
    });
    const prWithVerifyLabel = makeItem({
      number: 57,
      pull_request: { html_url: 'https://github.com/example/repo/pull/57' },
      labels: [{ name: 'harnext:verify' }],
    });
    const io = makeIo({
      items: [issue],
      agentResults: [
        { exit: 0, durationMs: 10, output: 'opened PR' },
        { exit: 0, durationMs: 20, output: 'verified' },
      ],
      // First stage produces a PR; second stage runs on the refetched PR.
      detectOpenedPrResults: [
        { number: 57, via: 'issue-timeline' },
        undefined,
      ],
      refetchResults: [prWithVerifyLabel],
    });

    await runPollTick(baseConfig({ stages }), io);

    // Refetch target is the PR number, not the issue number.
    expect(io.refetches).toEqual([57]);
    // Second runAgent call sees the PR context.
    expect(io.prompts[1]).toContain('Kind: pull request.');
    expect(io.prompts[1]).toContain('Number: #57');
    // Transitions:
    //  1. park issue: remove implement label, add awaiting-approval
    //  2. add verify label to PR
    //  3. terminal yolo: remove verify from PR (no add)
    expect(io.transitions).toEqual([
      { itemNumber: 56, remove: 'harnext:implement', add: AWAITING_APPROVAL_LABEL },
      { itemNumber: 57, remove: '', add: 'harnext:verify' },
      { itemNumber: 57, remove: 'harnext:verify', add: undefined },
    ]);
    expect(io.ticks.map((t) => t.stageId)).toEqual([
      'implement',
      '(handoff-to-pr)',
      'verify',
    ]);
  });

  it('detector returns undefined: falls back to today\'s issue-only transition', async () => {
    const stages: StageDefinition[] = [
      { id: 'plan', label: 'harnext:plan', prompt: 'plan', mode: 'human-approval' },
    ];
    const issue = makeItem({ number: 42, labels: [{ name: 'harnext:plan' }] });
    const io = makeIo({
      items: [issue],
      agentResults: [{ exit: 0, durationMs: 5, output: 'planned' }],
      detectOpenedPrResults: [undefined],
    });

    await runPollTick(baseConfig({ stages }), io);

    expect(io.detectCalls).toHaveLength(1);
    // Today's behaviour: single combined remove+add on the issue.
    expect(io.transitions).toEqual([
      { itemNumber: 42, remove: 'harnext:plan', add: AWAITING_APPROVAL_LABEL },
    ]);
    expect(io.ticks.map((t) => t.stageId)).toEqual(['plan']);
  });

  it('when IO does not provide detectOpenedPr, legacy path is unchanged', async () => {
    const stages: StageDefinition[] = [
      { id: 'plan', label: 'harnext:plan', prompt: 'plan', mode: 'human-approval' },
    ];
    const issue = makeItem({ number: 43, labels: [{ name: 'harnext:plan' }] });
    // No detectOpenedPrResults — IO does not expose detectOpenedPr at all.
    const io = makeIo({
      items: [issue],
      agentResults: [{ exit: 0, durationMs: 5, output: 'planned' }],
    });

    await runPollTick(baseConfig({ stages }), io);

    expect(io.detectCalls).toEqual([]);
    expect(io.transitions).toEqual([
      { itemNumber: 43, remove: 'harnext:plan', add: AWAITING_APPROVAL_LABEL },
    ]);
  });

  it('detectOpenedPr is not called for PR items (review-loop handed off upstream)', async () => {
    const stages: StageDefinition[] = [
      { id: 'verify', label: 'harnext:verify', prompt: 'verify', mode: 'human-approval' },
    ];
    const pr = makeItem({
      number: 200,
      pull_request: { html_url: 'https://example/pr' },
      labels: [{ name: 'harnext:verify' }],
    });
    const io = makeIo({
      items: [pr],
      agentResults: [{ exit: 0, durationMs: 5, output: 'verified' }],
      // Queue is empty — if the poller called it we'd throw.
      detectOpenedPrResults: [],
    });

    await runPollTick(baseConfig({ stages }), io);

    expect(io.detectCalls).toEqual([]);
    expect(io.transitions).toEqual([
      { itemNumber: 200, remove: 'harnext:verify', add: AWAITING_APPROVAL_LABEL },
    ]);
  });

  it('halts the chain when the PR handoff label-add fails', async () => {
    const stages: StageDefinition[] = [
      { id: 'implement', label: 'harnext:implement', prompt: 'implement', mode: 'human-approval' },
    ];
    const issue = makeItem({ number: 56, labels: [{ name: 'harnext:implement' }] });
    const io = makeIo({
      items: [issue],
      agentResults: [{ exit: 0, durationMs: 5, output: 'opened PR' }],
      detectOpenedPrResults: [{ number: 57, via: 'worktree-branch' }],
      transitionFailOn: [
        { itemNumber: 57, removeLabel: '', message: 'label harnext:awaiting-approval does not exist' },
      ],
    });

    await runPollTick(baseConfig({ stages }), io);

    // Issue parked on awaiting-approval; PR add failed.
    expect(io.transitions).toEqual([
      { itemNumber: 56, remove: 'harnext:implement', add: AWAITING_APPROVAL_LABEL },
      { itemNumber: 57, remove: '', add: AWAITING_APPROVAL_LABEL },
    ]);
    expect(io.warnings.some((w) => w.includes('label add failed on PR #57'))).toBe(true);
    // No handoff tick (we bailed before the synthetic tick write).
    expect(io.ticks.map((t) => t.stageId)).toEqual(['implement']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectOpenedPr unit tests — strategy precedence via runGh stub
// ─────────────────────────────────────────────────────────────────────

describe('detectOpenedPr', () => {
  function makeGhStub(
    responses: Record<string, GhResult<string>>,
  ): { runGh: (args: string[]) => GhResult<string>; calls: string[][] } {
    const calls: string[][] = [];
    const runGh = (args: string[]): GhResult<string> => {
      calls.push(args);
      // Match the first response whose key is a substring of the joined args.
      const joined = args.join(' ');
      for (const [key, value] of Object.entries(responses)) {
        if (joined.includes(key)) return value;
      }
      return { ok: false, message: `no stub response for: ${joined}`, exitCode: 1 };
    };
    return { runGh, calls };
  }

  it('strategy 1 (worktree branch) wins when pr list returns a PR', async () => {
    const { runGh, calls } = makeGhStub({
      'pr list': { ok: true, value: JSON.stringify([{ number: 57 }]) },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'issue/56-branding',
        agentOutput: 'ignored',
      },
      { runGh },
    );
    expect(result).toEqual({ number: 57, via: 'worktree-branch' });
    // Only one gh call — we did not fall through to strategy 2.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--head');
    expect(calls[0]).toContain('issue/56-branding');
  });

  it('strategy 2 (issue timeline) wins when strategy 1 returns empty', async () => {
    const { runGh, calls } = makeGhStub({
      'pr list': { ok: true, value: '[]' },
      'timeline': { ok: true, value: '42\n' },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'some-branch',
      },
      { runGh },
    );
    expect(result).toEqual({ number: 42, via: 'issue-timeline' });
    expect(calls).toHaveLength(2);
  });

  it('strategy 2 skips "null" output from jq and falls through when no cross-references', async () => {
    const { runGh } = makeGhStub({
      'pr list': { ok: true, value: '[]' },
      'timeline': { ok: true, value: 'null\nnull\n' },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'some-branch',
        agentOutput: 'https://github.com/example/repo/pull/99',
      },
      { runGh },
    );
    expect(result).toEqual({ number: 99, via: 'output-url' });
  });

  it('strategy 3 (output URL regex) picks up the last PR URL in the message', async () => {
    const { runGh } = makeGhStub({
      'pr list': { ok: false, message: 'rate limit', exitCode: 1 },
      'timeline': { ok: false, message: 'rate limit', exitCode: 1 },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'some-branch',
        agentOutput:
          'Referenced https://github.com/example/repo/pull/5 earlier, then opened https://github.com/example/repo/pull/57 as draft.',
      },
      { runGh },
    );
    expect(result).toEqual({ number: 57, via: 'output-url' });
  });

  it('regex is case-insensitive for owner/repo segments', async () => {
    const { runGh } = makeGhStub({
      'pr list': { ok: false, message: 'fail', exitCode: 1 },
      'timeline': { ok: false, message: 'fail', exitCode: 1 },
    });
    const result = await detectOpenedPr(
      {
        repo: 'ExampleOrg/Repo',
        issueNumber: 1,
        agentOutput: 'opened https://github.com/exampleorg/repo/pull/12',
      },
      { runGh },
    );
    expect(result?.number).toBe(12);
  });

  it('returns undefined when all three strategies fail', async () => {
    const { runGh } = makeGhStub({
      'pr list': { ok: true, value: '[]' },
      'timeline': { ok: true, value: 'null\n' },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'some-branch',
        agentOutput: 'no links here',
      },
      { runGh },
    );
    expect(result).toBeUndefined();
  });

  it('skips strategy 1 when worktreeBranch is absent', async () => {
    const { runGh, calls } = makeGhStub({
      'timeline': { ok: true, value: '99\n' },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
      },
      { runGh },
    );
    expect(result).toEqual({ number: 99, via: 'issue-timeline' });
    // No `pr list` call.
    expect(calls.every((args) => !args.includes('list'))).toBe(true);
  });

  it('across paginated jq output, takes the last non-null number', async () => {
    const { runGh } = makeGhStub({
      'pr list': { ok: true, value: '[]' },
      // Simulate --paginate emitting once per page.
      'timeline': { ok: true, value: '10\nnull\n57\n' },
    });
    const result = await detectOpenedPr(
      {
        repo: 'example/repo',
        issueNumber: 56,
        worktreeBranch: 'branch',
      },
      { runGh },
    );
    expect(result).toEqual({ number: 57, via: 'issue-timeline' });
  });
});

describe('runPollTick — github-actions runner', () => {
  const ghaRunner = {
    kind: 'github-actions' as const,
    workflowPath: '.github/workflows/harnext-triage.yml',
    origin: 'generated' as const,
  };

  it('skips a normal stage marked github-actions: no agent run, no transition', async () => {
    const stages: StageDefinition[] = [
      {
        id: 'triage',
        label: 'harnext:triage',
        prompt: 'triage',
        mode: 'yolo',
        runner: ghaRunner,
      },
      { id: 'plan', label: 'harnext:plan', prompt: 'plan', mode: 'human-approval' },
    ];
    const item = makeItem({
      number: 7,
      labels: [{ name: 'harnext:triage' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const cfg = baseConfig({ stages, lastSeenUpdatedAt: '2026-04-19T10:00:00Z' });
    const io = makeIo({ items: [item], agentResults: [] });

    const result = await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(0);
    expect(io.transitions).toHaveLength(0);
    // GHA skip does not count as "processed" — the workflow owns the run.
    expect(result.processed).toBe(0);
    const skip = io.ticks.find((t) => /skipped/i.test(t.output ?? ''));
    expect(skip).toBeDefined();
    expect(skip!.stageId).toBe('triage');
    expect(skip!.stageLabel).toBe('harnext:triage');
    expect(result.newPointer).toBe(item.updated_at);
  });

  it('breaks the YOLO chain at a github-actions boundary (local → gha)', async () => {
    const stages: StageDefinition[] = [
      { id: 'triage', label: 'harnext:triage', prompt: 'triage', mode: 'yolo' },
      {
        id: 'plan',
        label: 'harnext:plan',
        prompt: 'plan',
        mode: 'yolo',
        runner: {
          ...ghaRunner,
          workflowPath: '.github/workflows/harnext-plan.yml',
        },
      },
      { id: 'implement', label: 'harnext:implement', prompt: 'implement', mode: 'yolo' },
    ];
    const initial = makeItem({
      number: 8,
      labels: [{ name: 'harnext:triage' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const afterTriage = makeItem({
      number: 8,
      labels: [{ name: 'harnext:plan' }],
      updated_at: '2026-04-19T12:31:00Z',
    });
    const cfg = baseConfig({ stages, lastSeenUpdatedAt: '2026-04-19T10:00:00Z' });
    const io = makeIo({
      items: [initial],
      refetchResults: [afterTriage],
      agentResults: [{ exit: 0, durationMs: 10, output: 'triage-done' }],
    });

    await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(1); // only triage ran
    // Exactly one transition — triage → plan (the local → gha handoff).
    expect(io.transitions).toEqual([
      { itemNumber: 8, remove: 'harnext:triage', add: 'harnext:plan' },
    ]);
    const skip = io.ticks.find(
      (t) => t.stageId === 'plan' && /skipped/i.test(t.output ?? ''),
    );
    expect(skip).toBeDefined();
  });

  it('skips a review-loop stage marked github-actions: no agent run, no verdict query', async () => {
    const stages: StageDefinition[] = [
      {
        id: 'review',
        label: 'harnext:review',
        kind: 'review-loop' as const,
        maxIterations: 3,
        review: { prompt: 'review' },
        fix: { prompt: 'fix' },
        onExit: 'human-approval',
        runner: {
          ...ghaRunner,
          workflowPath: '.github/workflows/harnext-review.yml',
        },
      } as unknown as StageDefinition,
    ];
    const pr = makeItem({
      number: 9,
      labels: [{ name: 'harnext:review' }],
      pull_request: { html_url: 'https://example/pr' },
    });
    const cfg = baseConfig({ stages, lastSeenUpdatedAt: '2026-04-19T10:00:00Z' });
    const io = makeIo({ items: [pr], agentResults: [] });

    await runPollTick(cfg, io);

    expect(io.prompts).toHaveLength(0);
    expect(io.verdictQueries).toHaveLength(0);
    expect(io.transitions).toHaveLength(0);
    const skip = io.ticks.find(
      (t) => t.stageId === 'review' && /skipped/i.test(t.output ?? ''),
    );
    expect(skip).toBeDefined();
  });

  it('auto-entry: adds the first stage label even when runner is gha, then skips', async () => {
    const stages: StageDefinition[] = [
      {
        id: 'triage',
        label: 'harnext:triage',
        prompt: 'triage',
        mode: 'human-approval',
        runner: ghaRunner,
      },
    ];
    const item = makeItem({
      number: 10,
      labels: [{ name: 'bug' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const afterLabel = makeItem({
      number: 10,
      labels: [{ name: 'bug' }, { name: 'harnext:triage' }],
      updated_at: '2026-04-19T12:30:00Z',
    });
    const cfg = baseConfig({ stages, lastSeenUpdatedAt: '2026-04-19T10:00:00Z' });
    const io = makeIo({
      items: [item],
      refetchResults: [afterLabel],
      agentResults: [],
    });

    await runPollTick(cfg, io);

    // Auto-entry still adds the first stage label…
    expect(io.transitions).toEqual([
      { itemNumber: 10, remove: '', add: 'harnext:triage' },
    ]);
    // …but the chain breaks before running the agent.
    expect(io.prompts).toHaveLength(0);
    const skip = io.ticks.find(
      (t) => t.stageId === 'triage' && /skipped/i.test(t.output ?? ''),
    );
    expect(skip).toBeDefined();
  });
});
