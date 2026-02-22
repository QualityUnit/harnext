import type { DetectionResult, UserPreferences } from './types.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';
import { getKiroCISafetyRules } from '../core/ci-agent-steps.js';

/**
 * Prompt for generating the issue-implementer agent workflow and supporting scripts.
 */
export function buildIssueImplementerPrompt(
  detection: DetectionResult,
  prefs: UserPreferences,
  instructionFile = 'CLAUDE.md',
): string {
  const agentAction = CI_AGENT_ACTIONS[prefs.aiPlatform];
  return `Generate an issue-implementer agent system for this ${detection.primaryLanguage} project. When a new issue is opened (or labeled with a trigger label), the system spawns a Claude Code agent that reads the issue, creates a worktree branch, implements the change, and opens a pull request.

## Detected Stack Context

- **Language**: ${detection.primaryLanguage}
- **Framework**: ${detection.framework ?? 'none'}
- **CI Provider**: ${prefs.ciProvider}
- **Strictness**: ${prefs.strictnessLevel}
- **Test Command**: \`${detection.testCommand ?? 'not detected'}\`
- **Lint Command**: \`${detection.lintCommand ?? 'not detected'}\`
- **Build Command**: \`${detection.buildCommand ?? 'not detected'}\`
- **Type Checker**: ${detection.typeChecker ?? 'none'}
- **Package Manager**: ${detection.packageManager ?? 'npm'}
- **Monorepo**: ${detection.monorepo}
- **Architectural Layers**: ${detection.architecturalLayers.join(', ') || 'none'}
- **Has UI Components**: ${detection.hasUIComponents}
- **Critical Paths**: ${detection.criticalPaths.length > 0 ? detection.criticalPaths.join(', ') : 'none detected'}

## Files to Generate

### 1. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/issue-implementer.yml' : prefs.ciProvider === 'gitlab-ci' ? '.gitlab/ci/issue-implementer.yml' : 'bitbucket-pipelines-issue-implementer.yml'}

A CI workflow triggered when a new issue is opened or labeled with the trigger label \`agent:implement\`, OR dispatched by the triage workflow, OR dispatched by the review agent in review-fix mode.

**Trigger** (CRITICAL — dual trigger for event chaining + review-fix):
${
  prefs.ciProvider === 'github-actions'
    ? `\`\`\`yaml
on:
  issues:
    types: [opened, labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to implement'
        required: false
        type: string
      pr_number:
        description: 'PR number for review-fix mode'
        required: false
        type: string
      review_fix_cycle:
        description: 'Review-fix cycle number (1-3)'
        required: false
        type: string
\`\`\`

**IMPORTANT**: The \`workflow_dispatch\` trigger is required because GitHub Actions does NOT trigger \`labeled\` events from actions performed using the default \`GITHUB_TOKEN\`. When the triage workflow adds the \`agent:implement\` label, the \`labeled\` event is suppressed to prevent infinite loops. The triage workflow dispatches this workflow explicitly via \`gh workflow run\`.

**Review-fix mode**: When dispatched with \`pr_number\` and \`review_fix_cycle\`, the workflow enters review-fix mode:
- Checks out the existing PR branch (instead of creating a new one)
- Extracts the latest review feedback from PR comments (via \`<!-- review-verdict: REQUEST_CHANGES -->\` marker)
- Builds a focused prompt with the review feedback as context
- Runs Claude to fix only the flagged issues
- Pushes to the existing branch (triggering a new review cycle)
- Max 3 cycles — after that, escalates with \`agent:needs-judgment\`

When triggered via \`workflow_dispatch\` (issue mode):
- \`github.event.issue\` and \`context.issue\` are NOT available
- The workflow must fetch issue data via \`gh issue view <number> --json number,title,body,labels,author\`
- All downstream steps must derive issue references from the guard output (not from context)
- \`github.event.repository.default_branch\` is not available — use a fallback: \`github.event.repository.default_branch || 'main'\``
    : prefs.ciProvider === 'gitlab-ci'
      ? 'Trigger via webhook on issue creation or label change. Use a CI job that checks for the `agent:implement` label.'
      : 'Trigger via webhook on issue creation. Use a pipeline that checks for the `agent:implement` label.'
}

**Permissions** (${prefs.ciProvider === 'github-actions' ? 'GitHub Actions' : prefs.ciProvider}):
- contents: write (to push branches)
- pull-requests: write (to create PRs)
- issues: write (to comment status updates on the issue)
- id-token: write (required for Claude Code Action OAuth)

**Workflow steps**:

1. **Fetch issue data** (workflow_dispatch only):
   - When \`github.event_name == 'workflow_dispatch'\`, fetch the issue via:
     \`\`\`bash
     gh issue view "\${{ inputs.issue_number }}" --json number,title,body,labels,author \\
       | jq '{number, title, body, labels, user: {login: .author.login}}'
     \`\`\`
   - Note: \`gh\` CLI uses \`author\`, not \`user\` — remap to match \`github.event.issue\` shape
   - Store the result as a step output for the guard and prompt-building steps

2. **Gate check** (via guard script):
   - Pass \`ISSUE_JSON\` from either the fetched data (workflow_dispatch) or \`toJSON(github.event.issue)\` (issues event)
   - Verify the issue has the \`agent:implement\` label
   - Skip if the issue already has a linked PR (check for \`<!-- issue-implementer: #<issue> -->\` marker in issue comments)
   - Skip if the issue has blocking labels (\`agent:skip\`, \`wontfix\`, \`duplicate\`, \`invalid\`)
   - Derive branch name from issue title
   - **Output**: \`should-implement\`, \`branch\`, \`reason\`, \`issue-number\`, \`issue-title\` — all downstream steps reference the guard's outputs for issue data (NOT \`context.issue\` which is empty for workflow_dispatch)
   - Post a comment on the issue: "Implementation agent starting..."

3. **Branch creation**:
   - Derive branch name from guard output: \`cf/<slugified-issue-title>-<issue-number>\`
   - Truncate the slug to keep branch name under 60 characters
   - Delete stale remote branch if it exists (from a previous failed run)
   - Create from \`origin/<default-branch>\` — use \`github.event.repository.default_branch || 'main'\` as fallback

4. **Baseline validation**:
   - Before invoking the agent, run quality gates on the branch HEAD to record the starting state:
     - \`${detection.lintCommand ?? 'echo "no linter"'}\`
     ${detection.typeChecker ? `- Type check: \`${detection.typeChecker === 'typescript' ? 'tsc --noEmit' : detection.typeChecker + ' --check .'}\`` : ''}
     - \`${detection.testCommand ?? 'echo "no tests"'}\`
     ${detection.buildCommand ? `- Build: \`${detection.buildCommand}\`` : ''}
   - Record which checks pass and which fail as the baseline
   - The agent must not introduce regressions — if a check was passing at baseline, it must still pass after changes

5. **Build implementation prompt**:
   - Read the implementer prompt from \`.codefactory/prompts/issue-implementer.md\`
   - Parse \`ISSUE_JSON\` (from fetched data or event payload) to extract issue fields
   - Combine: prompt template + issue details + ${instructionFile} conventions + harness config + baseline state
   - For workflow_dispatch: use \`(issue.user || {}).login || 'unknown'\` for safe author access

6. **Agent execution**:
   - Invoke the AI agent using \`${agentAction.action}\` with \`${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}\`
   - Pass the built prompt via the action's \`${agentAction.promptInputKey}\` input
   - The agent reads ${instructionFile} and harness.config.json for project conventions${agentAction.argsInputKey ? `\n   - Set \`--max-turns 100 --allowedTools "Edit,Write,Read,Glob,Grep,Bash"\` in \`${agentAction.argsInputKey}\`` : ''}${prefs.aiPlatform === 'claude' ? `\n   - Set \`allowed_bots: 'github-actions'\` — this workflow is dispatched by other workflows using \`GITHUB_TOKEN\`, so the actor is \`github-actions[bot]\`. Without \`allowed_bots\`, the action rejects bot-initiated runs.` : ''}
   - Set a timeout of ${prefs.strictnessLevel === 'strict' ? '30' : prefs.strictnessLevel === 'standard' ? '45' : '60'} minutes

7. **Post-implementation checks**:
   - Check for file changes (both modified and new files)
   - If no changes, log notice and skip PR creation
   - Verify no protected files were modified: \`.github/workflows/*\`, \`harness.config.json\`, \`${instructionFile}\`, lock files
   - If protected files were touched, revert them via \`git checkout -- <file>\`

8. **Quality gates** (regression-only):
   - Run all quality gates: lint, type-check, test, build
   - Compare against baseline — only FAIL on regressions (a check that was passing but now fails)
   - If a check was already failing at baseline, a continued failure is NOT a regression

9. **PR creation** (CRITICAL — use the exact pattern below):
   - Stage all changes, commit: \`feat: implement #<issue-number> — <issue-title>\`
   - Push the branch
   - Create a pull request using the robust pattern below (NEVER use \`2>&1\` which hides errors)
   - Body must include: implementation summary, quality gates results table, \`Closes #<issue-number>\`, and \`<!-- issue-implementer: #<issue-number> -->\`
   - **Split PR creation and issue comment into separate steps** so a \`gh pr create\` failure is visible in logs and does not prevent the failure handler from running

   Use this exact YAML pattern for the Create PR step:
   \`\`\`yaml
   - name: Create PR
     id: create-pr
     env:
       GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
       BRANCH: \${{ steps.guard.outputs.branch }}
       ISSUE_NUMBER: \${{ steps.guard.outputs.issue-number }}
       ISSUE_TITLE: \${{ steps.guard.outputs.issue-title }}
       LINT: \${{ steps.gates.outputs.lint }}
       TYPE_CHECK: \${{ steps.gates.outputs.type-check }}
       TEST: \${{ steps.gates.outputs.test }}
       BUILD: \${{ steps.gates.outputs.build }}
       FILE_COUNT: \${{ steps.changes.outputs.file-count }}
     run: |
       git config user.name "github-actions[bot]"
       git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
       git add -A
       git commit -m "feat: implement #\${ISSUE_NUMBER} — \${ISSUE_TITLE}" || true
       git push origin "\${BRANCH}"

       LINT_STATUS=$([[ "$LINT" == "true" ]] && echo "PASS" || echo "FAIL")
       TYPE_STATUS=$([[ "$TYPE_CHECK" == "true" ]] && echo "PASS" || echo "FAIL")
       TEST_STATUS=$([[ "$TEST" == "true" ]] && echo "PASS" || echo "FAIL")
       BUILD_STATUS=$([[ "$BUILD" == "true" ]] && echo "PASS" || echo "FAIL")

       BODY=$(printf '<!-- issue-implementer: #%s -->\\n\\n## Summary\\n\\nAutomated implementation for #%s — %s\\n\\n## Quality Gates\\n\\n| Check | Status |\\n|-------|--------|\\n| Lint | %s |\\n| Type Check | %s |\\n| Tests | %s |\\n| Build | %s |\\n\\n**Files changed**: %s\\n\\nCloses #%s' \\
         "$ISSUE_NUMBER" "$ISSUE_NUMBER" "$ISSUE_TITLE" \\
         "$LINT_STATUS" "$TYPE_STATUS" "$TEST_STATUS" "$BUILD_STATUS" \\
         "$FILE_COUNT" "$ISSUE_NUMBER")

       echo "Creating PR for branch \${BRANCH}..."
       PR_URL=$(gh pr create \\
         --title "feat: \${ISSUE_TITLE}" \\
         --body "$BODY" \\
         --label "agent-pr" \\
         --head "\${BRANCH}" \\
         --base "\${DEFAULT_BRANCH:-main}")

       echo "pr-url=\${PR_URL}" >> "$GITHUB_OUTPUT"
       echo "PR created: \${PR_URL}"
   \`\`\`

   **Key points**: stderr is NOT redirected — errors appear in the workflow log. The body is built with \`printf\` (not heredocs which break YAML block scalars). The \`--base\` flag is always explicit.

10. **Escalation (failure handler)**:
   - If any step fails and the guard approved implementation:
     - Add the \`agent:needs-judgment\` label (create if it doesn't exist)
     - Post a comment with the branch name and run link for debugging

**Concurrency**: Use a concurrency group keyed on the issue number to prevent duplicate runs:
\`\`\`yaml
concurrency:
  group: issue-implementer-$\{{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false
\`\`\`

Note: \`cancel-in-progress: false\` — implementation runs should complete rather than be cancelled.

**Strictness behavior**:
${prefs.strictnessLevel === 'strict' ? '- Agent must pass ALL quality gates (lint, type-check, test, build) before creating a PR\n- If any Tier 3 (critical path) file is modified, add the `needs-human-review` label to the PR and escalate for sign-off\n- Maximum 2 remediation attempts in the quality gate loop before escalating' : prefs.strictnessLevel === 'standard' ? '- Agent must pass lint and type-check gates. Test failures enter the detect→remediate loop.\n- Modified critical paths get flagged in the PR description\n- Maximum 3 remediation attempts in the quality gate loop before escalating' : '- Agent runs quality gates but can create a PR with documented warnings if gates cannot be resolved\n- Failures are recorded in the PR description with diagnosis notes\n- Maximum 5 remediation attempts in the quality gate loop before escalating'}

### 2. Implementer prompt

The implementer agent's instructions are stored at \`.codefactory/prompts/issue-implementer.md\` in the repository. This file is managed by the CodeFactory CLI and can be customized by the team.

**The workflow must read this file at runtime** and pass its contents to Claude as the system prompt. Use a multi-line HEREDOC output pattern:
\`\`\`yaml
- name: Read implementer prompt
  id: prompt-file
  run: |
    if [[ -f ".codefactory/prompts/issue-implementer.md" ]]; then
      {
        echo "content<<PROMPT_EOF"
        cat .codefactory/prompts/issue-implementer.md
        echo "PROMPT_EOF"
      } >> "$GITHUB_OUTPUT"
    else
      echo "content=Implement the feature or fix described in the issue." >> "$GITHUB_OUTPUT"
    fi
\`\`\`

Do NOT generate a separate \`scripts/issue-implementer-prompt.md\` file. The prompt lives in \`.codefactory/prompts/issue-implementer.md\` and is the single source of truth.

### 3. scripts/issue-implementer-guard.ts

A TypeScript utility script that determines whether the implementer agent should run:

\`\`\`typescript
interface ImplementerDecision {
  shouldImplement: boolean;
  issueNumber: number;
  issueTitle: string;
  branchName: string;
  reason: string;
  existingPR: number | null;  // non-null if a PR already exists for this issue
  blockedLabels: string[];    // labels that prevent implementation
}
\`\`\`

The script:
- Uses shebang: \`#!/usr/bin/env npx tsx\`
- Reads the issue payload from \`ISSUE_JSON\` environment variable (issue mode) or \`PR_NUMBER\`/\`REVIEW_FIX_CYCLE\` (review-fix mode)
- Exports public functions: \`slugify()\`, \`deriveBranchName()\`, \`findExistingPR()\`, \`evaluate()\`, \`evaluateReviewFix()\`
- Supports \`--evaluate\` CLI mode (outputs JSON decision) and \`--self-test\` mode (runs built-in assertions)
- **Issue mode** (\`ISSUE_JSON\` set): checks for \`agent:implement\` label, blocking labels, existing PRs, derives branch name
- **Review-fix mode** (\`PR_NUMBER\` set): verifies cycle <= 3, PR is OPEN, returns branch name from PR
- Returns a JSON decision object used by downstream workflow steps

## Critical: No Plan Mode in CI

The generated \`.codefactory/prompts/issue-implementer.md\` MUST instruct the agent to **never use plan mode** (\`EnterPlanMode\`/\`ExitPlanMode\`). The agent runs in CI with no human to approve plans. If it enters plan mode, it will stall and the workflow will produce zero file changes. The prompt must explicitly say: "Execute changes directly using Read, Write, Edit, and Bash tools. Do NOT call EnterPlanMode or ExitPlanMode."

Similarly, the agent must NOT run git commands (commit, push) — the CI workflow handles all git operations after the agent finishes.

## Safety Constraints

- The agent must NEVER modify CI workflow files, harness.config.json, ${instructionFile}, or lock files
- All commits must be clearly attributed to the implementer bot
- The agent operates on a dedicated branch — never pushes to main/default branch
- Set a hard timeout to prevent runaway execution
- If the issue references Tier 3 (critical) paths, flag the PR for human review
- Never auto-merge agent-created PRs — they always go through the full review cycle
- Every implementation action must be logged in issue comments for audit
- The agent must not access secrets or environment variables beyond what the CI provides

## Quality Requirements

- All workflows should use \`actions/github-script@v7\` for GitHub API interactions (if GitHub Actions)
- Pin all action versions to specific SHAs or major versions for security
- Include proper error handling and clear logging at each step
- Set appropriate timeout-minutes for the workflow
- Use concurrency groups to prevent parallel runs on the same issue

${prefs.aiPlatform === 'kiro' ? getKiroCISafetyRules() : ''}

## Output Format

Return the complete file contents for each file, separated by a comment line with the target file path. All YAML must be valid. All scripts must be executable. Do not wrap in markdown code fences.`;
}
