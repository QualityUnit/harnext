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
   * Which event the workflow should trigger on. `issues` for issue-only
   * stages (triage, plan), `pull_request` for PR-only stages (verify,
   * review), `both` when the stage can fire for either (implement during
   * local→PR handoff).
   */
  triggerOn: 'issues' | 'pull_request' | 'both';
  /** The coding agent that will run inside the workflow (same binary as the bundle). */
  codingAgent: CodingAgentId;
  /** Model id if the agent needs one (claude-code, codex). */
  codingAgentModel?: string;
  /** Absolute path the agent must write the YAML to. */
  workflowPath: string;
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

function transitionSpec(input: StageWorkflowInput): string {
  const mode =
    input.stage.kind === 'normal' ? input.stage.mode : input.stage.onExit;
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

function triggerSpec(triggerOn: 'issues' | 'pull_request' | 'both'): string {
  switch (triggerOn) {
    case 'issues':
      return 'on.issues.types: [labeled]';
    case 'pull_request':
      return 'on.pull_request.types: [labeled]';
    case 'both':
      return 'on.issues.types: [labeled] AND on.pull_request.types: [labeled]';
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
  return [
    'Review-loop stage — two prompts to hand the agent within one run.',
    `Loop up to ${input.stage.maxIterations} times: run reviewer, if the`,
    'review verdict is `changes_requested` then run fixer and loop; otherwise exit.',
    '',
    'Reviewer prompt:',
    '----- BEGIN REVIEWER PROMPT -----',
    substituteIssueNumberPlaceholders(input.stage.reviewPrompt),
    '----- END REVIEWER PROMPT -----',
    '',
    'Fixer prompt:',
    '----- BEGIN FIXER PROMPT -----',
    substituteIssueNumberPlaceholders(input.stage.fixPrompt),
    '----- END FIXER PROMPT -----',
  ].join('\n');
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
  return [
    `Write ONE file at exactly: ${input.workflowPath}`,
    'Do not modify any other file. Do not commit or push. Do not create branches.',
    '',
    'The workflow YAML must:',
    `1. Trigger on ${triggerSpec(input.triggerOn)}.`,
    `2. Guard the job with: if: github.event.label.name == '${input.stage.label}'`,
    `3. Set concurrency.group to: harnext-${input.stage.id}-\${{ github.event.issue.number || github.event.pull_request.number }}`,
    '   and concurrency.cancel-in-progress: false.',
    '4. Check out the repository with fetch-depth: 0.',
    '5. Run the configured coding agent against the stage prompt below.',
    secretsSpec(input.codingAgent)
      .split('\n')
      .map((line) => '   ' + line)
      .join('\n'),
    '6. Perform the label transition below via `gh` API calls:',
    transitionSpec(input),
    '',
    prHandoffSpec(),
    '',
    stagePromptBlock(input),
  ].join('\n');
}

/**
 * Tool allowlist to bake into `claude_args` for a given stage. The
 * claude-code-action denies ALL tool calls by default — forgetting this
 * turns every Edit/Write/Bash into a silent permission-denied, which is
 * indistinguishable from a stage that just chose not to write anything.
 * Pin read-only stages to Read,Glob,Grep,Bash and add Edit,Write for
 * stages that have to change code.
 */
function claudeCodeToolAllowlist(stageId: string): string {
  const writeStages = new Set(['implement', 'fix', 'verify']);
  return writeStages.has(stageId)
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
    runs-on: ubuntu-latest
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
  const tools = claudeCodeToolAllowlist(input.stage.id);
  const dispatchConstraint = input.nextWorkflowFilename
    ? [
        `  h) After adding \`${input.nextLabel}\` on a successful yolo chain,`,
        '     you MUST also dispatch the next workflow:',
        `       gh workflow run ${input.nextWorkflowFilename} --field issue_number=$NUM || true`,
        '     Label-add alone is not enough — GitHub suppresses `labeled`',
        '     events for labels added via GITHUB_TOKEN, so the next',
        `     workflow (${input.nextWorkflowFilename}) will never fire without`,
        '     an explicit dispatch. The `|| true` tolerates the case where the',
        '     next stage is actually local on the user\'s machine — the file',
        '     simply does not exist and the cron poller picks up by label.',
      ].join('\n')
    : null;
  return [
    'You are generating a GitHub Actions workflow for a single stage of a harnext pipeline.',
    'The workflow will run claude-code (the `anthropics/claude-code-action@v1` action) against a PR or issue.',
    '',
    'Reference workflow to model the shape on (trigger, guard, concurrency, checkout, action usage):',
    '----- BEGIN REFERENCE YAML -----',
    CLAUDE_CODE_REFERENCE,
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
    '  d) Add a `workflow_dispatch` trigger alongside the `labeled` trigger, with an',
    '     `issue_number` input. GitHub suppresses `labeled` events for labels added by',
    '     GITHUB_TOKEN, so any chained workflow must accept `gh workflow run` fallbacks.',
    '     The job guard should allow both paths: `github.event_name == \'workflow_dispatch\' || github.event.label.name == \'<stage-label>\'`.',
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
    runs-on: ubuntu-latest
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
    CODEX_REFERENCE,
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
    runs-on: ubuntu-latest
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
    HARNEXT_REFERENCE,
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
