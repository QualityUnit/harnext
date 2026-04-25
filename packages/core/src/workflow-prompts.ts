/**
 * Per-coding-agent prompt bundles used by the workflow generator. Each
 * bundle knows how to ask a given coding agent to author a GitHub Actions
 * workflow for a single harnext stage — triggering on the stage label,
 * running the configured agent with the stage prompt, and owning the full
 * label transition (success or failure).
 *
 * Keeping every prompt in one file means the catalog stays tidy: adding a
 * new coding agent is one entry in `WORKFLOW_PROMPT_BUNDLES`, and the
 * generator needs no changes.
 */

import type { CodingAgentId } from './coding-agents.js';
import type { ReviewLoopStage, NormalStage, StageMode } from './github-connection.js';

/**
 * Everything the generator needs to describe a single stage to the coding
 * agent so it can produce a correct workflow. One of `normal`-shaped fields
 * or review-loop fields is populated based on `stage.kind`.
 */
export interface StageWorkflowInput {
  stage:
    | {
        kind: 'normal';
        id: string;
        label: string;
        prompt: string;
        mode: StageMode;
      }
    | {
        kind: 'review-loop';
        id: string;
        label: string;
        reviewPrompt: string;
        fixPrompt: string;
        maxIterations: number;
        onExit: StageMode;
      };
  /** `owner/name`. */
  repo: string;
  /** Label to apply on success; undefined = terminal stage (just remove). */
  nextLabel?: string;
  /** Always `harnext:awaiting-approval`. Included so the prompt is self-contained. */
  awaitingLabel: string;
  /** Always `harnext:needs-judgment`. */
  needsJudgmentLabel: string;
  /**
   * Filename (basename) of the next stage's workflow to dispatch via
   * `gh workflow run` after this stage adds the next-stage label.
   *
   * Why this exists: GitHub suppresses `labeled` events when the label
   * was added via `GITHUB_TOKEN` (infinite-loop guard), so a yolo
   * chain from one generated workflow to another *will not advance*
   * on label-add alone. The current workflow must explicitly dispatch
   * the next one.
   *
   * Absent when: this is a terminal stage, the current stage is
   * human-approval (transition goes to awaiting-approval, not next
   * stage), or the next stage runs locally (the cron poller will pick
   * up the label on its next tick).
   */
  nextWorkflowFilename?: string;
  /**
   * Which event the workflow should trigger on.
   *  - `issues` for issue-only stages (triage, plan)
   *  - `pull_request` for PR-only stages (verify, review)
   *  - `both` when the stage can fire for either (implement during
   *    issue→PR handoff)
   *  - `pr-merged` for terminal post-merge stages (doc-gardening) that
   *    fire on `pull_request.closed` filtered to `merged == true`. These
   *    stages have no label cascade — no transitions, no PR handoff,
   *    no next-stage dispatch.
   */
  triggerOn: 'issues' | 'pull_request' | 'both' | 'pr-merged';
  /** The coding agent that will run inside the workflow (same binary as the bundle). */
  codingAgent: CodingAgentId;
  /** Model id if the agent needs one (claude-code, codex). */
  codingAgentModel?: string;
  /** Absolute path the agent must write the YAML to. */
  workflowPath: string;
  /**
   * YAML fragment for `runs-on:` — already formatted as either
   * `ubuntu-latest` (GitHub-hosted) or a label array like
   * `['self-hosted', 'harnext', 'harnext-<projectHash>']`. The generator
   * computes this from the stage runner so prompts don't have to know
   * about runner shapes.
   */
  runsOnYaml: string;
  /**
   * For review-loop stages, indicates which workflow file is being
   * generated. The pair pattern (review entry + fix companion) is
   * deliberate — one workflow per phase keeps GitHub Actions logs
   * one-job-one-purpose and lets a human interrupt the loop by simply
   * removing the loop label or the iter counter label.
   *
   * Only set when stage.kind === 'review-loop'.
   */
  phase?: 'review' | 'fix';
  /**
   * Filename (basename) of the companion workflow in a review-loop pair.
   * Required when `phase` is set:
   *  - phase='review' → companion is the fix workflow that this review
   *    workflow dispatches when the verdict is changes_requested.
   *  - phase='fix'    → companion is the review workflow that this fix
   *    workflow dispatches after pushing fixup commits.
   */
  companionWorkflowFilename?: string;
}

export interface WorkflowPromptBundle {
  /** Public docs URL — the agent can fetch it if the embedded reference isn't enough. */
  docsUrl: string;
  /** Inline reference YAML embedded in the prompt so the agent has a concrete template. */
  referenceYaml: string;
  /** Build the full prompt sent to the coding agent. */
  buildGeneratorPrompt(input: StageWorkflowInput): string;
}

// ── Shared prompt scaffolding ───────────────────────────────────────

function reviewIterLabelPrefix(stageId: string): string {
  return `harnext:${stageId}-iter-`;
}

function transitionSpec(input: StageWorkflowInput): string {
  if (input.stage.kind === 'review-loop') {
    return input.phase === 'fix'
      ? fixPhaseTransitionSpec(input)
      : reviewPhaseTransitionSpec(input);
  }
  if (input.triggerOn === 'pr-merged') {
    // Post-merge terminal stages own no labels and dispatch nothing —
    // the merged PR is closed, the pipeline is over. The agent's job is
    // a self-contained side-effect (e.g. opening a doc-update PR).
    return [
      '- Post-merge terminal stage: NO label transitions on success.',
      '- Do NOT add or remove any harnext:* labels on the merged PR.',
      '- Do NOT dispatch any other workflow.',
      `- On agent failure, post a single PR comment on the merged PR noting the failure ("${input.stage.label} failed: <one-line>").`,
      '  Do NOT add `' + input.needsJudgmentLabel + '` — there is no labeled-cascade owner for this stage.',
    ].join('\n');
  }
  const mode = input.stage.mode;
  const lines: string[] = [];
  lines.push(`- On agent success, remove the stage label "${input.stage.label}".`);
  if (mode === 'human-approval') {
    lines.push(`- Then add "${input.awaitingLabel}" so a human can review and advance the pipeline.`);
  } else if (input.nextLabel) {
    lines.push(`- Then add the next stage label "${input.nextLabel}" to chain into the next stage.`);
  } else {
    lines.push('- This is the terminal stage — no follow-up label to add.');
  }
  lines.push(
    `- On agent failure (any non-zero exit, including timeouts), remove "${input.stage.label}" and add "${input.needsJudgmentLabel}".`,
  );
  return lines.join('\n');
}

/**
 * Transition spec for the **review** workflow in a review-loop pair. After
 * the reviewer agent finishes the workflow MUST run a deterministic step
 * that reads the latest PR review verdict + the iteration counter label and
 * takes exactly one of four actions. The actions are spelled out so the
 * generated YAML is consistent across agents — this logic is the safety
 * gate for the loop and we don't want it phrased differently each run.
 */
function reviewPhaseTransitionSpec(input: StageWorkflowInput): string {
  if (input.stage.kind !== 'review-loop') {
    throw new Error('reviewPhaseTransitionSpec called on non-review-loop stage');
  }
  const stage = input.stage;
  const iterPrefix = reviewIterLabelPrefix(stage.id);
  const fixFilename = input.companionWorkflowFilename;
  const onExit = stage.onExit;
  const lines: string[] = [];
  lines.push('After the reviewer agent step, this workflow MUST include a deterministic');
  lines.push('"loop control" step that runs the decision tree below. Implement it as a');
  lines.push('single bash step using `gh` API calls. NUM is the PR number, available as:');
  lines.push('  NUM: ${{ github.event.pull_request.number || inputs.issue_number }}');
  lines.push('');
  lines.push(`Iteration counter is a PR label "${iterPrefix}<N>" where N starts at 1.`);
  lines.push('Read it like this (default 1 when no such label exists):');
  lines.push('  labels=$(gh api "repos/${{ github.repository }}/issues/$NUM/labels" --jq \'.[].name\')');
  lines.push(
    `  iter=$(printf '%s\\n' "$labels" | grep -oE '^${iterPrefix}[0-9]+$' | head -n1 | grep -oE '[0-9]+$' || echo "")`,
  );
  lines.push('  if [ -z "$iter" ]; then iter=1; fi');
  lines.push('');
  lines.push('Latest PR review verdict (after the reviewer agent posts its review):');
  lines.push(
    '  state=$(gh api "repos/${{ github.repository }}/pulls/$NUM/reviews" --jq \'.[].state\' | tail -n1)',
  );
  lines.push('  Possible values: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING, or empty.');
  lines.push('');
  lines.push(`Decision tree — run in order, first match wins (max iterations: ${stage.maxIterations}):`);
  lines.push('');
  lines.push(`  A. state == CHANGES_REQUESTED AND iter < ${stage.maxIterations}:`);
  lines.push(`       gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${iterPrefix}$iter" || true`);
  lines.push('       next=$((iter + 1))');
  lines.push(`       gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${iterPrefix}$next"`);
  if (fixFilename) {
    lines.push(`       gh workflow run "${fixFilename}" --field issue_number="$NUM"`);
  }
  lines.push(`     Do NOT remove the loop label "${stage.label}". Do NOT do onExit handoff.`);
  lines.push('     Do NOT add awaiting-approval or any next-stage label.');
  lines.push('');
  lines.push(`  B. state == CHANGES_REQUESTED AND iter >= ${stage.maxIterations}:`);
  lines.push(`       gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${iterPrefix}$iter" || true`);
  lines.push(`       gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${stage.label}" || true`);
  lines.push(
    `       gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${input.needsJudgmentLabel}"`,
  );
  lines.push('     Loop budget exhausted — do NOT dispatch the fix workflow.');
  lines.push('');
  lines.push('  C. state is APPROVED / COMMENTED / DISMISSED / PENDING / empty:');
  lines.push(`       gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${iterPrefix}$iter" || true`);
  lines.push(`       gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${stage.label}" || true`);
  if (onExit === 'human-approval') {
    lines.push(
      `       gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${input.awaitingLabel}"`,
    );
  } else if (input.nextLabel) {
    lines.push(
      `       gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${input.nextLabel}"`,
    );
    if (input.nextWorkflowFilename) {
      lines.push(
        `       gh workflow run "${input.nextWorkflowFilename}" --field issue_number="$NUM" || true`,
      );
    }
  } else {
    lines.push('       (terminal stage — no follow-up label to add.)');
  }
  lines.push('     Do NOT dispatch the fix workflow.');
  lines.push('');
  lines.push('On reviewer agent failure (non-zero exit / timeout) — guard with `if: failure()`:');
  lines.push(`     gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${iterPrefix}$iter" || true`);
  lines.push(`     gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${stage.label}" || true`);
  lines.push(
    `     gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${input.needsJudgmentLabel}"`,
  );
  lines.push('');
  lines.push('Replace `{repo}` in the snippets above with `${{ github.repository }}` in the YAML.');
  return lines.join('\n');
}

/**
 * Transition spec for the **fix** workflow in a review-loop pair. The fix
 * workflow only does two things: run the fixer agent (which pushes
 * commits) and, on success, dispatch the review workflow back to
 * re-evaluate. It does not touch the iteration counter or the loop label
 * — the review workflow owns all loop-control transitions.
 */
function fixPhaseTransitionSpec(input: StageWorkflowInput): string {
  if (input.stage.kind !== 'review-loop') {
    throw new Error('fixPhaseTransitionSpec called on non-review-loop stage');
  }
  const stage = input.stage;
  const iterPrefix = reviewIterLabelPrefix(stage.id);
  const reviewFilename = input.companionWorkflowFilename;
  const lines: string[] = [];
  lines.push('On fixer agent success — guard with `if: success()`:');
  if (reviewFilename) {
    lines.push(
      `  gh workflow run "${reviewFilename}" --field issue_number="$NUM"`,
    );
    lines.push('  This re-runs the review workflow against the freshly-pushed commits.');
  } else {
    lines.push('  (No companion review workflow filename was provided — verify generator wiring.)');
  }
  lines.push(
    '  Do NOT modify the iteration counter label or the loop label. The review workflow',
  );
  lines.push('  owns those transitions; the fix workflow is just the implementer.');
  lines.push('');
  lines.push('On fixer agent failure (non-zero exit / timeout) — guard with `if: failure()`:');
  lines.push(`  iter=$(gh api "repos/{repo}/issues/$NUM/labels" --jq '.[].name' | \\`);
  lines.push(`        grep -oE '^${iterPrefix}[0-9]+$' | head -n1 || echo "")`);
  lines.push(`  if [ -n "$iter" ]; then`);
  lines.push(`    gh api -X DELETE "repos/{repo}/issues/$NUM/labels/$iter" || true`);
  lines.push(`  fi`);
  lines.push(`  gh api -X DELETE "repos/{repo}/issues/$NUM/labels/${stage.label}" || true`);
  lines.push(
    `  gh api -X POST "repos/{repo}/issues/$NUM/labels" -f labels[]="${input.needsJudgmentLabel}"`,
  );
  lines.push('  Do NOT dispatch the review workflow.');
  lines.push('');
  lines.push('NUM is the PR number: ${{ github.event.pull_request.number || inputs.issue_number }}');
  lines.push('Replace `{repo}` in the snippets above with `${{ github.repository }}` in the YAML.');
  return lines.join('\n');
}

function triggerSpec(input: StageWorkflowInput): string {
  if (input.stage.kind === 'review-loop' && input.phase === 'fix') {
    // Fix is dispatch-only: it never fires from a `labeled` event because
    // there is no "fix label" — review dispatches it explicitly.
    return 'on.workflow_dispatch ONLY (no `issues:` or `pull_request:` triggers — fix is dispatch-only)';
  }
  switch (input.triggerOn) {
    case 'issues':
      return 'on.issues.types: [labeled]';
    case 'pull_request':
      return 'on.pull_request.types: [labeled]';
    case 'both':
      return 'on.issues.types: [labeled] AND on.pull_request.types: [labeled]';
    case 'pr-merged':
      // Post-merge terminal stage. Fires when a PR closes; the job guard
      // narrows further to `merged == true` so PRs that close without
      // merging do not trigger the agent.
      return 'on.pull_request.types: [closed]';
  }
}

/**
 * Resolve `$ISSUE_NUMBER` / `$PR_NUMBER` style placeholders in a stage
 * prompt to the equivalent GitHub Actions expression, so the real number
 * reaches the claude-code-action `prompt:` field.
 *
 * Why this exists: stage prompts are authored by the code-analysis
 * pipeline as human-readable Markdown with shell-style placeholders
 * (`$ISSUE_NUMBER`, `${ISSUE_NUMBER}`, `$PR_NUMBER`, `${PR_NUMBER}`).
 * The `prompt:` field on `anthropics/claude-code-action@v1` is a plain
 * YAML string — it does NOT run through a shell, so `$VAR` stays
 * literal. When the workflow triggers via `workflow_dispatch` (the
 * normal case once dispatch-chaining is in use), there is no
 * `github.event.issue` payload for the action to fall back on, so the
 * agent has no idea what issue it is working on.
 *
 * The fix: substitute at YAML-embed time with the full fallback chain
 * — issue event → PR event → workflow_dispatch input — so the same
 * expression works on every trigger path. PR number and issue number
 * share the expression because we reuse a single `issue_number` input
 * across issue/PR dispatches (the harness never needs them
 * simultaneously in one run).
 *
 * Caught live on flowhunt's urlslab-app issue #5336: triage worked
 * because `issues.labeled` gave the action issue context, but implement
 * (dispatched via workflow_dispatch from plan) no-op'd — the prompt
 * literally read `gh issue view $ISSUE_NUMBER` with nothing to expand.
 */
const ISSUE_NUMBER_EXPR =
  '${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}';

export function substituteIssueNumberPlaceholders(prompt: string): string {
  return prompt
    .replace(/\$\{ISSUE_NUMBER\}/g, ISSUE_NUMBER_EXPR)
    .replace(/\$ISSUE_NUMBER\b/g, ISSUE_NUMBER_EXPR)
    .replace(/\$\{PR_NUMBER\}/g, ISSUE_NUMBER_EXPR)
    .replace(/\$PR_NUMBER\b/g, ISSUE_NUMBER_EXPR);
}

function stagePromptBlock(input: StageWorkflowInput): string {
  if (input.stage.kind === 'normal') {
    return [
      'Stage prompt to hand the agent verbatim:',
      '----- BEGIN STAGE PROMPT -----',
      substituteIssueNumberPlaceholders(input.stage.prompt),
      '----- END STAGE PROMPT -----',
    ].join('\n');
  }
  if (input.phase === 'review') {
    return [
      'Review-loop **review phase** — this workflow runs the reviewer agent and,',
      'after the agent finishes, runs the deterministic loop-control step from the',
      'transition spec (which decides whether to dispatch the companion fix',
      'workflow or terminate the loop). Do not run the fixer agent here.',
      '',
      'Reviewer prompt to hand the agent verbatim:',
      '----- BEGIN REVIEWER PROMPT -----',
      substituteIssueNumberPlaceholders(input.stage.reviewPrompt),
      '----- END REVIEWER PROMPT -----',
    ].join('\n');
  }
  if (input.phase === 'fix') {
    return [
      'Review-loop **fix phase** — this workflow runs ONLY the fixer agent (which',
      'addresses the most recent review feedback by pushing commits to the PR',
      'branch), then dispatches the companion review workflow back to re-evaluate.',
      'Do not run the reviewer agent here, do not parse review verdicts, do not',
      'modify the iteration counter or the loop label.',
      '',
      'Fixer prompt to hand the agent verbatim:',
      '----- BEGIN FIXER PROMPT -----',
      substituteIssueNumberPlaceholders(input.stage.fixPrompt),
      '----- END FIXER PROMPT -----',
    ].join('\n');
  }
  throw new Error(
    `review-loop stage requires phase='review' or 'fix' on the workflow input (got ${String(input.phase)})`,
  );
}

function prHandoffSpec(): string {
  return [
    'If the stage runs on an issue and the agent opens a pull request, hand the',
    'pipeline over to that PR instead of keeping it on the issue:',
    '  - detect the new PR by (a) the branch the agent used, (b) the issue timeline',
    '    for cross-referenced PRs, or (c) a PR URL in the agent output.',
    '  - on the ISSUE: remove the stage label, add the awaiting-approval label.',
    '  - on the PR: add whichever follow-up label the success path would have added.',
  ].join('\n');
}

/**
 * Short description of the secret/auth setup the workflow should assume,
 * keyed off the coding agent. Claude Code defaults to OAuth via the GitHub
 * App because it bills against the user's Claude subscription — materially
 * cheaper than the metered Anthropic API key path for most users.
 */
function secretsSpec(agent: CodingAgentId): string {
  switch (agent) {
    case 'claude-code':
      return [
        'Authenticate via the Claude Code GitHub App using OAuth:',
        '  claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
        'Do NOT use anthropic_api_key / ANTHROPIC_API_KEY — OAuth is the default,',
        "bills against the user's Claude Pro/Max subscription, and is cheaper than",
        'metered API usage. The Anthropic API key path is explicitly out of scope here.',
      ].join('\n');
    case 'codex':
      return 'Read the OpenAI API key from ${{ secrets.OPENAI_API_KEY }}.';
    case 'harnext':
      return [
        'Read the provider API key harnext needs from repo secrets:',
        '  ANTHROPIC_API_KEY by default, OPENAI_API_KEY / GOOGLE_API_KEY / etc.',
        "if the user's selected provider requires a different key.",
      ].join('\n');
  }
}

function commonRequirements(input: StageWorkflowInput): string {
  const isReviewLoop = input.stage.kind === 'review-loop';
  const isPrMerged = input.triggerOn === 'pr-merged';
  const phaseSuffix = isReviewLoop ? `-${input.phase ?? 'review'}` : '';
  const concurrencyGroup = `harnext-${input.stage.id}${phaseSuffix}-\${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}`;
  let guardLine: string;
  if (isReviewLoop && input.phase === 'fix') {
    guardLine = `2. Guard the job with: if: github.event_name == 'workflow_dispatch' (the fix workflow never fires from a labeled event).`;
  } else if (isPrMerged) {
    // Post-merge stages MUST narrow `pull_request.closed` to merged-only,
    // otherwise the agent runs on every closed-without-merging PR too.
    guardLine = `2. Guard the job with: if: github.event.pull_request.merged == true (skip closed-without-merge PRs entirely).`;
  } else {
    guardLine = `2. Guard the job with: if: github.event_name == 'workflow_dispatch' || github.event.label.name == '${input.stage.label}'`;
  }
  const triggerLine = isPrMerged
    ? `1. Trigger on ${triggerSpec(input)}. Do NOT add a workflow_dispatch trigger — post-merge stages are not part of any chain.`
    : `1. Trigger on ${triggerSpec(input)}. Always include a workflow_dispatch trigger with a string\n   \`issue_number\` input alongside any labeled trigger so chained dispatches work.`;
  const lines: string[] = [
    `Write ONE file at exactly: ${input.workflowPath}`,
    'Do not modify any other file. Do not commit or push. Do not create branches.',
    '',
    'The workflow YAML must:',
    triggerLine,
    guardLine,
    `3. Set concurrency.group to: ${concurrencyGroup}`,
    '   and concurrency.cancel-in-progress: false.',
    `4. Use \`runs-on: ${input.runsOnYaml}\` EXACTLY (do not substitute ubuntu-latest if a label`,
    '   array is specified — that array targets the user\'s self-hosted runner, and using',
    '   `ubuntu-latest` instead would silently re-route the job to a GitHub-hosted runner).',
    '5. Check out the repository with fetch-depth: 0.',
    '6. Run the configured coding agent against the stage prompt below.',
    secretsSpec(input.codingAgent)
      .split('\n')
      .map((line) => '   ' + line)
      .join('\n'),
    isPrMerged
      ? '7. Post-merge stage — there are no label transitions to perform:'
      : '7. Perform the label transition below via `gh` API calls:',
    transitionSpec(input),
  ];
  // PR-handoff only applies to issue-triggered stages that may open a PR
  // mid-flight. Review-loop and pr-merged stages already operate on a
  // PR — including the handoff guidance just confuses the model.
  if (!isReviewLoop && !isPrMerged) {
    lines.push('');
    lines.push(prHandoffSpec());
  }
  lines.push('');
  lines.push(stagePromptBlock(input));
  return lines.join('\n');
}

/**
 * Apply the per-stage substitutions the reference YAMLs carry as
 * placeholder tokens. Currently just `<RUNS_ON>` — kept as a function so
 * future placeholders (e.g. concurrency group overrides) plug in here.
 */
function applyReferenceSubstitutions(reference: string, input: StageWorkflowInput): string {
  return reference.replace(/<RUNS_ON>/g, input.runsOnYaml);
}

/**
 * Tool allowlist to bake into `claude_args` for a given stage. The
 * claude-code-action denies ALL tool calls by default — forgetting this
 * turns every Edit/Write/Bash into a silent permission-denied, which is
 * indistinguishable from a stage that just chose not to write anything.
 * Pin read-only stages to Read,Glob,Grep,Bash and add Edit,Write for
 * stages that have to change code (including the fix phase of a
 * review-loop, which pushes commits to the PR branch).
 */
function claudeCodeToolAllowlist(input: StageWorkflowInput): string {
  if (input.stage.kind === 'review-loop') {
    return input.phase === 'fix' ? 'Read,Glob,Grep,Bash,Edit,Write' : 'Read,Glob,Grep,Bash';
  }
  const writeStages = new Set(['implement', 'fix', 'verify']);
  return writeStages.has(input.stage.id)
    ? 'Read,Glob,Grep,Bash,Edit,Write'
    : 'Read,Glob,Grep,Bash';
}

// ── claude-code bundle ──────────────────────────────────────────────

const CLAUDE_CODE_REFERENCE = `name: Claude Code
# IMPORTANT: workflow_dispatch is required alongside the labeled trigger
# because GitHub suppresses \`issues.labeled\` / \`pull_request.labeled\` events
# when the label was added via GITHUB_TOKEN (infinite-loop guard). Any
# workflow in this pipeline that is handed off to from another workflow
# must accept \`gh workflow run\` dispatches with a number input.
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue or PR number to run this stage on'
        required: true
        type: string

jobs:
  claude:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.label.name == 'harnext:<STAGE_ID>'
    runs-on: <RUNS_ON>
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: write
    concurrency:
      group: harnext-<STAGE_ID>-\${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Run Claude Code
        id: claude
        uses: anthropics/claude-code-action@v1
        with:
          # OAuth via the Claude Code GitHub App — usage counts against the
          # user's Claude subscription (Pro/Max), not metered API billing.
          # Do not swap to the API-key auth input unless the user opts in.
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            <STAGE_PROMPT_GOES_HERE>
          # --allowedTools is REQUIRED. The action denies ALL tool calls by
          # default; any Edit/Write/Bash call without this allowlist will be
          # permission-denied silently. Use "Read,Glob,Grep,Bash" for
          # read-only stages and add Edit,Write for stages that change code.
          claude_args: '--model <MODEL_ID> --max-turns 60 --allowedTools "<TOOL_LIST>"'
          # Needed when another workflow dispatches this one via
          # \`gh workflow run\` — the actor becomes github-actions[bot] and
          # the action rejects bot actors unless listed here.
          allowed_bots: 'github-actions'
      - name: Transition labels on success
        if: success()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NUM: \${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}
        run: |
          gh api -X DELETE repos/\${{ github.repository }}/issues/$NUM/labels/harnext:<STAGE_ID>
          # For a yolo chain: add <NEXT_LABEL> AND dispatch the next
          # workflow. Label-add alone is NOT enough — labels added via
          # GITHUB_TOKEN do not fire \`labeled\` events, so the next
          # workflow's \`issues.labeled\` trigger stays silent and the
          # chain stalls. The \`|| true\` tolerates the case where the
          # next stage is actually local (no workflow file exists).
          gh api -X POST repos/\${{ github.repository }}/issues/$NUM/labels \\
            -f labels[]=<NEXT_LABEL>
          gh workflow run <NEXT_WORKFLOW_FILENAME> \\
            --field issue_number=$NUM || true
          # For human-approval mode: add <AWAITING_LABEL> and stop —
          # no dispatch, a human owns the next move.
      - name: Park on needs-judgment on failure
        if: failure()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NUM: \${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}
        run: |
          gh api -X DELETE repos/\${{ github.repository }}/issues/$NUM/labels/harnext:<STAGE_ID> || true
          gh api -X POST repos/\${{ github.repository }}/issues/$NUM/labels -f labels[]=harnext:needs-judgment
      # Optional: if the stage needs to read Claude's textual output (to post
      # a comment, extract a plan, etc.), do it via the execution_file output.
      # The action has NO \`result\` output. execution_file is a JSON array of
      # turn objects — NOT JSONL, do not use \`jq -s\`.
      #   jq -r '[.[] | select(.type == "assistant") | .message.content[] |
      #          select(.type == "text") | .text] | join("\\n")' "$EXECUTION_FILE"
`;

function buildClaudeCodePrompt(input: StageWorkflowInput): string {
  const tools = claudeCodeToolAllowlist(input);
  // Skip the legacy `dispatchConstraint` reminder for review-loop stages —
  // their dispatch logic is fully spelled out in transitionSpec, and adding
  // the same idea twice (with subtly different framing) causes the agent
  // to merge them into one confused step.
  const isReviewLoop = input.stage.kind === 'review-loop';
  const dispatchConstraint = !isReviewLoop && input.nextWorkflowFilename
    ? [
        `  h) After adding \`${input.nextLabel}\` on a successful yolo chain,`,
        '     you MUST also dispatch the next workflow:',
        `       gh workflow run ${input.nextWorkflowFilename} --field issue_number=$NUM || true`,
        '     Label-add alone is not enough — GitHub suppresses `labeled`',
        '     events for labels added via GITHUB_TOKEN, so the next',
        `     workflow (${input.nextWorkflowFilename}) will never fire without`,
        '     an explicit dispatch.',
      ].join('\n')
    : null;
  return [
    'You are generating a GitHub Actions workflow for a single stage of a harnext pipeline.',
    'The workflow will run claude-code (the `anthropics/claude-code-action@v1` action) against a PR or issue.',
    '',
    'Reference workflow to model the shape on (trigger, guard, concurrency, checkout, action usage):',
    '----- BEGIN REFERENCE YAML -----',
    applyReferenceSubstitutions(CLAUDE_CODE_REFERENCE, input),
    '----- END REFERENCE YAML -----',
    '',
    `Target repo: ${input.repo}`,
    `Model to pass via claude_args: ${input.codingAgentModel ?? 'claude-opus-4-7'}`,
    `Tool allowlist to pass via claude_args --allowedTools: ${tools}`,
    '',
    'Requirements for the workflow file you produce:',
    commonRequirements(input),
    '',
    'Use `anthropics/claude-code-action@v1` exactly. Inline the stage prompt into the action\'s `prompt:` block.',
    '',
    'Hard constraints that must be present in the final YAML:',
    '  a) Authenticate ONLY via `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.',
    '     Do not emit `anthropic_api_key` or reference `ANTHROPIC_API_KEY` anywhere in the file.',
    `  b) \`claude_args\` MUST include \`--allowedTools "${tools}"\` (and \`--model ${input.codingAgentModel ?? 'claude-opus-4-7'}\`).`,
    '     The action denies ALL tool calls by default; omitting this silently breaks every Bash/Edit/Write.',
    '  c) Set `allowed_bots: \'github-actions\'` on the claude-code-action step.',
    '     When another workflow hands off to this one via `gh workflow run`, the actor',
    '     becomes github-actions[bot], which the action rejects unless allowlisted.',
    isReviewLoop && input.phase === 'fix'
      ? [
          '  d) Triggers: `workflow_dispatch` ONLY. Do NOT include `issues:` or',
          '     `pull_request:` triggers — the fix workflow is invoked exclusively',
          '     from the review workflow via `gh workflow run`. Define an `issue_number`',
          '     string input. The job guard should be:',
          '         `if: github.event_name == \'workflow_dispatch\'`',
        ].join('\n')
      : [
          '  d) Add a `workflow_dispatch` trigger alongside the `labeled` trigger, with an',
          '     `issue_number` input. GitHub suppresses `labeled` events for labels added by',
          '     GITHUB_TOKEN, so any chained workflow must accept `gh workflow run` fallbacks.',
          '     The job guard should allow both paths: `github.event_name == \'workflow_dispatch\' || github.event.label.name == \'<stage-label>\'`.',
        ].join('\n'),
    '  e) To read Claude\'s textual output (e.g. post a plan comment), parse the',
    '     `execution_file` output with jq. The action has NO `result` output; the',
    '     file is a JSON ARRAY of turn objects (not JSONL — do NOT use `jq -s`).',
    '  f) If the stage calls `gh pr create --label X`, create label X first with',
    '     `gh label create X ... 2>/dev/null || true`; `gh pr create --label` fails',
    '     when the label does not yet exist.',
    '  g) Job permissions must cover what this stage does: at minimum `issues: write`,',
    '     `contents: read` (or `write` for stages that push), `actions: write` when the',
    '     stage dispatches another workflow, and `id-token: write` for OAuth exchange.',
    '  i) Preserve every `${{ … }}` expression you see inside the embedded stage prompt',
    '     EXACTLY as given — specifically the issue-number expression',
    '     `${{ github.event.issue.number || github.event.pull_request.number || inputs.issue_number }}`.',
    '     Do not rewrite it, simplify it, or replace it with `$ISSUE_NUMBER`. The agent',
    '     running the stage needs the resolved number — a literal `$ISSUE_NUMBER` in',
    '     the `prompt:` field is NOT expanded by the claude-code-action.',
    ...(dispatchConstraint ? [dispatchConstraint] : []),
    '',
    'Use the GH_TOKEN from secrets.GITHUB_TOKEN for label transitions and gh CLI calls.',
    '',
    'Produce only the YAML file at the path above. No prose commentary.',
  ].join('\n');
}

// ── codex bundle ────────────────────────────────────────────────────

const CODEX_REFERENCE = `name: Codex
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]

jobs:
  codex:
    if: github.event.label.name == 'harnext:<STAGE_ID>'
    runs-on: <RUNS_ON>
    permissions:
      contents: write
      pull-requests: write
      issues: write
    concurrency:
      group: harnext-<STAGE_ID>-\${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Run Codex
        uses: openai/codex-action@latest
        with:
          openai_api_key: \${{ secrets.OPENAI_API_KEY }}
          model: <MODEL_ID>
          prompt: |
            <STAGE_PROMPT_GOES_HERE>
      # label-transition steps follow, same shape as the claude-code reference
`;

function buildCodexPrompt(input: StageWorkflowInput): string {
  return [
    'You are generating a GitHub Actions workflow for a single stage of a harnext pipeline.',
    'The workflow will run codex (OpenAI\'s Codex CLI via the official Codex GitHub Action).',
    '',
    `Authoritative docs: https://developers.openai.com/codex/github-action`,
    'Fetch the page if the reference below is insufficient.',
    '',
    'Rough reference shape:',
    '----- BEGIN REFERENCE YAML -----',
    applyReferenceSubstitutions(CODEX_REFERENCE, input),
    '----- END REFERENCE YAML -----',
    '',
    `Target repo: ${input.repo}`,
    `Model to pass to codex: ${input.codingAgentModel ?? 'gpt-5.3-codex'}`,
    '',
    'Requirements for the workflow file you produce:',
    commonRequirements(input),
    '',
    'Use the openai/codex-action (latest stable tag). Inline the stage prompt into the action\'s',
    '`prompt:` block. Use GH_TOKEN from secrets.GITHUB_TOKEN for label transitions.',
    '',
    'Produce only the YAML file at the path above. No prose commentary.',
  ].join('\n');
}

// ── harnext bundle ──────────────────────────────────────────────────

const HARNEXT_REFERENCE = `name: harnext stage
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]

jobs:
  harnext:
    if: github.event.label.name == 'harnext:<STAGE_ID>'
    runs-on: <RUNS_ON>
    permissions:
      contents: write
      pull-requests: write
      issues: write
    concurrency:
      group: harnext-<STAGE_ID>-\${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install harnext CLI
        run: npm i -g harnext
      - name: Run stage
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          harnext -p --prompt "<STAGE_PROMPT_GOES_HERE>"
      # label-transition steps follow, same shape as the claude-code reference
`;

function buildHarnextPrompt(input: StageWorkflowInput): string {
  return [
    'You are generating a GitHub Actions workflow for a single stage of a harnext pipeline.',
    'The workflow will run the harnext CLI (the in-process pi-agent-core runtime) in one-shot mode.',
    '',
    'Approach:',
    '  1. Install Node.js 20 and `npm i -g harnext`.',
    '  2. Export the relevant provider API key from repo secrets (ANTHROPIC_API_KEY by default;',
    '     OPENAI_API_KEY, GOOGLE_API_KEY, etc. as appropriate for the chosen provider).',
    '  3. Invoke `harnext -p --prompt "..."` with the stage prompt inlined.',
    '     Note: a dedicated `harnext run-stage <id>` one-shot subcommand is planned but',
    '     not yet shipped — the `-p --prompt` form works today.',
    '',
    'Rough reference shape:',
    '----- BEGIN REFERENCE YAML -----',
    applyReferenceSubstitutions(HARNEXT_REFERENCE, input),
    '----- END REFERENCE YAML -----',
    '',
    `Target repo: ${input.repo}`,
    '',
    'Requirements for the workflow file you produce:',
    commonRequirements(input),
    '',
    'Use GH_TOKEN from secrets.GITHUB_TOKEN for label transitions.',
    '',
    'Produce only the YAML file at the path above. No prose commentary.',
  ].join('\n');
}

// ── Bundle registry ─────────────────────────────────────────────────

export const WORKFLOW_PROMPT_BUNDLES: Record<CodingAgentId, WorkflowPromptBundle> = {
  'claude-code': {
    docsUrl: 'https://github.com/anthropics/claude-code-action',
    referenceYaml: CLAUDE_CODE_REFERENCE,
    buildGeneratorPrompt: buildClaudeCodePrompt,
  },
  codex: {
    docsUrl: 'https://developers.openai.com/codex/github-action',
    referenceYaml: CODEX_REFERENCE,
    buildGeneratorPrompt: buildCodexPrompt,
  },
  harnext: {
    docsUrl: 'https://www.npmjs.com/package/harnext',
    referenceYaml: HARNEXT_REFERENCE,
    buildGeneratorPrompt: buildHarnextPrompt,
  },
};

/**
 * Shape a stage entry into the `StageWorkflowInput.stage` discriminated
 * object. Pulled out so the setup wizard and tests share one conversion
 * path.
 */
export function toStageWorkflowStage(
  stage: NormalStage | ReviewLoopStage,
): StageWorkflowInput['stage'] {
  if (stage.kind === 'review-loop') {
    return {
      kind: 'review-loop',
      id: stage.id,
      label: stage.label,
      reviewPrompt: stage.review.prompt,
      fixPrompt: stage.fix.prompt,
      maxIterations: stage.maxIterations,
      onExit: stage.onExit,
    };
  }
  return {
    kind: 'normal',
    id: stage.id,
    label: stage.label,
    prompt: stage.prompt,
    mode: stage.mode,
  };
}
