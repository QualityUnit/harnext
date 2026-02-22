import type { DetectionResult, UserPreferences } from './types.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';
import { getKiroCISafetyRules } from '../core/ci-agent-steps.js';

/**
 * Prompt for generating the remediation loop workflow and agent.
 */
export function buildRemediationLoopPrompt(
  detection: DetectionResult,
  prefs: UserPreferences,
  instructionFile = 'CLAUDE.md',
): string {
  const agentAction = CI_AGENT_ACTIONS[prefs.aiPlatform];
  return `Generate an automated remediation loop system for this ${detection.primaryLanguage} project. This system allows an AI agent to automatically fix issues found by the review agent, push corrective commits, and trigger re-review.

## Detected Stack Context

- **Language**: ${detection.primaryLanguage}
- **Framework**: ${detection.framework ?? 'none'}
- **CI Provider**: ${prefs.ciProvider}
- **Strictness**: ${prefs.strictnessLevel}
- **Test Command**: \`${detection.testCommand ?? 'not detected'}\`
- **Lint Command**: \`${detection.lintCommand ?? 'not detected'}\`
- **Build Command**: \`${detection.buildCommand ?? 'not detected'}\`
- **Type Checker**: ${detection.typeChecker ?? 'none'}

## Files to Generate

### 1. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/remediation-agent.yml' : 'CI remediation workflow'}

A CI workflow that triggers automated code fixes when the review agent finds actionable issues.

**Trigger**: \`workflow_dispatch\` (called by the review agent workflow or manually) with inputs:
- \`pr_number\`: The PR to remediate
- \`head_sha\`: The commit SHA to fix against
- \`findings\`: JSON array of actionable review findings

**Guard Rails** (critical for safety):
${
  prefs.strictnessLevel === 'strict'
    ? '- **Strict mode**: Only auto-fix lint and type errors. Logic fixes require human approval.\n- Maximum 3 remediation attempts per PR before requiring human intervention.\n- All remediation commits must include clear audit trail.'
    : prefs.strictnessLevel === 'standard'
      ? '- **Standard mode**: Auto-fix lint, type, and simple logic errors (missing null checks, error handling).\n- Maximum 5 remediation attempts per PR.\n- Remediation commits are labeled with [remediation] prefix.'
      : '- **Relaxed mode**: Auto-fix all types of issues the agent is confident about.\n- Maximum 10 remediation attempts per PR.'
}
- NEVER auto-remediate security findings — those always require human review
- NEVER modify CI workflow files, harness.config.json, ${instructionFile}, or lock files
- Track attempt count via PR labels (\`remediation-attempt-1\`, \`remediation-attempt-2\`, etc.)

**Workflow steps**:

1. **Pre-flight checks**:
   - Verify the review agent's verdict was REQUEST_CHANGES
   - Check the remediation attempt counter
   - If attempts >= limit, post comment: "Remediation limit reached. Human review required." and exit
   - If any finding is security-related, skip remediation entirely

2. **Baseline validation**:
   - Checkout the PR branch at HEAD
   - Run quality gates and record which checks are currently passing and failing:
     - \`${detection.lintCommand ?? 'echo "no linter"'}\`
     ${detection.typeChecker ? `- Type check: \`${detection.typeChecker === 'typescript' ? 'tsc --noEmit' : detection.typeChecker + ' --check .'}\`` : ''}
     - \`${detection.testCommand ?? 'echo "no tests"'}\`
   - This baseline distinguishes pre-existing failures from failures introduced by the PR
   - Record the baseline in the PR comment so reviewers can see the starting state
   - Proceed with remediation regardless of baseline state — the agent must not introduce additional failures

3. **Context gathering**:
   - Parse the review agent's comment to extract issues (file paths, line numbers, descriptions, severities)
   - Read ${instructionFile} for coding conventions
   - Read harness.config.json for project rules

4. **Remediation execution**:
   - Invoke the AI agent using \`${agentAction.action}\` with \`${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}\`
   - Pass the remediation prompt via the action's \`prompt\` input
   - The agent fixes ONLY the flagged issues — no refactoring, no improvements
   - After each fix, run validation:
     - \`${detection.lintCommand ?? 'echo "no linter"'}\`
     ${detection.typeChecker ? `- Type check: \`${detection.typeChecker === 'typescript' ? 'tsc --noEmit' : detection.typeChecker + ' --check .'}\`` : ''}
     - \`${detection.testCommand ?? 'echo "no tests"'}\`
   - If validation fails after a fix, revert that specific fix

5. **Commit and push**:
   - Stage only the files modified by remediation
   - Commit: \`fix: [remediation] <brief description of fixes>\`
   - Include in commit body: which findings were fixed and which were skipped
   - Push to the PR branch
   - Add/increment the remediation attempt label

6. **Trigger re-review**:
   - The push triggers the normal PR synchronize path
   - The rerun writer creates a re-review request for the new SHA
   - If all blocking issues are resolved, the review agent will APPROVE

**Permissions**: contents: write, pull-requests: write, id-token: write

### 2. scripts/remediation-agent-prompt.md

A pinned markdown prompt that the remediation agent uses as its system context:

\`\`\`markdown
# Remediation Agent Instructions

You are a code remediation agent. Your task is to fix specific review findings on a pull request.

## Rules

1. **Fix only what's reported**: Address ONLY the specific findings provided. Do not refactor surrounding code, add features, or "improve" things not mentioned.
2. **Minimal changes**: Make the smallest possible change that fully addresses each finding. Fewer changed lines = less risk.
3. **Preserve intent**: Understand the original author's intent and preserve it while fixing the issue.
4. **Run validation**: After each change, run the project's test and lint commands to ensure nothing breaks.
5. **Skip stale findings**: If a finding references code that no longer exists at HEAD, skip it and note why.
6. **Never bypass gates**: Do not modify CI configs, disable linters, add skip annotations, or circumvent quality gates.
7. **Pin to HEAD**: Only operate on files as they exist at the current HEAD SHA. Never use cached content.
8. **Audit trail**: For each fix, note the original finding and what was changed.

## Validation Commands

- Lint: \`${detection.lintCommand ?? 'echo "not configured"'}\`
- Type check: \`${detection.typeChecker ? (detection.typeChecker === 'typescript' ? 'tsc --noEmit' : detection.typeChecker + ' --check .') : 'N/A'}\`
- Test: \`${detection.testCommand ?? 'echo "not configured"'}\`

## Files You Must Never Modify

- CI/CD workflow files (.github/workflows/*, .gitlab-ci.yml, etc.)
- harness.config.json
- ${instructionFile}
- Lock files (package-lock.json, yarn.lock, poetry.lock, etc.)
- Authentication/authorization modules (unless the finding specifically targets them AND they are not in critical paths)

## Output

After making fixes, provide a structured summary:
- Findings addressed: list with file path and description of fix
- Findings skipped: list with reason (stale, security-related, unable to fix safely)
- Files modified: complete list
- Validation results: lint/type-check/test pass/fail
\`\`\`

### 3. scripts/remediation-guard.ts

A utility script that determines whether remediation should proceed:

\`\`\`typescript
interface RemediationDecision {
  shouldRemediate: boolean;
  attemptNumber: number;
  reason: string;
  securityBlockers: string[];  // security findings that block auto-remediation
  skippedFindings: string[];   // findings that cannot be auto-fixed
}
\`\`\`

The script:
- Reads the current remediation attempt count from PR labels
- Checks the maximum attempt limit based on strictness level
- Identifies security-related findings that must be skipped
- Returns a JSON decision object for the workflow to consume

## Safety Constraints

The remediation loop is the most safety-critical part of the harness after the risk-policy-gate. These constraints are non-negotiable:

- The agent must NEVER modify files outside the scope of the review findings
- All commits must be clearly attributed to the remediation bot
- The loop must be bounded (maximum attempts) to prevent infinite remediation cycles
- Pin the Claude model and configuration for reproducibility
- Never auto-merge remediation commits — they always go through the full review cycle
- Every remediation action must be logged in PR comments for audit

${prefs.aiPlatform === 'kiro' ? getKiroCISafetyRules() : ''}

## Output Format

Return the complete file contents for each file, separated by a comment line with the target file path. All YAML must be valid. All scripts must be executable. Do not wrap in markdown code fences.`;
}
