import type { DetectionResult, UserPreferences } from './types.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';

/**
 * Prompt for generating the review agent workflow and supporting scripts.
 */
export function buildReviewAgentPrompt(detection: DetectionResult, prefs: UserPreferences): string {
  const agentAction = CI_AGENT_ACTIONS[prefs.aiPlatform];
  return `Generate a review agent integration system for this ${detection.primaryLanguage} project. The review agent uses Claude to automatically review pull requests, provide structured feedback, and track review state with SHA deduplication.

## Detected Stack Context

- **Language**: ${detection.primaryLanguage}
- **Framework**: ${detection.framework ?? 'none'}
- **CI Provider**: ${prefs.ciProvider}
- **Strictness**: ${prefs.strictnessLevel}
- **Test Framework**: ${detection.testFramework ?? 'none'}
- **Linter**: ${detection.linter ?? 'none'}
- **Type Checker**: ${detection.typeChecker ?? 'none'}
- **Architectural Layers**: ${detection.architecturalLayers.join(', ') || 'none'}
- **Has UI Components**: ${detection.hasUIComponents}

## Files to Generate

### 1. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/code-review-agent.yml' : 'CI review agent workflow'}

A CI workflow triggered on pull_request events (opened, synchronize). It must:

- Check out the PR at the exact head SHA
- Read the risk-policy-gate output to determine the tier and changed files
- Skip if tier < 2 (Tier 1 changes don't need review agent)
- **When Tier 1 is detected**: post a SHA-deduped PR comment (marker: \`<!-- harness-tier1-skip: <head-sha> -->\`) informing the PR author that the review agent will not run for this tier. Check existing comments before posting to avoid duplicates on re-runs.
- Perform SHA deduplication before running (see below)
- Invoke Claude Code to review the diff with the review prompt
- Post a structured review comment on the PR
- Report a check run status (success/failure/neutral) tied to the head SHA

**Permissions**: contents: read, pull-requests: write, checks: write, issues: write, actions: write, id-token: write

**SHA Deduplication**: Before running the full review, check if this SHA was already reviewed:
- Search PR comments for the marker \`<!-- harness-review: <head-sha> -->\`
- If found, skip the review and exit with success status
- This prevents duplicate reviews when CI re-triggers without new commits

**Review comment structure:**
- **Risk Assessment**: Confirmed tier and reasoning
- **Issues Found**: Categorized as blocking, warning, or suggestion
- **Architecture**: Layer boundary compliance check
- **Test Coverage**: Assessment of test adequacy for the changes
- **Verdict**: APPROVE, REQUEST_CHANGES, or COMMENT
- Verdict marker: \`<!-- review-verdict: <verdict> -->\` (used by the review-fix dispatch step)
- SHA marker: \`<!-- harness-review: <sha> -->\`

**Two-step verdict flow:**
After the review completes, the workflow:
1. Posts the raw review as a PR comment (natural markdown, human-readable)
2. Runs a second, cheaper Claude call (Haiku, \`--json\` structured output) to classify the review into APPROVE / REQUEST_CHANGES / COMMENT
3. Updates the review comment with the verdict and a \`<!-- review-verdict: X -->\` marker
4. If verdict is \`REQUEST_CHANGES\` and the PR has the \`agent-pr\` label, dispatches the issue-implementer workflow in review-fix mode
5. Counts \`review-fix-cycle-N\` labels on the PR to determine the cycle number (max 3)
6. After 3 failed cycles, adds \`agent:needs-judgment\` label and escalates to human review

**Strictness behavior:**
- \`${prefs.strictnessLevel}\` mode:
${
  prefs.strictnessLevel === 'relaxed'
    ? '  - Focus only on bugs and security issues\n  - Suggestions are informational, not blocking'
    : prefs.strictnessLevel === 'standard'
      ? '  - Include style, architecture, and test coverage feedback\n  - Blocking findings require fix before merge'
      : '  - Comprehensive review covering all categories\n  - Any warning-level finding blocks merge\n  - Require explicit test coverage for every changed function'
}

### 2. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/review-agent-rerun.yml' : 'CI review rerun workflow'}

A SHA-deduped rerun comment writer workflow:

**Purpose**: After every PR synchronize event (new push), post exactly ONE rerun comment per SHA to trigger the review agent. This prevents duplicate rerun requests when multiple workflows fire for the same push.

**Key logic** (as a script step):
\`\`\`typescript
const marker = '<!-- review-agent-auto-rerun -->';
const trigger = \\\`sha:\${headSha}\\\`;

// Fetch existing PR comments
const comments = await github.rest.issues.listComments({
  owner, repo, issue_number: prNumber
});

// Check if we already requested a rerun for this SHA
const alreadyRequested = comments.data.some((c) =>
  c.body?.includes(marker) && c.body?.includes(trigger)
);

if (!alreadyRequested) {
  await github.rest.issues.createComment({
    owner, repo, issue_number: prNumber,
    body: \\\`\${marker}\\n@review-agent please re-review\\n\${trigger}\\\`
  });
}
\`\`\`

The SHA deduplication is critical: without it, multiple concurrent workflow runs can create duplicate rerun requests, leading to wasted API calls and confusing PR comment threads.

### 3. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/auto-resolve-threads.yml' : 'CI auto-resolve workflow'}

A workflow that runs after a clean review-agent rerun to auto-resolve stale bot-only conversation threads:

**Trigger**: When the code-review-agent check run completes with success.

**Logic**:
1. List all PR review threads (conversations)
2. For each unresolved thread:
   a. Check if ALL comments in the thread are from the review bot (no human participation)
   b. If bot-only AND the latest review for current HEAD SHA passed: auto-resolve the thread
   c. If any human has commented in the thread: NEVER auto-resolve (preserve human feedback)
3. After resolving threads, trigger a re-evaluation so that branch protection reflects the new state
4. Post a summary comment: "Auto-resolved N bot threads addressed in commit <sha>"

**Safety rules**:
- Never auto-resolve threads with human comments
- Only resolve after a passing review for the exact current HEAD SHA
- Stale review results (old SHAs) must be ignored

### 4. scripts/review-agent-utils.ts

Shared utility functions for review agent workflows:

- \`isReviewBotComment(comment: { user: { login: string } }): boolean\` — check if a comment is from the review bot
- \`isThreadBotOnly(thread: Comment[]): boolean\` — check if all comments in a thread are from the bot
- \`getLatestReviewRunForSha(owner: string, repo: string, sha: string): Promise<CheckRun | null>\` — fetch the latest review agent check run for a specific SHA
- \`getHeadSha(): string\` — get the current PR head SHA from CI environment

### 5. Review Agent Prompt

The review agent's instructions are stored at \`.codefactory/prompts/review-agent.md\` in the repository. This file is managed by the CodeFactory CLI and can be customized by the team.

**The workflow must read this file at runtime** and pass its contents to Claude as the system prompt. For example in a GitHub Actions step:
\`\`\`yaml
- name: Read review prompt
  id: prompt
  run: echo "content=$(cat .codefactory/prompts/review-agent.md)" >> "$GITHUB_OUTPUT"
\`\`\`

Do NOT generate a separate \`scripts/review-prompt.md\` file. The prompt lives in \`.codefactory/prompts/review-agent.md\` and is the single source of truth.

The review agent workflow should use \`${agentAction.action}\` with \`${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}\` for authentication. Do NOT use raw API keys directly.

**IMPORTANT — Extracting the agent's response**: ${agentAction.executionFileOutputKey ? `The action's response is available via the \`${agentAction.executionFileOutputKey}\` output — a JSON array of SDK turn objects (NOT JSONL, do NOT use \`jq -s\`). Turn types: \`system\` (init), \`assistant\` (responses with \`.message.content[]\`), \`user\` (tool results), \`result\` (final summary with \`.result\` text).` : `The action's response is available via the \`${agentAction.textOutputKey}\` output.`} To extract:
\`\`\`yaml
- name: Run AI review
  id: review
  uses: ${agentAction.action}
  with:
    ${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}
    ${agentAction.promptInputKey}: |
      Review this pull request for bugs, security issues, and architectural violations.${agentAction.argsInputKey ? `\n    ${agentAction.argsInputKey}: '--max-turns 100 --allowedTools "Read,Glob,Grep,Bash"'` : ''}${prefs.aiPlatform === 'claude' ? `\n    allowed_bots: 'github-actions,implementer-bot'` : ''}

- name: Extract review output
  id: extract
  env:
    ${agentAction.executionFileOutputKey ? `EXECUTION_FILE: \${{ steps.review.outputs.${agentAction.executionFileOutputKey} }}` : `FINAL_MESSAGE: \${{ steps.review.outputs.${agentAction.textOutputKey} }}`}
  run: |${
    agentAction.executionFileOutputKey
      ? `
    # Primary: final result text from the "result" turn
    REVIEW_TEXT=$(jq -r '[.[] | select(.type == "result")] | last | .result // ""' "$EXECUTION_FILE" 2>/dev/null || echo "")
    # Fallback: last assistant text content
    if [[ -z "$REVIEW_TEXT" || "$REVIEW_TEXT" == "null" ]]; then
      REVIEW_TEXT=$(jq -r '[.[] | select(.type == "assistant") | .message.content[] | select(.type == "text") | .text] | last // ""' "$EXECUTION_FILE" 2>/dev/null || echo "")
    fi`
      : `
    REVIEW_TEXT="$FINAL_MESSAGE"`
  }
    if [[ -n "$REVIEW_TEXT" && "$REVIEW_TEXT" != "null" ]]; then
      { echo "review<<REVIEW_EOF"; echo "$REVIEW_TEXT"; echo "REVIEW_EOF"; } >> "$GITHUB_OUTPUT"
      echo "found=true" >> "$GITHUB_OUTPUT"
    else
      echo "found=false" >> "$GITHUB_OUTPUT"
    fi
\`\`\`

The available action outputs are: ${agentAction.executionFileOutputKey ? `\`${agentAction.executionFileOutputKey}\`, ` : ''}${agentAction.structuredOutputKey ? `\`${agentAction.structuredOutputKey}\` (only with \`--json-schema\`), ` : ''}\`${agentAction.textOutputKey}\`. There is NO \`result\` output.

## SHA Discipline

- The rerun writer MUST deduplicate by SHA — one rerun comment per SHA, no duplicates
- Auto-resolve MUST only act after a passing review for the current HEAD SHA
- The review agent check run MUST be tied to the exact commit SHA being reviewed
- Stale review results (for old SHAs) must never be used in decisions

## Quality Requirements

- All workflows should use \`actions/github-script@v7\` for GitHub API interactions
- Pin all action versions to specific SHAs or major versions for security
- Include proper error handling and clear logging at each step
- Set appropriate timeout-minutes (15 for review, 5 for rerun/auto-resolve)
- Use concurrency groups to prevent parallel runs on the same PR

## Output Format

Return the complete file contents for each file, separated by a comment line with the target file path. All YAML must be valid. All scripts must be executable. Do not wrap in markdown code fences.`;
}
