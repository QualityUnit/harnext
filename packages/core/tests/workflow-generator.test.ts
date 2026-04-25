import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  DEFAULT_STAGES,
  type GithubConnectionConfig,
  type NormalStage,
  type ReviewLoopStage,
} from '../src/github-connection.js';
import {
  WORKFLOW_PROMPT_BUNDLES,
  substituteIssueNumberPlaceholders,
  toStageWorkflowStage,
} from '../src/workflow-prompts.js';
import { deriveFixWorkflowPath, generateStageWorkflow } from '../src/workflow-generator.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'harnext-wfgen-'));
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseCfg(
  overrides: Partial<GithubConnectionConfig> = {},
): GithubConnectionConfig {
  return {
    repo: 'example/repo',
    pollIntervalMinutes: 15,
    filter: { kind: 'none' },
    intake: { enabled: true },
    stages: DEFAULT_STAGES,
    codingAgent: 'claude-code',
    codingAgentModel: 'claude-opus-4-7',
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Fake child process that writes a YAML file to the target path and exits 0.
 * Mirrors the enough-of-a-ChildProcess surface that `runExternalCodingAgent`
 * attaches listeners to.
 */
function fakeSpawner(opts: {
  writeFileAt?: string;
  fileContent?: string;
  exitCode?: number;
}): (binary: string, args: string[]) => ChildProcessWithoutNullStreams {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      if (opts.writeFileAt) {
        mkdirSync(join(opts.writeFileAt, '..'), { recursive: true });
        writeFileSync(opts.writeFileAt, opts.fileContent ?? '# generated yaml\n');
      }
      child.stdout.emit('data', Buffer.from('done\n'));
      child.emit('close', opts.exitCode ?? 0);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

describe('deriveFixWorkflowPath', () => {
  it('inserts -fix before the .yml extension', () => {
    expect(deriveFixWorkflowPath('.github/workflows/harnext-review.yml')).toBe(
      '.github/workflows/harnext-review-fix.yml',
    );
  });

  it('preserves the .yaml extension when present', () => {
    expect(deriveFixWorkflowPath('.github/workflows/x.yaml')).toBe(
      '.github/workflows/x-fix.yaml',
    );
  });

  it('falls back to a -fix suffix on extensionless paths', () => {
    expect(deriveFixWorkflowPath('weird-no-ext')).toBe('weird-no-ext-fix');
  });
});

describe('generateStageWorkflow', () => {
  it('reports wroteFile=true and includes file contents when the agent writes the file', async () => {
    const relPath = '.github/workflows/harnext-triage.yml';
    const absPath = join(cwd, relPath);
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: relPath,
      nextLabel: 'harnext:plan',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({
        writeFileAt: absPath,
        fileContent: '# a workflow\nname: triage\n',
      }),
    });
    expect(result.wroteFile).toBe(true);
    expect(existsSync(result.workflowPath)).toBe(true);
    expect(result.workflowContent).toContain('name: triage');
    expect(result.error).toBeUndefined();
    // Prompt mentions the stage label and the workflow target.
    expect(result.promptSent).toContain('harnext:triage');
    expect(result.promptSent).toContain(relPath);
  });

  it('reports wroteFile=false and surfaces the error when the agent exits non-zero', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({ exitCode: 1 }),
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('reports wroteFile=false when the agent exits cleanly but writes nothing', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({ exitCode: 0 }),
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('uses the harnext runner hook when codingAgent is harnext', async () => {
    const relPath = '.github/workflows/harnext-plan.yml';
    const absPath = join(cwd, relPath);
    let prompted = '';
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[1] as NormalStage,
      cfg: baseCfg({ codingAgent: 'harnext', codingAgentModel: undefined }),
      relativeWorkflowPath: relPath,
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      runHarnextAgent: async (prompt, runCwd) => {
        prompted = prompt;
        expect(runCwd).toBe(cwd);
        writeFileSync(absPath, '# by harnext\n');
        return 'wrote it';
      },
    });
    expect(result.wroteFile).toBe(true);
    expect(result.agentOutput).toBe('wrote it');
    expect(prompted).toContain('harnext:plan');
  });

  it('surfaces a missing codingAgentModel error for external agents', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg({ codingAgentModel: undefined }),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toMatch(/codingAgentModel/);
  });
});

describe('WORKFLOW_PROMPT_BUNDLES', () => {
  const baseInput = {
    repo: 'example/repo',
    nextLabel: 'harnext:plan',
    awaitingLabel: 'harnext:awaiting-approval',
    needsJudgmentLabel: 'harnext:needs-judgment',
    triggerOn: 'issues' as const,
    codingAgent: 'claude-code' as const,
    codingAgentModel: 'claude-opus-4-7',
    workflowPath: '/abs/.github/workflows/harnext-triage.yml',
  };

  it('claude-code prompt names the reference action and the workflow path', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('anthropics/claude-code-action@v1');
    expect(prompt).toContain(baseInput.workflowPath);
    expect(prompt).toContain('harnext:triage');
    expect(prompt).toContain('harnext:plan');
    expect(prompt).toContain('harnext:needs-judgment');
  });

  it('claude-code reference authenticates via OAuth, not the API key', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    expect(bundle.referenceYaml).toContain('claude_code_oauth_token');
    expect(bundle.referenceYaml).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(bundle.referenceYaml).not.toMatch(/anthropic_api_key/i);
    expect(bundle.referenceYaml).not.toContain('ANTHROPIC_API_KEY');
  });

  it('claude-code reference bakes in the action-specific safety constraints', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const yaml = bundle.referenceYaml;
    // Tool allowlist — without this every Bash/Edit/Write is silently denied.
    expect(yaml).toContain('--allowedTools');
    // Bot actor bypass — needed when another workflow dispatches this one.
    expect(yaml).toContain("allowed_bots: 'github-actions'");
    // Dispatch fallback — GitHub suppresses `labeled` events for labels
    // added via GITHUB_TOKEN, so chained workflows must accept
    // workflow_dispatch.
    expect(yaml).toContain('workflow_dispatch');
    expect(yaml).toMatch(/issue_number/);
    // Guidance for reading Claude's output via execution_file (there is no
    // `result` output on the action).
    expect(yaml).toMatch(/execution_file/i);
  });

  it('claude-code prompt forbids the API key path and mandates OAuth', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    // Explicit directive in the prompt (not just the embedded reference).
    expect(prompt).toMatch(/claude_code_oauth_token/);
    expect(prompt).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(prompt).toMatch(/do not emit `?anthropic_api_key/i);
    // Required constraints are called out as hard requirements.
    expect(prompt).toMatch(/--allowedTools/);
    expect(prompt).toMatch(/allowed_bots/);
    expect(prompt).toMatch(/workflow_dispatch/);
    expect(prompt).toMatch(/execution_file/);
    // Read-only stage (triage) gets the read-only tool allowlist.
    expect(prompt).toContain('Read,Glob,Grep,Bash');
    expect(prompt).not.toContain('Read,Glob,Grep,Bash,Edit,Write');
  });

  it('claude-code prompt widens the tool allowlist for write-capable stages', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const implement = DEFAULT_STAGES.find((s) => s.id === 'implement') as NormalStage;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(implement),
    });
    expect(prompt).toContain('Read,Glob,Grep,Bash,Edit,Write');
  });

  it('codex prompt cites the docs URL', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES.codex;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      codingAgent: 'codex',
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('developers.openai.com/codex/github-action');
  });

  it('harnext prompt describes the CLI install + secret', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES.harnext;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      codingAgent: 'harnext',
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('npm i -g harnext');
    expect(prompt).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  it('review-loop review-phase prompt embeds the reviewer prompt and the loop-control decision tree', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(loop),
      phase: 'review',
      companionWorkflowFilename: 'harnext-review-fix.yml',
    });
    expect(prompt).toContain('BEGIN REVIEWER PROMPT');
    // Review phase must NOT embed the fixer prompt — that lives in the fix workflow.
    expect(prompt).not.toContain('BEGIN FIXER PROMPT');
    // The deterministic loop-control logic must be there (verdict parse + iter counter).
    expect(prompt).toMatch(/CHANGES_REQUESTED/);
    expect(prompt).toMatch(/iter < 3/);
    // The fix workflow must be the dispatch target.
    expect(prompt).toContain('gh workflow run "harnext-review-fix.yml"');
  });

  it('review-loop fix-phase prompt embeds the fixer prompt and dispatches the review companion', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(loop),
      phase: 'fix',
      companionWorkflowFilename: 'harnext-review.yml',
    });
    expect(prompt).toContain('BEGIN FIXER PROMPT');
    // Fix phase must NOT embed the reviewer prompt or the verdict parser.
    expect(prompt).not.toContain('BEGIN REVIEWER PROMPT');
    expect(prompt).not.toMatch(/CHANGES_REQUESTED/);
    // After a successful fix, the workflow must dispatch the review companion back.
    expect(prompt).toContain('gh workflow run "harnext-review.yml"');
    // Fix is dispatch-only — no labeled trigger.
    expect(prompt).toMatch(/workflow_dispatch ONLY/i);
  });

  it('terminal stage (no nextLabel) tells the agent no follow-up label to add', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      nextLabel: undefined,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toMatch(/terminal stage/i);
  });

  it('claude-code prompt mandates a workflow_dispatch of the next stage when nextWorkflowFilename is set', () => {
    // Labels added via GITHUB_TOKEN do NOT fire `labeled` events, so a
    // yolo chain between two github-actions stages stalls unless the
    // current workflow explicitly dispatches the next one via
    // `gh workflow run`. Caught live on flowhunt's triage → plan
    // handoff (issue #5336) — plan was skipped until this landed.
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      nextWorkflowFilename: 'harnext-plan.yml',
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toMatch(/gh workflow run harnext-plan\.yml/);
    expect(prompt).toMatch(/--field issue_number=\$NUM/);
    // The rationale must travel with the constraint so the agent
    // doesn't optimize it out.
    expect(prompt).toMatch(/GITHUB_TOKEN/);
    expect(prompt).toMatch(/labeled/);
  });

  it('claude-code prompt omits the dispatch constraint when nextWorkflowFilename is absent', () => {
    // Human-approval, terminal, and local-next-stage cases all arrive
    // here with no nextWorkflowFilename. The prompt must not fabricate
    // one — there is nothing to dispatch.
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).not.toMatch(/gh workflow run harnext-/);
  });

  it('embedded stage prompt substitutes $ISSUE_NUMBER placeholders with the GHA expression', () => {
    // Live bug from flowhunt's urlslab-app issue #5336: implement stage
    // no-op'd because the prompt contained the literal string
    // `$ISSUE_NUMBER`. The claude-code-action's `prompt:` field does
    // not run through a shell, so `$VAR` stays literal. When implement
    // fires on workflow_dispatch (the normal path once chain-dispatch
    // is in use), there's no `github.event.issue` either — the agent
    // simply has no issue to work on. Substitution at YAML-embed time
    // is what makes the expression resolve to a real number via the
    // fallback chain (issue → PR → workflow_dispatch input).
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const stage: NormalStage = {
      kind: 'normal',
      id: 'implement',
      label: 'harnext:implement',
      mode: 'yolo',
      prompt:
        'Run `gh issue view $ISSUE_NUMBER` and open a branch ' +
        '`issue/${ISSUE_NUMBER}-slug`. Close with `Closes #$PR_NUMBER`.',
    };
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(stage),
    });
    // Scope the no-literal check to the embedded stage-prompt block —
    // the constraint text elsewhere in the prompt intentionally
    // mentions `$ISSUE_NUMBER` by name ("do not replace it with
    // $ISSUE_NUMBER") and that's fine.
    const embedded = prompt.slice(
      prompt.indexOf('BEGIN STAGE PROMPT'),
      prompt.indexOf('END STAGE PROMPT'),
    );
    expect(embedded).not.toContain('$ISSUE_NUMBER');
    expect(embedded).not.toContain('${ISSUE_NUMBER}');
    expect(embedded).not.toContain('$PR_NUMBER');
    expect(embedded).not.toContain('${PR_NUMBER}');
    // The full GHA expression is present (at least once per original
    // placeholder). We don't pin an exact count so future prompt
    // authors can repeat the placeholder freely.
    expect(embedded).toContain(
      '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}',
    );
    // Hard constraint (i) tells the YAML-writer not to rewrite the
    // expression. Lives in the constraints section, not the embed.
    expect(prompt).toMatch(/Preserve every `\$\{\{ … }}` expression/);
  });

  it('substituteIssueNumberPlaceholders handles both $VAR and ${VAR} forms for issue and PR', () => {
    // Focused unit test so a future change to the placeholder set can't
    // silently regress — each variant must collapse to the same GHA
    // expression. The \\b word-boundary rule matters: we don't want
    // `$ISSUE_NUMBER_REAL` (hypothetical) to partially match.
    const expr =
      '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}';
    expect(substituteIssueNumberPlaceholders('cmd $ISSUE_NUMBER arg')).toBe(
      `cmd ${expr} arg`,
    );
    expect(substituteIssueNumberPlaceholders('cmd ${ISSUE_NUMBER} arg')).toBe(
      `cmd ${expr} arg`,
    );
    expect(substituteIssueNumberPlaceholders('cmd $PR_NUMBER arg')).toBe(
      `cmd ${expr} arg`,
    );
    expect(substituteIssueNumberPlaceholders('cmd ${PR_NUMBER} arg')).toBe(
      `cmd ${expr} arg`,
    );
    // No-match strings round-trip unchanged.
    expect(substituteIssueNumberPlaceholders('cmd NUM arg')).toBe('cmd NUM arg');
    // Word boundary: `$ISSUE_NUMBER_SUFFIX` is not a placeholder.
    expect(substituteIssueNumberPlaceholders('cmd $ISSUE_NUMBER_SUFFIX')).toBe(
      'cmd $ISSUE_NUMBER_SUFFIX',
    );
  });

  it('substitutes $PR_NUMBER inside the review phase reviewer prompt', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop: ReviewLoopStage = {
      kind: 'review-loop',
      id: 'review',
      label: 'harnext:review',
      maxIterations: 3,
      review: { prompt: 'Review PR $PR_NUMBER on this repo.' },
      fix: { prompt: 'Address review comments on #${PR_NUMBER}.' },
      onExit: 'yolo',
    };
    const expr =
      '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}';
    const reviewPrompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(loop),
      phase: 'review',
      companionWorkflowFilename: 'harnext-review-fix.yml',
    });
    const reviewBlock = reviewPrompt.slice(
      reviewPrompt.indexOf('BEGIN REVIEWER PROMPT'),
      reviewPrompt.indexOf('END REVIEWER PROMPT'),
    );
    expect(reviewBlock).toContain(expr);
    expect(reviewBlock).not.toContain('$PR_NUMBER');
  });

  it('substitutes ${PR_NUMBER} inside the fix phase fixer prompt', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop: ReviewLoopStage = {
      kind: 'review-loop',
      id: 'review',
      label: 'harnext:review',
      maxIterations: 3,
      review: { prompt: 'Review PR $PR_NUMBER on this repo.' },
      fix: { prompt: 'Address review comments on #${PR_NUMBER}.' },
      onExit: 'yolo',
    };
    const expr =
      '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}';
    const fixPrompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(loop),
      phase: 'fix',
      companionWorkflowFilename: 'harnext-review.yml',
    });
    const fixBlock = fixPrompt.slice(
      fixPrompt.indexOf('BEGIN FIXER PROMPT'),
      fixPrompt.indexOf('END FIXER PROMPT'),
    );
    expect(fixBlock).toContain(expr);
    expect(fixBlock).not.toContain('${PR_NUMBER}');
  });

  it('throws if review-loop input is missing the phase field', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    expect(() =>
      bundle.buildGeneratorPrompt({
        ...baseInput,
        stage: toStageWorkflowStage(loop),
      }),
    ).toThrow(/phase/);
  });

  it('pr-merged trigger emits pull_request: [closed] + merged-only guard, skips PR handoff', () => {
    // Doc-gardening fires on `pull_request.closed` with merged==true. The
    // generator must (a) emit the closed trigger, (b) narrow with the merged
    // guard, (c) drop the PR-handoff guidance (we ARE the post-merge run, no
    // issue→PR handoff possible), (d) describe the stage as terminal with no
    // label transitions.
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const docGardening = DEFAULT_STAGES.find(
      (s) => s.kind === 'normal' && s.id === 'doc-gardening',
    ) as NormalStage;
    expect(docGardening).toBeDefined();
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      triggerOn: 'pr-merged',
      stage: toStageWorkflowStage(docGardening),
    });
    expect(prompt).toMatch(/on\.pull_request\.types: \[closed\]/);
    expect(prompt).toMatch(/github\.event\.pull_request\.merged == true/);
    expect(prompt).toMatch(/Post-merge terminal stage: NO label transitions/);
    // PR handoff guidance is for issue-triggered stages that may open a PR
    // mid-flight; doc-gardening is post-merge so it should NOT appear.
    expect(prompt).not.toMatch(/If the stage runs on an issue and the agent opens a pull request/);
    // No workflow_dispatch trigger — post-merge stages are not chained.
    expect(prompt).toMatch(/Do NOT add a workflow_dispatch trigger/);
  });
});
