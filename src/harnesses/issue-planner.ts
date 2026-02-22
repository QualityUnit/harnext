import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import type { DetectionResult } from '../core/detector.js';
import { INSTRUCTION_FILES } from '../core/ai-runner.js';
import { buildIssuePlannerPrompt } from '../prompts/issue-planner.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const issuePlannerHarness: HarnessModule = {
  name: 'issue-planner',
  displayName: 'Issue Planner Agent',
  description:
    'Generates a workflow that spawns an AI agent to produce implementation plans for triaged issues',
  order: 15,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;

    const instructionFile = INSTRUCTION_FILES[ctx.runner.platform];

    // 1. Generate reference templates from existing builders
    const refWorkflow = buildIssuePlannerWorkflowYml(detection, instructionFile);
    const refGuard = buildIssuePlannerGuardTs();
    const refPromptMd = buildIssuePlannerPromptMd(instructionFile);

    // 2. Build the prompt with reference context
    const basePrompt = buildIssuePlannerPrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: .github/workflows/issue-planner.yml
\`\`\`yaml
${refWorkflow}
\`\`\`

### Reference: scripts/issue-planner-guard.ts
\`\`\`typescript
${refGuard}
\`\`\`

### Reference: .codefactory/prompts/issue-planner.md
\`\`\`markdown
${refPromptMd}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'issue-planner',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { workflowPath: '.github/workflows/issue-planner.yml' },
      };
      ctx.previousOutputs.set('issue-planner', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Issue planner generation failed: ${message}`);
    }
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveInstallCmd(det: DetectionResult): string {
  if (det.packageManager === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (det.packageManager === 'yarn') return 'yarn install --frozen-lockfile';
  return 'npm ci';
}

function resolveCacheKey(det: DetectionResult): string {
  if (det.packageManager === 'pnpm') return 'pnpm';
  if (det.packageManager === 'yarn') return 'yarn';
  return 'npm';
}

/* eslint-disable no-useless-escape */

function buildIssuePlannerWorkflowYml(det: DetectionResult, instructionFile: string): string {
  const installCmd = resolveInstallCmd(det);
  const cache = resolveCacheKey(det);

  return `name: Issue Planner Agent

on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to plan'
        required: true
        type: string

permissions:
  issues: write
  contents: read
  actions: write
  id-token: write

concurrency:
  group: issue-planner-\${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: true

jobs:
  plan:
    name: Planner Agent
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          fetch-depth: 1

      - name: Setup Node.js
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: 22
          cache: ${cache}

      - name: Install dependencies
        run: ${installCmd}

      - name: Fetch issue JSON (workflow_dispatch)
        if: github.event_name == 'workflow_dispatch'
        id: fetch-issue
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          ISSUE_NUM="\${{ inputs.issue_number }}"
          # gh CLI uses 'author' not 'user' \u2014 remap to match github.event.issue shape
          ISSUE_DATA=$(gh issue view "$ISSUE_NUM" --json number,title,body,labels,author \\
            | jq '{number, title, body, labels, user: {login: .author.login, type: (if .author.is_bot then "Bot" else "User" end)}}')
          {
            echo "json<<ISSUE_EOF"
            echo "$ISSUE_DATA"
            echo "ISSUE_EOF"
          } >> "$GITHUB_OUTPUT"
          echo "Fetched issue #\${ISSUE_NUM}"

      - name: Run planner guard
        id: guard
        env:
          ISSUE_JSON: \${{ github.event_name == 'workflow_dispatch' && steps.fetch-issue.outputs.json || toJSON(github.event.issue) }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          DECISION=$(npx tsx scripts/issue-planner-guard.ts --evaluate)
          echo "decision<<GUARD_EOF" >> "$GITHUB_OUTPUT"
          echo "$DECISION" >> "$GITHUB_OUTPUT"
          echo "GUARD_EOF" >> "$GITHUB_OUTPUT"

          SHOULD=$(echo "$DECISION" | jq -r '.shouldPlan')
          REASON=$(echo "$DECISION" | jq -r '.reason')
          ISSUE_NUM=$(echo "$DECISION" | jq -r '.issueNumber')
          ISSUE_TITLE=$(echo "$DECISION" | jq -r '.issueTitle')
          echo "should-plan=\${SHOULD}" >> "$GITHUB_OUTPUT"
          echo "reason=\${REASON}" >> "$GITHUB_OUTPUT"
          echo "issue-number=\${ISSUE_NUM}" >> "$GITHUB_OUTPUT"
          echo "issue-title=\${ISSUE_TITLE}" >> "$GITHUB_OUTPUT"

          echo "Guard: shouldPlan=\${SHOULD}, issue=#\${ISSUE_NUM}"

      - name: Skip \u2014 log reason
        if: steps.guard.outputs.should-plan == 'false'
        run: |
          echo "::notice::Planning skipped: \${{ steps.guard.outputs.reason }}"

      - name: Ensure planner labels exist
        if: steps.guard.outputs.should-plan == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            const labels = [
              { name: 'agent:plan', color: '1D76DB', description: 'Approved for automated planning' },
              { name: 'agent:implement', color: '0E8A16', description: 'Approved for automated implementation' },
              { name: 'agent:needs-judgment', color: 'E4E669', description: 'Agent needs human judgment to proceed' },
            ];

            for (const label of labels) {
              try {
                await github.rest.issues.createLabel({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  ...label,
                });
                core.info(\`Created label: \${label.name}\`);
              } catch {
                // Label already exists \u2014 fine
              }
            }

      - name: Read planner prompt
        if: steps.guard.outputs.should-plan == 'true'
        id: prompt-file
        run: |
          if [[ -f ".codefactory/prompts/issue-planner.md" ]]; then
            {
              echo "content<<PROMPT_EOF"
              cat .codefactory/prompts/issue-planner.md
              echo "PROMPT_EOF"
            } >> "$GITHUB_OUTPUT"
          else
            echo "content=Analyze this issue and produce a structured implementation plan." >> "$GITHUB_OUTPUT"
          fi

      - name: Build planning prompt
        if: steps.guard.outputs.should-plan == 'true'
        id: build-prompt
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          PLANNER_TEMPLATE: \${{ steps.prompt-file.outputs.content }}
          ISSUE_JSON: \${{ github.event_name == 'workflow_dispatch' && steps.fetch-issue.outputs.json || toJSON(github.event.issue) }}
        with:
          script: |
            const fs = require('fs');
            const issue = JSON.parse(process.env.ISSUE_JSON || '{}');
            const template = process.env.PLANNER_TEMPLATE || '';

            let conventions = '';
            try { conventions = fs.readFileSync('${instructionFile}', 'utf-8').slice(0, 6000); } catch {}

            let config = '';
            try { config = fs.readFileSync('harness.config.json', 'utf-8'); } catch {}

            const prompt = [
              template,
              '',
              '## Issue to Plan',
              '',
              \`**Number**: #\${issue.number}\`,
              \`**Title**: \${issue.title}\`,
              \`**Author**: \${(issue.user || {}).login || 'unknown'}\`,
              '',
              '### Body',
              '',
              issue.body || '*(empty body)*',
              '',
              '## Project Conventions (from ${instructionFile})',
              '',
              conventions || 'No ${instructionFile} found.',
              '',
              '## Harness Configuration',
              '',
              '\`\`\`json',
              config || '{}',
              '\`\`\`',
            ].join('\\n');

            core.setOutput('prompt', prompt);
            core.info(\`Planning prompt built (\${prompt.length} chars)\`);

      - name: Run Claude planning analysis
        if: steps.guard.outputs.should-plan == 'true'
        id: claude-plan
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: \${{ steps.build-prompt.outputs.prompt }}
          claude_args: '--model claude-opus-4-6 --max-turns 30 --allowedTools "Read,Glob,Grep,Bash"'
          allowed_bots: 'github-actions'

      - name: Extract plan from execution file
        if: steps.guard.outputs.should-plan == 'true'
        id: extract-plan
        env:
          EXECUTION_FILE: \${{ steps.claude-plan.outputs.execution_file }}
        run: |
          if [[ -z "$EXECUTION_FILE" || ! -f "$EXECUTION_FILE" ]]; then
            echo "found=false" >> "$GITHUB_OUTPUT"
            echo "::warning::No execution file available"
            exit 0
          fi

          echo "Execution file: \${EXECUTION_FILE} ($(wc -c < "$EXECUTION_FILE") bytes)"

          # The execution file is a JSON array (not JSONL) from Claude Code SDK.
          # It contains a "result" turn at the end with the final response text.
          PLAN_TEXT=$(jq -r '
            [.[] | select(.type == "result")] | last | .result // ""
          ' "$EXECUTION_FILE" 2>/dev/null || echo "")

          # Fallback: if result turn is empty, get last assistant text
          if [[ -z "$PLAN_TEXT" || "$PLAN_TEXT" == "null" ]]; then
            PLAN_TEXT=$(jq -r '
              [.[] | select(.type == "assistant") |
               .message.content[] | select(.type == "text") | .text
              ] | last // ""
            ' "$EXECUTION_FILE" 2>/dev/null || echo "")
          fi

          if [[ -z "$PLAN_TEXT" || "$PLAN_TEXT" == "null" ]]; then
            echo "found=false" >> "$GITHUB_OUTPUT"
            echo "::warning::Could not extract plan text from execution file"
          else
            PLAN_TEXT="\${PLAN_TEXT:0:60000}"
            {
              echo "plan<<PLAN_EOF"
              echo "$PLAN_TEXT"
              echo "PLAN_EOF"
            } >> "$GITHUB_OUTPUT"
            echo "found=true" >> "$GITHUB_OUTPUT"
            echo "\u2714 Extracted plan ($(echo "$PLAN_TEXT" | wc -c) chars)"
          fi

      - name: Post plan comment and dispatch implementer
        if: steps.guard.outputs.should-plan == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          PLAN_TEXT: \${{ steps.extract-plan.outputs.plan || '' }}
          PLAN_FOUND: \${{ steps.extract-plan.outputs.found || 'false' }}
        with:
          script: |
            const issueNumber = parseInt('\${{ steps.guard.outputs.issue-number }}', 10);
            const planFound = process.env.PLAN_FOUND === 'true';
            const planOutput = (planFound && process.env.PLAN_TEXT) ? process.env.PLAN_TEXT : '*No plan output received.*';

            // Post plan comment with marker
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              body: [
                \`<!-- issue-planner: #\${issueNumber} -->\`,
                '\ud83d\udccb Implementation Plan',
                '',
                planOutput,
                '',
                '---',
                '*\ud83e\udd16 [Issue Planner Agent](https://github.com/codefactory) \u2014 automated implementation planning.*',
              ].join('\\n'),
            });

            // Add agent:implement label
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              labels: ['agent:implement'],
            });

            core.info(\`Plan posted and agent:implement label added for issue #\${issueNumber}\`);

      - name: Dispatch implementer workflow
        if: steps.guard.outputs.should-plan == 'true'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          ISSUE_NUM="\${{ steps.guard.outputs.issue-number }}"
          echo "Dispatching implementer for issue #\${ISSUE_NUM}..."
          gh workflow run issue-implementer.yml \\
            --field issue_number="\${ISSUE_NUM}"
          echo "\u2714 Implementer workflow dispatched."

      - name: Failure handler
        if: failure() && steps.guard.outputs.should-plan == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            const issueNumber = parseInt('\${{ steps.guard.outputs.issue-number }}', 10);

            // Add judgment label
            try {
              await github.rest.issues.createLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                name: 'agent:needs-judgment',
                color: 'E4E669',
                description: 'Agent needs human judgment to proceed',
              });
            } catch {}

            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              labels: ['agent:needs-judgment'],
            });

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              body: [
                \`<!-- issue-planner-failed: #\${issueNumber} -->\`,
                '\u274c Planner Agent \u2014 Failed',
                '',
                'The planning agent encountered an error while analyzing this issue.',
                'A human should review the failure and decide next steps.',
                '',
                \`**Run**: [\${context.runId}](\${context.serverUrl}/\${context.repo.owner}/\${context.repo.repo}/actions/runs/\${context.runId})\`,
                '',
                '---',
                '*\ud83e\udd16 [Issue Planner Agent](https://github.com/codefactory) \u2014 automated implementation planning.*',
              ].join('\\n'),
            });
`;
}

function buildIssuePlannerGuardTs(): string {
  return `#!/usr/bin/env npx tsx
// ============================================================================
// Issue Planner Guard \u2014 pre-flight gate for automated issue planning
//
// Determines whether the planner agent should proceed based on:
//   - Presence of \`agent:plan\` label (required)
//   - Absence of blocking labels (agent:skip, wontfix, duplicate, invalid)
//   - No existing plan already posted via marker comment
//
// Usage:
//   ISSUE_JSON='{"number":1,...}' npx tsx scripts/issue-planner-guard.ts --evaluate
//   npx tsx scripts/issue-planner-guard.ts --self-test
//
// Environment variables:
//   ISSUE_JSON          \u2014 serialized GitHub issue object (from github.event.issue)
//   GITHUB_REPOSITORY   \u2014 owner/repo (set by CI runner)
//   GH_TOKEN            \u2014 GitHub auth token for API calls
// ============================================================================

import { execSync } from 'node:child_process';

// --- Types ---

export interface PlannerDecision {
  shouldPlan: boolean;
  issueNumber: number;
  issueTitle: string;
  reason: string;
  existingPlan: boolean;
  blockedLabels: string[];
}

interface IssuePayload {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
  user: { login: string; type?: string };
  labels: Array<{ name: string }>;
}

// --- Constants ---

/** The label required to trigger planning. */
const TRIGGER_LABEL = 'agent:plan';

/** Labels that block planning. */
const BLOCKING_LABELS = ['agent:skip', 'wontfix', 'duplicate', 'invalid'];

/** Marker comment prefix used to detect existing planner comments. */
const PLAN_MARKER_PREFIX = '<!-- issue-planner:';

// --- Public API ---

/**
 * Check if an existing plan has already been posted via marker comment.
 * Searches issue comments for \`<!-- issue-planner: #N -->\`.
 * Returns true if found, false otherwise.
 */
export function findExistingPlan(issueNumber: number): boolean {
  try {
    const repo = process.env.GITHUB_REPOSITORY || '';
    if (!repo) return false;

    const output = execSync(
      \`gh issue view \${issueNumber} --repo "\${repo}" --json comments --jq '.comments[].body'\`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    for (const line of output.split('\\n')) {
      if (line.includes(PLAN_MARKER_PREFIX)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Evaluate whether planning should proceed for a given issue.
 *
 * Decision logic:
 * 1. Skip pull requests \u2014 they're not issues.
 * 2. Check for \`agent:plan\` label \u2014 required to proceed.
 * 3. Check for blocking labels \u2014 reject if any are present.
 * 4. Check for existing plan via marker comment \u2014 skip if already planned.
 * 5. Approve for planning.
 */
export function evaluate(issue: IssuePayload, skipPlanCheck = false): PlannerDecision {
  const labelNames = issue.labels.map((l) => l.name);

  const base: Pick<PlannerDecision, 'issueNumber' | 'issueTitle'> = {
    issueNumber: issue.number,
    issueTitle: issue.title,
  };

  // Gate 1: Not an issue (PR)
  if (issue.pull_request) {
    return {
      ...base,
      shouldPlan: false,
      reason: 'Pull request \u2014 not an issue.',
      existingPlan: false,
      blockedLabels: [],
    };
  }

  // Gate 2: Missing trigger label
  if (!labelNames.includes(TRIGGER_LABEL)) {
    return {
      ...base,
      shouldPlan: false,
      reason: \`Missing required label '\${TRIGGER_LABEL}'.\`,
      existingPlan: false,
      blockedLabels: [],
    };
  }

  // Gate 3: Blocking labels
  const blocked = labelNames.filter((l) => BLOCKING_LABELS.includes(l));
  if (blocked.length > 0) {
    return {
      ...base,
      shouldPlan: false,
      reason: \`Blocked by label(s): \${blocked.join(', ')}.\`,
      existingPlan: false,
      blockedLabels: blocked,
    };
  }

  // Gate 4: Existing plan (via marker comment)
  if (!skipPlanCheck) {
    const existingPlan = findExistingPlan(issue.number);
    if (existingPlan) {
      return {
        ...base,
        shouldPlan: false,
        reason: 'A plan has already been posted for this issue.',
        existingPlan: true,
        blockedLabels: [],
      };
    }
  }

  // Approved
  return {
    ...base,
    shouldPlan: true,
    reason: 'Issue approved for planning.',
    existingPlan: false,
    blockedLabels: [],
  };
}

// --- CLI: --evaluate ---

if (process.argv.includes('--evaluate')) {
  let issue: IssuePayload;
  try {
    issue = JSON.parse(process.env.ISSUE_JSON || '{}');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(\`ERROR: Failed to parse ISSUE_JSON: \${msg}\`);
    process.exit(1);
  }

  if (!issue.number) {
    console.error('ERROR: ISSUE_JSON must contain a valid issue number.');
    process.exit(1);
  }

  const decision = evaluate(issue);
  console.log(JSON.stringify(decision, null, 2));
}

// --- CLI: --self-test ---

if (process.argv.includes('--self-test')) {
  console.log('Running issue-planner-guard self-test...\\n');

  // --- evaluate (without API calls \u2014 skipPlanCheck=true) ---

  // Missing trigger label
  const noLabel = evaluate(
    {
      number: 1,
      title: 'Add feature',
      body: 'Details...',
      user: { login: 'user' },
      labels: [{ name: 'bug' }],
    },
    true,
  );
  console.assert(noLabel.shouldPlan === false, 'Should not plan without agent:plan label');

  // Has trigger label, no blockers
  const ready = evaluate(
    {
      number: 10,
      title: 'Add dark mode',
      body: 'Implement dark mode toggle',
      user: { login: 'user' },
      labels: [{ name: 'agent:plan' }, { name: 'enhancement' }],
    },
    true,
  );
  console.assert(ready.shouldPlan === true, 'Should plan with agent:plan label');

  // Blocked by label
  const blocked = evaluate(
    {
      number: 2,
      title: 'Something',
      body: null,
      user: { login: 'user' },
      labels: [{ name: 'agent:plan' }, { name: 'wontfix' }],
    },
    true,
  );
  console.assert(blocked.shouldPlan === false, 'Should not plan with blocking label');
  console.assert(
    blocked.blockedLabels.includes('wontfix'),
    'Should report wontfix as blocked label',
  );

  // PR (not an issue)
  const pr = evaluate(
    {
      number: 3,
      title: 'PR title',
      body: null,
      pull_request: { url: 'https://...' },
      user: { login: 'user' },
      labels: [{ name: 'agent:plan' }],
    },
    true,
  );
  console.assert(pr.shouldPlan === false, 'PR should be skipped');

  // Multiple blocking labels
  const multiBlocked = evaluate(
    {
      number: 4,
      title: 'Something',
      body: null,
      user: { login: 'user' },
      labels: [{ name: 'agent:plan' }, { name: 'duplicate' }, { name: 'invalid' }],
    },
    true,
  );
  console.assert(
    multiBlocked.blockedLabels.length === 2,
    \`Expected 2 blocked labels, got \${multiBlocked.blockedLabels.length}\`,
  );

  // Has agent:implement but not agent:plan
  const wrongLabel = evaluate(
    {
      number: 5,
      title: 'Feature',
      body: 'Details',
      user: { login: 'user' },
      labels: [{ name: 'agent:implement' }],
    },
    true,
  );
  console.assert(
    wrongLabel.shouldPlan === false,
    'Should not plan with agent:implement instead of agent:plan',
  );

  console.log('\\n\u2714 All self-tests passed.');
}
`;
}

function buildIssuePlannerPromptMd(instructionFile: string): string {
  return `# Issue Planner Agent Instructions

You are a planning agent. Your task is to analyze a GitHub issue and produce a structured implementation plan. You do NOT write code \u2014 you produce a plan that the implementation agent will follow.

## Rules

1. **Read first**: Before planning, read ${instructionFile} for project conventions and harness.config.json for architectural boundaries.
2. **Understand the issue**: Parse the issue title and body to understand what needs to be built. Identify acceptance criteria if present.
3. **Read-only analysis**: You MUST NOT modify any files. Use only Read, Glob, Grep, and Bash (for read-only commands like \`ls\`, \`git log\`) to explore the codebase. Do NOT call Write, Edit, NotebookEdit, or any file-modifying tools.
4. **No plan mode**: Do NOT call \`EnterPlanMode\` or \`ExitPlanMode\`. You are running in CI with no human to approve plans. Output your plan directly.
5. **No git commands**: Do NOT run git commit, git push, or any commands that modify repository state.

## Plan Structure

Your output MUST follow this exact structure:

### Files to Modify

List every file that needs changes, with a brief description of what changes are needed.

### Files to Create

List any new files that need to be created, with a description of their purpose and contents.

### Approach

Step-by-step description of the implementation approach. Be specific about:

- Which functions/classes to modify
- What new functions/classes to add
- How the changes integrate with existing code

### Test Strategy

- Which test files need updates
- What new test cases to add
- Edge cases to cover

### Risk Assessment

- **Risk tier**: Tier 1 (docs), Tier 2 (features), or Tier 3 (critical paths)
- **Affected architectural layers**: List which layers are touched
- **Breaking changes**: Any potential breaking changes
- **Dependencies**: New dependencies required (if any)

## Guidelines

- Keep the plan focused on the minimal changes needed to satisfy the issue
- Follow existing patterns and conventions observed in the codebase
- Flag any ambiguities or concerns that the implementation agent should be aware of
- If the issue is unclear or underspecified, note what assumptions you are making
- Consider the project's architectural boundaries when planning changes

Return ONLY the structured plan. No markdown fences around the entire output, no extra commentary.
`;
}

/* eslint-enable no-useless-escape */
