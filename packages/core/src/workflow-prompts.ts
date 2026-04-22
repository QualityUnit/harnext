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

function stagePromptBlock(input: StageWorkflowInput): string {
  if (input.stage.kind === 'normal') {
    return [
      'Stage prompt to hand the agent verbatim:',
      '----- BEGIN STAGE PROMPT -----',
      input.stage.prompt,
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
    input.stage.reviewPrompt,
    '----- END REVIEWER PROMPT -----',
    '',
    'Fixer prompt:',
    '----- BEGIN FIXER PROMPT -----',
    input.stage.fixPrompt,
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
    '5. Run the configured coding agent against the stage prompt below. Read API keys',
    '   from repo secrets (ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. as the agent needs).',
    '6. Perform the label transition below via `gh` API calls:',
    transitionSpec(input),
    '',
    prHandoffSpec(),
    '',
    stagePromptBlock(input),
  ].join('\n');
}

// ── claude-code bundle ──────────────────────────────────────────────

const CLAUDE_CODE_REFERENCE = `name: Claude Code
on:
  issues:
    types: [labeled]
  pull_request:
    types: [labeled]

jobs:
  claude:
    if: >-
      github.event.label.name == 'harnext:<STAGE_ID>'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    concurrency:
      group: harnext-<STAGE_ID>-\${{ github.event.issue.number || github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Run Claude Code
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            <STAGE_PROMPT_GOES_HERE>
          claude_args: '--model <MODEL_ID>'
      - name: Transition labels on success
        if: success()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NUM: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          gh api -X DELETE repos/\${{ github.repository }}/issues/$NUM/labels/harnext:<STAGE_ID>
          # then gh api -X POST ... to add <NEXT_LABEL> or <AWAITING_LABEL>
      - name: Park on needs-judgment on failure
        if: failure()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NUM: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          gh api -X DELETE repos/\${{ github.repository }}/issues/$NUM/labels/harnext:<STAGE_ID> || true
          gh api -X POST repos/\${{ github.repository }}/issues/$NUM/labels -f labels[]=harnext:needs-judgment
`;

function buildClaudeCodePrompt(input: StageWorkflowInput): string {
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
    '',
    'Requirements for the workflow file you produce:',
    commonRequirements(input),
    '',
    'Use anthropics/claude-code-action@v1 exactly. Inline the stage prompt into the action\'s `prompt:` block.',
    'Use the GH_TOKEN from secrets.GITHUB_TOKEN for label transitions.',
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
