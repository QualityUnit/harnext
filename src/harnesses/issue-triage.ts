import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import type { DetectionResult } from '../core/detector.js';
import type { AIPlatform } from '../core/ai-runner.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';
import { buildAgentStepLines } from '../core/ci-agent-steps.js';
import { buildIssueTriagePrompt } from '../prompts/issue-triage.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const issueTriageHarness: HarnessModule = {
  name: 'issue-triage',
  displayName: 'Issue Triage Agent',
  description: 'Evaluates new issues for quality and routes actionable ones to implementation',
  order: 14,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;
    const platform = ctx.runner.platform;

    // 1. Generate reference templates from existing builders
    const refWorkflow = buildIssueTriageWorkflowYml(detection, platform);
    const refGuard = buildIssueTriageGuardTs();
    const refPromptMd = buildIssueTriagePromptMd();

    // 2. Build the prompt with reference context
    const basePrompt = buildIssueTriagePrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: .github/workflows/issue-triage.yml
\`\`\`yaml
${refWorkflow}
\`\`\`

### Reference: scripts/issue-triage-guard.ts
\`\`\`typescript
${refGuard}
\`\`\`

### Reference: .codefactory/prompts/issue-triage.md
\`\`\`markdown
${refPromptMd}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'issue-triage',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { workflowPath: '.github/workflows/issue-triage.yml' },
      };
      ctx.previousOutputs.set('issue-triage', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Issue triage generation failed: ${message}`);
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

function buildIssueTriageWorkflowYml(det: DetectionResult, platform: AIPlatform): string {
  const installCmd = resolveInstallCmd(det);
  const cache = resolveCacheKey(det);
  const agentAction = CI_AGENT_ACTIONS[platform];

  return `name: Issue Triage Agent

on:
  issues:
    types: [opened, edited, reopened]

permissions:
  issues: write
  contents: read
  actions: write
  id-token: write

concurrency:
  group: issue-triage-\${{ github.event.issue.number }}
  cancel-in-progress: true

jobs:
  triage:
    name: Triage Agent
    runs-on: ubuntu-latest
    timeout-minutes: 10
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

      - name: Run triage guard
        id: guard
        env:
          ISSUE_JSON: \${{ toJSON(github.event.issue) }}
          EVENT_NAME: \${{ github.event.action }}
        run: |
          DECISION=$(npx tsx scripts/issue-triage-guard.ts --evaluate)
          echo "decision<<GUARD_EOF" >> "$GITHUB_OUTPUT"
          echo "$DECISION" >> "$GITHUB_OUTPUT"
          echo "GUARD_EOF" >> "$GITHUB_OUTPUT"

          SHOULD=$(echo "$DECISION" | jq -r '.shouldTriage')
          IS_RETRIAGE=$(echo "$DECISION" | jq -r '.isRetriage')
          REASON=$(echo "$DECISION" | jq -r '.reason')
          echo "should-triage=\${SHOULD}" >> "$GITHUB_OUTPUT"
          echo "is-retriage=\${IS_RETRIAGE}" >> "$GITHUB_OUTPUT"
          echo "reason=\${REASON}" >> "$GITHUB_OUTPUT"

          echo "Guard: shouldTriage=\${SHOULD}, isRetriage=\${IS_RETRIAGE}"

      - name: Skip — log reason
        if: steps.guard.outputs.should-triage == 'false'
        run: |
          echo "::notice::Triage skipped: \${{ steps.guard.outputs.reason }}"

      - name: Ensure triage labels exist
        if: steps.guard.outputs.should-triage == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            const labels = [
              { name: 'needs-more-info', color: 'FBCA04', description: 'Issue needs additional details' },
              { name: 'agent:plan', color: '1D76DB', description: 'Approved for automated planning' },
              { name: 'agent:implement', color: '0E8A16', description: 'Approved for automated implementation' },
              { name: 'triage:failed', color: 'D93F0B', description: 'Triage agent encountered an error' },
              { name: 'needs-human-review', color: 'C5DEF5', description: 'Requires human review before proceeding' },
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
                // Label already exists — fine
              }
            }

      - name: Remove needs-more-info on re-triage
        if: steps.guard.outputs.is-retriage == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            try {
              await github.rest.issues.removeLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                name: 'needs-more-info',
              });
              core.info('Removed needs-more-info label for re-triage.');
            } catch {
              // Label might not exist — fine
            }

      - name: Read triage prompt
        if: steps.guard.outputs.should-triage == 'true'
        id: prompt-file
        run: |
          if [[ -f ".codefactory/prompts/issue-triage.md" ]]; then
            {
              echo "content<<PROMPT_EOF"
              cat .codefactory/prompts/issue-triage.md
              echo "PROMPT_EOF"
            } >> "$GITHUB_OUTPUT"
          else
            echo "content=Evaluate this issue for quality and actionability." >> "$GITHUB_OUTPUT"
          fi

      - name: Build triage prompt
        if: steps.guard.outputs.should-triage == 'true'
        id: build-prompt
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          TRIAGE_TEMPLATE: \${{ steps.prompt-file.outputs.content }}
          IS_RETRIAGE: \${{ steps.guard.outputs.is-retriage }}
        with:
          script: |
            const issue = context.payload.issue;
            const template = process.env.TRIAGE_TEMPLATE || '';
            const isRetriage = process.env.IS_RETRIAGE === 'true';
            const labels = (issue.labels || []).map((l) => l.name).join(', ');

            const prompt = [
              template,
              '',
              '## Issue to Triage',
              '',
              \`**Number**: #\${issue.number}\`,
              \`**Title**: \${issue.title}\`,
              \`**Author**: \${issue.user.login}\`,
              \`**Labels**: \${labels || 'none'}\`,
              \`**Re-triage**: \${isRetriage ? 'yes — author updated the issue after needs-more-info' : 'no'}\`,
              '',
              '### Body',
              '',
              issue.body || '*(empty body)*',
            ].join('\\n');

            core.setOutput('prompt', prompt);
            core.info(\`Triage prompt built (\${prompt.length} chars)\`);

      - name: Write triage JSON schema
        if: steps.guard.outputs.should-triage == 'true'
        id: schema
        run: |
          cat > /tmp/triage-schema.json << 'SCHEMA_EOF'
          {"type":"object","required":["actionable","confidence","summary","suggestedLabels","estimatedComplexity"],"properties":{"actionable":{"type":"boolean"},"confidence":{"type":"number"},"missingInfo":{"type":"array","items":{"type":"string"}},"summary":{"type":"string"},"suggestedLabels":{"type":"array","items":{"type":"string"}},"estimatedComplexity":{"type":"string","enum":["low","medium","high"]},"reproduced":{"type":["boolean","null"]},"reproductionNotes":{"type":"string"}},"additionalProperties":false}
          SCHEMA_EOF
          SCHEMA=$(cat /tmp/triage-schema.json | tr -d '\\n' | tr -s ' ')
          echo "value=\${SCHEMA}" >> "$GITHUB_OUTPUT"

${buildAgentStepLines(platform, {
  stepName: 'Run AI triage analysis',
  stepId: 'claude-triage',
  promptExpr: '${{ steps.build-prompt.outputs.prompt }}',
  ifCondition: "steps.guard.outputs.should-triage == 'true'",
  argsExpr: `"--max-turns 15 --json-schema '\${{ steps.schema.outputs.value }}'"`,
}).join('\n')}

      - name: Parse structured verdict
        if: steps.guard.outputs.should-triage == 'true'
        id: verdict
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          STRUCTURED_OUTPUT: \${{ steps.claude-triage.outputs.${agentAction.structuredOutputKey || 'structured_output'} || '' }}
        with:
          script: |
            const raw = process.env.STRUCTURED_OUTPUT || '';
            core.info(\`Structured output length: \${raw.length}\`);

            if (!raw) {
              core.warning('No structured output from Claude — structured_output is empty');
              core.setOutput('parsed', 'false');
              core.setOutput('raw-text', '');
              return;
            }

            let verdict = null;
            try {
              verdict = JSON.parse(raw);
            } catch (e) {
              core.warning(\`Failed to parse structured_output as JSON: \${e.message}\`);
              core.setOutput('parsed', 'false');
              core.setOutput('raw-text', raw.slice(0, 2000));
              return;
            }

            if (!verdict || typeof verdict.actionable !== 'boolean') {
              core.warning('Structured output missing required "actionable" field');
              core.setOutput('parsed', 'false');
              core.setOutput('raw-text', raw.slice(0, 2000));
              return;
            }

            core.setOutput('parsed', 'true');
            core.setOutput('actionable', String(verdict.actionable));
            core.setOutput('confidence', String(verdict.confidence || 0));
            core.setOutput('complexity', verdict.estimatedComplexity || 'medium');
            core.setOutput('summary', verdict.summary || '');
            core.setOutput('missing-info', JSON.stringify(verdict.missingInfo || []));
            core.setOutput('suggested-labels', JSON.stringify(verdict.suggestedLabels || []));

            // Only flag UI/visual bugs for browser reproduction — CLI and backend bugs skip repro
            const isUiBug = (verdict.suggestedLabels || []).some(
              (l) => l === 'ui-bug' || l === 'visual-bug' || l === 'ui' || l === 'frontend-bug'
            );
            core.setOutput('is-bug', String(isUiBug));
            core.setOutput('reproduced', String(verdict.reproduced ?? false));
            core.setOutput('reproduction-notes', verdict.reproductionNotes || '');
            core.setOutput('raw-text', '');

            core.info(\`Verdict: actionable=\${verdict.actionable}, confidence=\${verdict.confidence}, complexity=\${verdict.estimatedComplexity}, isUiBug=\${isUiBug}\`);

      - name: Install Chromium dependencies
        if: steps.verdict.outputs.is-bug == 'true' && steps.verdict.outputs.actionable == 'true'
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \\
            libxdamage1 libxrandr2 libgbm1 libasound2t64 libpangocairo-1.0-0 libgtk-3-0 \\
            libxshmfence1 2>/dev/null || true

      - name: Detect dev server command
        if: steps.verdict.outputs.is-bug == 'true' && steps.verdict.outputs.actionable == 'true'
        id: devserver
        run: |
          DEV_CMD=""
          if [[ -f "package.json" ]]; then
            for script in dev start serve; do
              HAS=$(jq -r ".scripts.\\\"\${script}\\\" // empty" package.json)
              if [[ -n "$HAS" ]]; then
                DEV_CMD="npm run \${script}"
                break
              fi
            done
          fi

          if [[ -n "$DEV_CMD" ]]; then
            echo "cmd=\${DEV_CMD}" >> "$GITHUB_OUTPUT"
            echo "available=true" >> "$GITHUB_OUTPUT"
            echo "Dev server command: \${DEV_CMD}"
          else
            echo "available=false" >> "$GITHUB_OUTPUT"
            echo "::notice::No dev server script found — skipping browser reproduction."
          fi

      - name: Browser reproduction phase
        if: >-
          steps.verdict.outputs.is-bug == 'true' &&
          steps.verdict.outputs.actionable == 'true' &&
          steps.devserver.outputs.available == 'true'
        id: reproduce
        continue-on-error: true
        uses: ${agentAction.action}
        with:
          ${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}
          ${agentAction.promptInputKey}: |
            You are a bug reproduction agent. Your goal is to reproduce a reported bug using a headless browser.

            ## Issue
            **Title**: \${{ github.event.issue.title }}
            **Body**: \${{ github.event.issue.body }}

            ## Instructions

            1. Install puppeteer: \`npm install puppeteer\`
            2. Start the dev server in the background: \`\${{ steps.devserver.outputs.cmd }} &\`
            3. Wait for the server to be ready (poll http://localhost:3000 or the appropriate port)
            4. Write a Puppeteer script that attempts to reproduce the bug described in the issue
            5. Take screenshots at key steps and save them to \`/tmp/repro-screenshots/\`
            6. Run the script and observe the results
            7. Clean up (kill the dev server)

            ## Output

            Return ONLY a JSON object:
            \`\`\`json
            {
              "reproduced": true/false,
              "screenshots": ["list of screenshot file paths"],
              "notes": "Brief description of what you observed"
            }
            \`\`\`
${agentAction.argsInputKey ? `          ${agentAction.argsInputKey}: '--max-turns 20'` : ''}
      - name: Parse reproduction result
        if: steps.reproduce.outcome == 'success'
        id: repro-result
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          REPRO_OUTPUT: \${{ steps.reproduce.outputs.${agentAction.structuredOutputKey || 'structured_output'} || '' }}
        with:
          script: |
            const raw = process.env.REPRO_OUTPUT || '';
            if (raw) {
              try {
                const result = JSON.parse(raw);
                core.setOutput('reproduced', String(result.reproduced || false));
                core.setOutput('notes', result.notes || '');
                core.info(\`Reproduction result: reproduced=\${result.reproduced}\`);
                return;
              } catch (e) {
                core.warning(\`Failed to parse reproduction output: \${e.message}\`);
              }
            }
            core.setOutput('reproduced', 'false');
            core.setOutput('notes', 'Reproduction phase did not produce parseable output.');

      - name: Route triage decision
        if: steps.guard.outputs.should-triage == 'true'
        id: route
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        env:
          PARSED: \${{ steps.verdict.outputs.parsed }}
          ACTIONABLE: \${{ steps.verdict.outputs.actionable }}
          CONFIDENCE: \${{ steps.verdict.outputs.confidence }}
          COMPLEXITY: \${{ steps.verdict.outputs.complexity }}
          SUMMARY: \${{ steps.verdict.outputs.summary }}
          MISSING_INFO: \${{ steps.verdict.outputs.missing-info }}
          SUGGESTED_LABELS: \${{ steps.verdict.outputs.suggested-labels }}
          IS_BUG: \${{ steps.verdict.outputs.is-bug }}
          REPRO_RAN: \${{ steps.reproduce.outcome || 'skipped' }}
          REPRODUCED: \${{ steps.repro-result.outputs.reproduced || 'false' }}
          REPRO_NOTES: \${{ steps.repro-result.outputs.notes || '' }}
          RAW_TEXT: \${{ steps.verdict.outputs.raw-text }}
        with:
          script: |
            const issueNumber = context.issue.number;
            const parsed = process.env.PARSED === 'true';
            const actionable = process.env.ACTIONABLE === 'true';
            const confidence = parseFloat(process.env.CONFIDENCE || '0');
            const complexity = process.env.COMPLEXITY || 'medium';
            const summary = process.env.SUMMARY || '';
            const isBug = process.env.IS_BUG === 'true';
            const reproRan = process.env.REPRO_RAN === 'success';
            const reproduced = process.env.REPRODUCED === 'true';
            const reproNotes = process.env.REPRO_NOTES || '';
            const rawText = process.env.RAW_TEXT || '';

            let missingInfo = [];
            let suggestedLabels = [];
            try { missingInfo = JSON.parse(process.env.MISSING_INFO || '[]'); } catch {}
            try { suggestedLabels = JSON.parse(process.env.SUGGESTED_LABELS || '[]'); } catch {}

            const labelsToAdd = [];
            const commentSections = [\`<!-- issue-triage: #\${issueNumber} -->\`];

            if (!parsed) {
              // Failed to parse — add failure label and show what Claude said
              labelsToAdd.push('triage:failed');
              commentSections.push(
                '\u26a0\ufe0f Issue Triage — Parse Failure',
                '',
                'The triage agent could not produce a valid verdict for this issue.',
                'A human should review and triage manually.',
              );
              if (rawText) {
                commentSections.push(
                  '',
                  '<details><summary>Agent raw output (for debugging)</summary>',
                  '',
                  '\`\`\`',
                  rawText.slice(0, 1500),
                  '\`\`\`',
                  '',
                  '</details>',
                );
              }
            } else if (actionable) {
              let shouldImplement = confidence >= 0.7;

              // Bug reproduction boost
              if (isBug && reproRan) {
                if (reproduced) {
                  shouldImplement = true;
                  commentSections.push(
                    '\u2705 Issue Triage — Bug Confirmed',
                    '',
                    \`**Summary**: \${summary}\`,
                    \`**Confidence**: \${confidence} (boosted — bug reproduced)\`,
                    \`**Complexity**: \${complexity}\`,
                  );
                  if (reproNotes) {
                    commentSections.push('', \`**Reproduction notes**: \${reproNotes}\`);
                  }
                } else {
                  shouldImplement = false;
                  labelsToAdd.push('needs-more-info');
                  commentSections.push(
                    '\ud83d\udd0d Issue Triage — Bug Not Reproduced',
                    '',
                    \`**Summary**: \${summary}\`,
                    \`**Confidence**: \${confidence}\`,
                    '',
                    'The automated reproduction attempt could not confirm this bug.',
                    'Please provide more detailed reproduction steps, including:',
                    '- Exact URL/page where the issue occurs',
                    '- Browser and OS version',
                    '- Step-by-step actions to trigger the bug',
                  );
                  if (reproNotes) {
                    commentSections.push('', \`**Agent notes**: \${reproNotes}\`);
                  }
                }
              } else if (shouldImplement) {
                commentSections.push(
                  '\u2705 Issue Triage — Approved for Implementation',
                  '',
                  \`**Summary**: \${summary}\`,
                  \`**Confidence**: \${confidence}\`,
                  \`**Complexity**: \${complexity}\`,
                );
              } else {
                // Actionable but low confidence — ask clarifying questions
                labelsToAdd.push('needs-more-info');
                const missingItems = missingInfo.length > 0
                  ? missingInfo.map((m) => \`- \${m}\`)
                  : ['- More details about the expected behavior', '- Steps to reproduce or context'];
                commentSections.push(
                  '\ud83d\udd0d Issue Triage — More Details Needed',
                  '',
                  \`**Summary**: \${summary}\`,
                  \`**Confidence**: \${confidence} (below 0.7 threshold)\`,
                  '',
                  'To help the implementation agent, please clarify:',
                  ...missingItems,
                );
              }

              if (shouldImplement) {
                labelsToAdd.push('agent:plan');
              }

              if (complexity === 'high') {
                labelsToAdd.push('needs-human-review');
              }
            } else {
              // Not actionable — ask clarifying questions
              labelsToAdd.push('needs-more-info');
              const missingItems = missingInfo.length > 0
                ? missingInfo.map((m) => \`- \${m}\`)
                : ['- A clear description of what you expect to happen', '- Steps to reproduce the issue'];
              commentSections.push(
                '\ud83d\udccb Issue Triage — Not Actionable',
                '',
                \`**Summary**: \${summary || 'Unable to determine issue intent'}\`,
                '',
                'This issue needs more information before it can be implemented. Please provide:',
                ...missingItems,
                '',
                '*Edit this issue with the requested details and we will re-evaluate automatically.*',
              );
            }

            // Add suggested labels (filter out internal ones)
            const internalLabels = ['agent:implement', 'needs-more-info', 'triage:failed', 'needs-human-review'];
            for (const label of suggestedLabels) {
              if (!internalLabels.includes(label) && !labelsToAdd.includes(label)) {
                try {
                  await github.rest.issues.createLabel({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    name: label,
                    color: 'EDEDED',
                  });
                } catch {}
                labelsToAdd.push(label);
              }
            }

            // Apply labels
            if (labelsToAdd.length > 0) {
              await github.rest.issues.addLabels({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: issueNumber,
                labels: labelsToAdd,
              });
              core.info(\`Added labels: \${labelsToAdd.join(', ')}\`);
            }

            // Signal planner dispatch
            core.setOutput('should-plan', String(labelsToAdd.includes('agent:plan')));

            // Post comment
            commentSections.push(
              '',
              '---',
              '*\ud83e\udd16 [Issue Triage Agent](https://github.com/codefactory) — automated issue triage.*',
            );

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              body: commentSections.join('\\n'),
            });

      - name: Dispatch planner workflow
        if: steps.route.outputs.should-plan == 'true'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          ISSUE_NUM="\${{ github.event.issue.number }}"
          echo "Dispatching planner for issue #\${ISSUE_NUM}..."
          gh workflow run issue-planner.yml \\
            --field issue_number="\${ISSUE_NUM}"
          echo "\u2714 Planner workflow dispatched."

      - name: Failure handler
        if: failure() && steps.guard.outputs.should-triage == 'true'
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            const issueNumber = context.issue.number;

            try {
              await github.rest.issues.createLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                name: 'triage:failed',
                color: 'D93F0B',
                description: 'Triage agent encountered an error',
              });
            } catch {}

            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              labels: ['triage:failed'],
            });

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: issueNumber,
              body: [
                \`<!-- issue-triage-failed: #\${issueNumber} -->\`,
                '\u274c Issue Triage — Agent Error',
                '',
                'The triage agent encountered an unexpected error while processing this issue.',
                'A human should review and triage manually.',
                '',
                \`**Run**: [\${context.runId}](\${context.serverUrl}/\${context.repo.owner}/\${context.repo.repo}/actions/runs/\${context.runId})\`,
                '',
                '---',
                '*\ud83e\udd16 [Issue Triage Agent](https://github.com/codefactory) — automated issue triage.*',
              ].join('\\n'),
            });
`;
}

function buildIssueTriageGuardTs(): string {
  return `#!/usr/bin/env npx tsx
// ============================================================================
// Issue Triage Guard — pre-flight gate for automated issue triage
//
// Determines whether the triage agent should proceed based on:
//   - Bot-authored issues (skip)
//   - Already-triaged issues (skip unless re-triage on edit)
//   - Pull requests (skip — not issues)
//   - Issue event context (opened vs edited)
//
// Usage:
//   ISSUE_JSON='{"number":1,...}' EVENT_NAME='opened' npx tsx scripts/issue-triage-guard.ts --evaluate
//   npx tsx scripts/issue-triage-guard.ts --self-test
//
// Environment variables:
//   ISSUE_JSON   — serialized GitHub issue object (from github.event.issue)
//   EVENT_NAME   — "opened" | "edited" (from github.event.action)
// ============================================================================

import { execSync } from 'node:child_process';

// --- Types ---

export interface TriageDecision {
  shouldTriage: boolean;
  issueNumber: number;
  issueTitle: string;
  reason: string;
  isRetriage: boolean;
  skipReason: string;
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

/** Bot suffixes that indicate automated issue creation. */
const BOT_SUFFIXES = ['[bot]', '-bot'];

/** Labels that indicate an issue has already been triaged. */
const TRIAGED_LABELS = [
  'agent:plan',
  'agent:implement',
  'needs-human-review',
  'wontfix',
  'duplicate',
  'invalid',
];

/** Label that enables re-triage on edit. */
const RETRIAGE_LABEL = 'needs-more-info';

// --- Public API ---

/**
 * Check if an issue author is a bot.
 */
export function isBot(login: string, userType?: string): boolean {
  if (userType === 'Bot') return true;
  const lower = login.toLowerCase();
  return BOT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Check if an issue has already been triaged (has a triaged label).
 */
export function isAlreadyTriaged(labels: string[]): boolean {
  return labels.some((label) => TRIAGED_LABELS.includes(label));
}

/**
 * Check if an issue qualifies for re-triage on edit.
 * Re-triage is only allowed when the \`needs-more-info\` label is present
 * and the event is an edit.
 */
export function shouldRetriage(labels: string[], eventName: string): boolean {
  if (eventName !== 'edited') return false;
  return labels.includes(RETRIAGE_LABEL);
}

/**
 * Evaluate whether triage should proceed for a given issue.
 *
 * Decision logic:
 * 1. Skip pull requests — they're not issues.
 * 2. Skip bot-authored issues.
 * 3. On edit + \`needs-more-info\`\u2192 re-triage.
 * 4. On edit + never triaged \u2192 initial triage (e.g. issue predates workflow).
 * 5. On edit + already triaged \u2192 skip.
 * 6. On open + already triaged \u2192 skip.
 * 7. Otherwise, proceed with triage.
 */
export function evaluate(issue: IssuePayload, eventName: string): TriageDecision {
  const labelNames = issue.labels.map((l) => l.name);

  const base: Pick<TriageDecision, 'issueNumber' | 'issueTitle'> = {
    issueNumber: issue.number,
    issueTitle: issue.title,
  };

  // Gate 1: Not an issue (PR)
  if (issue.pull_request) {
    return {
      ...base,
      shouldTriage: false,
      reason: 'Pull request \u2014 not an issue.',
      isRetriage: false,
      skipReason: 'pull_request',
    };
  }

  // Gate 2: Bot author
  if (isBot(issue.user.login, issue.user.type)) {
    return {
      ...base,
      shouldTriage: false,
      reason: \`Bot-authored issue (\${issue.user.login}) \u2014 skipping.\`,
      isRetriage: false,
      skipReason: 'bot_author',
    };
  }

  // Gate 3: Already triaged
  const alreadyTriaged = isAlreadyTriaged(labelNames);

  // Gate 4: Edit event routing
  if (eventName === 'edited') {
    // Re-triage: issue was triaged as needs-more-info, author updated it
    if (shouldRetriage(labelNames, eventName)) {
      return {
        ...base,
        shouldTriage: true,
        reason: \`Re-triage: issue edited with '\${RETRIAGE_LABEL}' label present.\`,
        isRetriage: true,
        skipReason: '',
      };
    }
    // Never triaged: treat edit like an open event (e.g. issue created before workflow existed)
    if (!alreadyTriaged) {
      return {
        ...base,
        shouldTriage: true,
        reason: 'Issue edited but never triaged \u2014 proceeding with initial triage.',
        isRetriage: false,
        skipReason: '',
      };
    }
    // Already triaged with a final label \u2014 skip
    return {
      ...base,
      shouldTriage: false,
      reason: 'Edit event on already-triaged issue \u2014 skipping.',
      isRetriage: false,
      skipReason: 'edit_already_triaged',
    };
  }

  // Gate 5: Already triaged (open event)
  if (alreadyTriaged) {
    return {
      ...base,
      shouldTriage: false,
      reason: 'Issue already has a triage label \u2014 skipping.',
      isRetriage: false,
      skipReason: 'already_triaged',
    };
  }

  // Proceed
  return {
    ...base,
    shouldTriage: true,
    reason: 'New issue ready for triage.',
    isRetriage: false,
    skipReason: '',
  };
}

// --- CLI: --evaluate ---

if (process.argv.includes('--evaluate')) {
  const eventName = process.env.EVENT_NAME || 'opened';

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

  const decision = evaluate(issue, eventName);
  console.log(JSON.stringify(decision, null, 2));
}

// --- CLI: --self-test ---

if (process.argv.includes('--self-test')) {
  console.log('Running issue-triage-guard self-test...\\n');

  // --- isBot ---
  console.assert(isBot('dependabot[bot]') === true, 'dependabot[bot] should be detected as bot');
  console.assert(isBot('renovate-bot') === true, 'renovate-bot should be detected as bot');
  console.assert(isBot('github-actions[bot]', 'Bot') === true, 'Bot user type should be detected');
  console.assert(isBot('yasha-dev1') === false, 'Regular user should not be a bot');
  console.assert(
    isBot('botmaster') === false,
    'User with "bot" in name but no suffix should not match',
  );

  // --- isAlreadyTriaged ---
  console.assert(isAlreadyTriaged(['agent:plan']) === true, 'agent:plan should indicate triaged');
  console.assert(
    isAlreadyTriaged(['agent:implement']) === true,
    'agent:implement should indicate triaged',
  );
  console.assert(
    isAlreadyTriaged(['needs-human-review']) === true,
    'needs-human-review should indicate triaged',
  );
  console.assert(isAlreadyTriaged(['wontfix']) === true, 'wontfix should indicate triaged');
  console.assert(
    isAlreadyTriaged(['bug', 'enhancement']) === false,
    'Regular labels should not indicate triaged',
  );
  console.assert(isAlreadyTriaged([]) === false, 'No labels should not indicate triaged');

  // --- shouldRetriage ---
  console.assert(
    shouldRetriage(['needs-more-info'], 'edited') === true,
    'Should re-triage on edit with needs-more-info label',
  );
  console.assert(
    shouldRetriage(['needs-more-info'], 'opened') === false,
    'Should NOT re-triage on open even with needs-more-info',
  );
  console.assert(
    shouldRetriage(['bug'], 'edited') === false,
    'Should NOT re-triage on edit without needs-more-info',
  );

  // --- evaluate ---

  // New issue, normal user
  const newIssue = evaluate(
    {
      number: 1,
      title: 'Bug: login broken',
      body: 'Steps to reproduce...',
      user: { login: 'yasha-dev1' },
      labels: [],
    },
    'opened',
  );
  console.assert(newIssue.shouldTriage === true, 'New issue should be triaged');
  console.assert(newIssue.isRetriage === false, 'New issue is not re-triage');

  // Bot issue
  const botIssue = evaluate(
    {
      number: 2,
      title: 'Dependency update',
      body: null,
      user: { login: 'dependabot[bot]', type: 'Bot' },
      labels: [],
    },
    'opened',
  );
  console.assert(botIssue.shouldTriage === false, 'Bot issue should be skipped');
  console.assert(botIssue.skipReason === 'bot_author', 'Skip reason should be bot_author');

  // PR (has pull_request field)
  const prIssue = evaluate(
    {
      number: 3,
      title: 'Fix: something',
      body: null,
      pull_request: { url: 'https://...' },
      user: { login: 'yasha-dev1' },
      labels: [],
    },
    'opened',
  );
  console.assert(prIssue.shouldTriage === false, 'PR should be skipped');
  console.assert(prIssue.skipReason === 'pull_request', 'Skip reason should be pull_request');

  // Already triaged
  const triagedIssue = evaluate(
    {
      number: 4,
      title: 'Feature request',
      body: 'Add dark mode',
      user: { login: 'yasha-dev1' },
      labels: [{ name: 'agent:implement' }],
    },
    'opened',
  );
  console.assert(triagedIssue.shouldTriage === false, 'Already triaged issue should be skipped');
  console.assert(
    triagedIssue.skipReason === 'already_triaged',
    'Skip reason should be already_triaged',
  );

  // Edit with needs-more-info \u2192 re-triage
  const retriageIssue = evaluate(
    {
      number: 5,
      title: 'Bug report',
      body: 'Updated with more details...',
      user: { login: 'yasha-dev1' },
      labels: [{ name: 'needs-more-info' }],
    },
    'edited',
  );
  console.assert(retriageIssue.shouldTriage === true, 'Re-triage should proceed');
  console.assert(retriageIssue.isRetriage === true, 'Should be flagged as re-triage');

  // Edit on never-triaged issue \u2192 initial triage (e.g. issue predates workflow)
  const editNeverTriaged = evaluate(
    {
      number: 6,
      title: 'Feature',
      body: 'Updated',
      user: { login: 'yasha-dev1' },
      labels: [{ name: 'bug' }],
    },
    'edited',
  );
  console.assert(
    editNeverTriaged.shouldTriage === true,
    'Edit on never-triaged issue should proceed with triage',
  );
  console.assert(editNeverTriaged.isRetriage === false, 'Should not be flagged as re-triage');

  // Edit on already-triaged issue (without needs-more-info) \u2192 skip
  const editAlreadyTriaged = evaluate(
    {
      number: 7,
      title: 'Feature',
      body: 'Updated',
      user: { login: 'yasha-dev1' },
      labels: [{ name: 'agent:implement' }],
    },
    'edited',
  );
  console.assert(
    editAlreadyTriaged.shouldTriage === false,
    'Edit on already-triaged issue should skip',
  );
  console.assert(
    editAlreadyTriaged.skipReason === 'edit_already_triaged',
    'Skip reason should be edit_already_triaged',
  );

  console.log('\\n\u2714 All self-tests passed.');
}
`;
}

function buildIssueTriagePromptMd(): string {
  return `# Issue Triage Agent Instructions

You are a triage agent. Your task is to evaluate a GitHub issue for quality, completeness, and actionability.

## Evaluation Criteria

### 1. Clear Description

- Does the issue clearly state what needs to happen?
- Is the problem or feature request understandable without additional context?
- Are there ambiguous terms that need clarification?

### 2. Reproducibility (for bugs)

- Are steps to reproduce provided?
- Is the expected vs actual behavior described?
- Is environment information included (OS, version, etc.)?

### 3. Acceptance Criteria

- Are success conditions explicitly stated or clearly inferable?
- Can you determine when the work would be "done"?

### 4. Scope

- Is the scope reasonable for a single PR?
- Should this be broken into smaller issues?
- Does it touch critical paths that require extra review?

## Bug Reproduction

If the issue appears to be a **UI bug** or **visual bug** and includes reproduction steps:

1. Check if the project has a dev server script (\`dev\`, \`start\`, or \`serve\` in package.json)
2. If a dev server is available, the CI workflow will attempt automated browser reproduction using Puppeteer
3. Factor the reproduction result into your confidence score:
   - **Reproduced**: Boost confidence \u2014 the bug is confirmed real
   - **Not reproduced**: Lower confidence \u2014 ask for better reproduction steps
   - **Reproduction skipped**: No change \u2014 assess based on description quality alone

When assessing bug reports, pay special attention to:

- Specific URLs or pages where the issue occurs
- Browser/OS information
- Whether the steps are detailed enough for automated reproduction
- Screenshots or error messages included in the report

## Output Format

You MUST return a JSON object with exactly this structure:

\`\`\`json
{
  "actionable": boolean,
  "confidence": number,
  "missingInfo": string[],
  "summary": string,
  "suggestedLabels": string[],
  "estimatedComplexity": "low" | "medium" | "high",
  "reproduced": boolean | null,
  "reproductionNotes": string
}
\`\`\`

### Field Definitions

- **actionable**: true if the issue has enough information to be implemented
- **confidence**: 0.0 to 1.0, how confident you are in your assessment
- **missingInfo**: list of specific things the author should add (empty array if actionable)
- **summary**: one-line summary of what the issue is asking for
- **suggestedLabels**: suggested labels (e.g., "bug", "enhancement", "documentation", "performance")
- **estimatedComplexity**: "low" (< 1 hour), "medium" (1-4 hours), "high" (> 4 hours or multi-file)
- **reproduced**: true if the bug was confirmed via browser reproduction, false if reproduction failed, null if reproduction was not attempted (not a UI bug, no dev server, etc.)
- **reproductionNotes**: brief notes about the reproduction attempt (empty string if not attempted)

Return ONLY the JSON object. No markdown fences, no explanation, no extra text.
`;
}

/* eslint-enable no-useless-escape */
