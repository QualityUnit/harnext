import type { DetectionResult, UserPreferences } from './types.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';

/**
 * Prompt for generating the issue-triage agent workflow and supporting scripts.
 */
export function buildIssueTriagePrompt(detection: DetectionResult, prefs: UserPreferences): string {
  const agentAction = CI_AGENT_ACTIONS[prefs.aiPlatform];
  return `Generate an issue-triage agent system for this ${detection.primaryLanguage} project. When a new issue is opened or edited, the system evaluates it for quality and completeness, then routes actionable issues to the planning pipeline by adding the \`agent:plan\` label.

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

### 1. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/issue-triage.yml' : prefs.ciProvider === 'gitlab-ci' ? '.gitlab/ci/issue-triage.yml' : 'bitbucket-pipelines-issue-triage.yml'}

A CI workflow triggered when a new issue is opened, edited, or reopened.

**Trigger**:
${
  prefs.ciProvider === 'github-actions'
    ? `\`\`\`yaml
on:
  issues:
    types: [opened, edited, reopened]
\`\`\`

The workflow runs on every issue open, edit, and reopen event. The guard script determines whether triage should proceed (e.g., skip bots, skip already-triaged, allow re-triage on edit when \`needs-more-info\` is present).`
    : prefs.ciProvider === 'gitlab-ci'
      ? 'Trigger via webhook on issue creation or update. Use a CI job that runs the triage guard first.'
      : 'Trigger via webhook on issue creation or update. Use a pipeline that runs the triage guard first.'
}

**Permissions** (${prefs.ciProvider === 'github-actions' ? 'GitHub Actions' : prefs.ciProvider}):
- issues: write (to add labels and comments)
- contents: read (to read repo context)
- actions: write (to dispatch the implementer workflow after triage)
- id-token: write (required for Claude Code Action OAuth)

**Workflow steps**:

1. **Gate check** (via guard script):
   - Skip if the issue author is a bot (check \`github.actor\` ends with \`[bot]\` or is in known bot list, or user type is \`Bot\`)
   - Skip if the issue already has any triage result label (\`agent:plan\`, \`agent:implement\`, \`needs-human-review\`, \`wontfix\`, \`duplicate\`, \`invalid\`)
   - Skip if the event is actually a pull request (issues API can include PRs)
   - On \`edited\` events: only re-triage if the issue currently has \`needs-more-info\` label (author updated after feedback)
   - On \`edited\` events: if the issue was never triaged (no triage labels at all), proceed with initial triage (handles issues that predate the workflow)
   - Output a JSON decision for the workflow to consume

2. **Label setup**:
   - Ensure these labels exist in the repo (create if missing):
     - \`needs-more-info\` (color: \`FBCA04\`) — issue lacks required details
     - \`agent:plan\` (color: \`1D76DB\`) — issue is ready for planning agent
     - \`agent:implement\` (color: \`0E8A16\`) — issue is ready for implementation agent
     - \`triage:failed\` (color: \`D93F0B\`) — triage process errored
     - \`needs-human-review\` (color: \`C5DEF5\`) — issue needs manual assessment

3. **Claude triage analysis** (using structured output):
   - Write a JSON schema file defining the verdict structure:
     \`\`\`json
     {
       "type": "object",
       "required": ["actionable", "confidence", "summary", "suggestedLabels", "estimatedComplexity"],
       "properties": {
         "actionable": { "type": "boolean" },
         "confidence": { "type": "number" },
         "missingInfo": { "type": "array", "items": { "type": "string" } },
         "summary": { "type": "string" },
         "suggestedLabels": { "type": "array", "items": { "type": "string" } },
         "estimatedComplexity": { "type": "string", "enum": ["low", "medium", "high"] },
         "reproduced": { "type": ["boolean", "null"] },
         "reproductionNotes": { "type": "string" }
       },
       "additionalProperties": false
     }
     \`\`\`
   - Invoke the AI agent using \`${agentAction.action}\` with \`${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}\`
   - Pass the triage prompt and full issue title/body/labels via the action's \`${agentAction.promptInputKey}\` input${agentAction.structuredOutputKey ? `\n   - **CRITICAL**: Use \`--json-schema '<schema>'\` in \`${agentAction.argsInputKey}\` to force structured output. The verdict is then available via \`steps.<id>.outputs.${agentAction.structuredOutputKey}\` — this is the ONLY reliable way to get structured data from the action.` : `\n   - Parse the agent's text output to extract the structured verdict.`}
   - The agent evaluates the issue against quality criteria

4. **Parse structured verdict**:
   - Read \`steps.<claude-step>.outputs.structured_output\`
   - Parse as JSON and validate the required \`actionable\` field exists
   - Extract: actionable, confidence, complexity, summary, missingInfo, suggestedLabels
   - Determine if this is a UI bug for browser reproduction: only match labels like \`ui-bug\`, \`visual-bug\`, \`ui\`, \`frontend-bug\` — do NOT match plain \`bug\` label, as CLI/backend bugs should NOT trigger browser reproduction

5. **Decision routing**:
   - If \`actionable === true\` AND \`confidence >= ${prefs.strictnessLevel === 'strict' ? '0.8' : prefs.strictnessLevel === 'standard' ? '0.7' : '0.6'}\`:
     - Add the \`agent:plan\` label
     - Add any \`suggestedLabels\` that exist in the repo
     - Post a comment: "Triage complete — this issue is actionable and has been queued for planning."
   - If \`actionable === false\` OR confidence is below threshold:
     - Add the \`needs-more-info\` label
     - Post a comment with specific missing information from the verdict's \`missingInfo\` array
     - Include: "Edit this issue with the requested details and we will re-evaluate automatically."
   - If \`estimatedComplexity === "high"\` or the issue references critical paths:
     - Also add \`needs-human-review\` label
   - If parsing fails (no structured output or invalid JSON):
     - Add \`triage:failed\` label
     - Post comment indicating parse failure with raw output for debugging

6. **Dispatch planner workflow** (CRITICAL — GitHub Actions event chaining):
   - **IMPORTANT**: Labels added by \`GITHUB_TOKEN\` within a workflow do NOT trigger \`labeled\` events on other workflows. This is a GitHub security measure to prevent infinite loops.
   - After adding \`agent:plan\` label, the triage workflow MUST explicitly dispatch the planner workflow using:
     \`\`\`bash
     gh workflow run issue-planner.yml --field issue_number="<issue-number>"
     \`\`\`
   - This requires the \`actions: write\` permission (already listed above)
   - Only dispatch when \`agent:plan\` was actually added in this run

7. **Failure handling**:
   - If the triage agent crashes or times out:
     - Add the \`triage:failed\` label
     - Post a comment: "Automated triage encountered an error. A maintainer will review this issue manually."
   - Never leave the issue without a status label after triage runs

**Concurrency**: Use a concurrency group keyed on the issue number to prevent duplicate triage runs:
\`\`\`yaml
concurrency:
  group: issue-triage-$\{{ github.event.issue.number }}
  cancel-in-progress: true
\`\`\`

**Strictness behavior**:
${prefs.strictnessLevel === 'strict' ? '- Confidence threshold: 0.8\n- High complexity issues always require human review\n- Issues touching critical paths always require human review\n- Re-triage on edit only if `needs-more-info` label is present' : prefs.strictnessLevel === 'standard' ? '- Confidence threshold: 0.7\n- High complexity issues get flagged for human review\n- Re-triage on edit only if `needs-more-info` label is present' : '- Confidence threshold: 0.6\n- Only critical-path issues get flagged for human review\n- Re-triage on any edit event'}

### 2. Triage prompt

The triage agent's evaluation prompt is stored at \`.codefactory/prompts/issue-triage.md\` in the repository. This file is managed by the CodeFactory CLI and can be customized by the team.

**The workflow must read this file at runtime** and pass its contents to Claude as the system prompt. Use a multi-line HEREDOC output pattern:
\`\`\`yaml
- name: Read triage prompt
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
\`\`\`

Do NOT generate a separate \`scripts/issue-triage-prompt.md\` file. The prompt lives in \`.codefactory/prompts/issue-triage.md\` and is the single source of truth.

### 3. scripts/issue-triage-guard.ts

A TypeScript utility script that determines whether triage should run for this event:

\`\`\`typescript
interface TriageDecision {
  shouldTriage: boolean;
  issueNumber: number;
  issueTitle: string;
  reason: string;
  isRetriage: boolean;  // true if this is a re-triage after author updated the issue
  skipReason: string;   // empty string if shouldTriage is true
}
\`\`\`

The script:
- Uses shebang: \`#!/usr/bin/env npx tsx\`
- Reads the issue payload from \`ISSUE_JSON\` environment variable (set via \`toJSON(github.event.issue)\` in the workflow)
- Reads the event action from \`EVENT_NAME\` environment variable (set via \`github.event.action\`)
- Exports public functions: \`isBot()\`, \`isAlreadyTriaged()\`, \`shouldRetriage()\`, \`evaluate()\`
- Supports \`--evaluate\` CLI mode (outputs JSON decision) and \`--self-test\` mode (runs built-in assertions)
- Bot detection: checks for \`[bot]\` and \`-bot\` suffixes in login, and \`Bot\` user type
- Triaged labels: \`agent:plan\`, \`agent:implement\`, \`needs-human-review\`, \`wontfix\`, \`duplicate\`, \`invalid\`
- Re-triage label: \`needs-more-info\`
- Edit event logic:
  1. If \`needs-more-info\` label present → re-triage (isRetriage=true)
  2. If never triaged (no triaged labels) → initial triage (handles pre-existing issues)
  3. If already triaged → skip

## Safety Constraints

- The triage agent is read-only with respect to code — it NEVER modifies repository files
- It only interacts via the GitHub Issues API (labels and comments)
- All comments must be clearly attributed to the triage bot
- Never auto-close issues — only label and comment
- Rate-limit protection: the concurrency group prevents duplicate runs
- Timeout: set a hard timeout of 10 minutes for the triage workflow (allows time for Claude analysis)

## Quality Requirements

- All workflows should use \`actions/github-script@v7\` for GitHub API interactions (if GitHub Actions)
- Pin all action versions to specific SHAs or major versions for security
- Include proper error handling and clear logging at each step
- Set appropriate timeout-minutes for the workflow (10 minutes for triage)
- Use concurrency groups to prevent parallel runs on the same issue

## Output Format

Return the complete file contents for each file, separated by a comment line with the target file path. All YAML must be valid. All scripts must be executable. Do not wrap in markdown code fences.`;
}
