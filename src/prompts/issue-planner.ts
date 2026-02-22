import type { DetectionResult, UserPreferences } from './types.js';
import { CI_AGENT_ACTIONS } from '../core/ai-runner.js';
import { getKiroCISafetyRules } from '../core/ci-agent-steps.js';

/**
 * Prompt for generating the issue-planner agent workflow and supporting scripts.
 */
export function buildIssuePlannerPrompt(
  detection: DetectionResult,
  prefs: UserPreferences,
  instructionFile = 'CLAUDE.md',
): string {
  const agentAction = CI_AGENT_ACTIONS[prefs.aiPlatform];
  return `Generate an issue-planner agent system for this ${detection.primaryLanguage} project. When an issue is labeled with \`agent:plan\` (by the triage workflow), the system spawns a Claude Code agent that reads the issue, analyzes the codebase, and posts a structured implementation plan as a comment on the issue. It then adds the \`agent:implement\` label and dispatches the implementer workflow.

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

## Pipeline Position

This agent sits between triage and implementation:

\`\`\`
Issue opened → Triage (agent:plan) → Planner (posts plan, agent:implement) → Implementer (creates PR)
\`\`\`

## Files to Generate

### 1. ${prefs.ciProvider === 'github-actions' ? '.github/workflows/issue-planner.yml' : prefs.ciProvider === 'gitlab-ci' ? '.gitlab/ci/issue-planner.yml' : 'bitbucket-pipelines-issue-planner.yml'}

A CI workflow triggered when an issue is labeled OR dispatched by the triage workflow.

**Trigger** (CRITICAL — dual trigger for event chaining):
${
  prefs.ciProvider === 'github-actions'
    ? `\`\`\`yaml
on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to plan'
        required: true
        type: string
\`\`\`

**IMPORTANT**: The \`workflow_dispatch\` trigger is required because GitHub Actions does NOT trigger \`labeled\` events from actions performed using the default \`GITHUB_TOKEN\`. When the triage workflow adds the \`agent:plan\` label, the \`labeled\` event is suppressed to prevent infinite loops. The triage workflow dispatches this workflow explicitly via \`gh workflow run\`.

When triggered via \`workflow_dispatch\`:
- \`github.event.issue\` and \`context.issue\` are NOT available
- The workflow must fetch issue data via \`gh issue view <number> --json number,title,body,labels,author\`
- All downstream steps must derive issue references from the guard output (not from context)
- \`github.event.repository.default_branch\` is not available — use a fallback`
    : prefs.ciProvider === 'gitlab-ci'
      ? 'Trigger via webhook on issue label change. Use a CI job that checks for the `agent:plan` label.'
      : 'Trigger via webhook on issue label change. Use a pipeline that checks for the `agent:plan` label.'
}

**Permissions** (${prefs.ciProvider === 'github-actions' ? 'GitHub Actions' : prefs.ciProvider}):
- issues: write (to add labels and comments)
- contents: read (to read repo context)
- actions: write (to dispatch the implementer workflow after planning)
- id-token: write (required for Claude Code Action OAuth)

**Workflow steps**:

1. **Fetch issue data** (workflow_dispatch only):
   - When \`github.event_name == 'workflow_dispatch'\`, fetch the issue via:
     \`\`\`bash
     gh issue view "\${{ inputs.issue_number }}" --json number,title,body,labels,author
     \`\`\`
   - Remap \`author\` to \`user\` via jq: \`| jq '{number, title, body, labels, user: {login: .author.login}}'\`
   - Note: \`gh\` CLI uses \`author\`, not \`user\` — remap to match \`github.event.issue\` shape
   - Store the result as a step output for the guard and prompt-building steps

2. **Gate check** (via guard script):
   - Pass \`ISSUE_JSON\` from either the fetched data (workflow_dispatch) or \`toJSON(github.event.issue)\` (issues event)
   - Verify the issue has the \`agent:plan\` label
   - Skip if the issue already has a plan posted (check for \`<!-- issue-planner: #N -->\` marker in issue comments)
   - Skip if the issue has blocking labels (\`agent:skip\`, \`wontfix\`, \`duplicate\`, \`invalid\`)
   - **Output**: \`should-plan\`, \`reason\`, \`issue-number\`, \`issue-title\`

3. **Read planner prompt** from \`.codefactory/prompts/issue-planner.md\`

4. **Build planning prompt**:
   - Combine: prompt template + issue details + ${instructionFile} conventions + codebase structure overview
   - Include \`harness.config.json\` for architectural boundaries

5. **Agent execution**:
   - Invoke the AI agent using \`${agentAction.action}\` with \`${agentAction.secretInputKey}: \${{ secrets.${agentAction.secretName} }}\`${agentAction.argsInputKey ? `\n   - Set \`--model claude-opus-4-6 --max-turns 30 --allowedTools "Read,Glob,Grep,Bash"\` in \`${agentAction.argsInputKey}\`` : ''}${prefs.aiPlatform === 'claude' ? `\n   - Set \`allowed_bots: 'github-actions'\` — this workflow is dispatched by the triage workflow using \`GITHUB_TOKEN\`, so the actor is \`github-actions[bot]\`. Without \`allowed_bots\`, the action rejects bot-initiated runs.` : ''}
   - The agent reads the codebase (read-only) and produces a structured plan
   - Timeout: 15 minutes
   - **IMPORTANT**: ${agentAction.executionFileOutputKey ? `The action's response is in the \`${agentAction.executionFileOutputKey}\` output (a JSON array, NOT JSONL — do NOT use \`jq -s\`). Extract the result turn: \`jq -r '[.[] | select(.type == "result")] | last | .result // ""' "$EXECUTION_FILE"\`. Fallback to last assistant text: \`jq -r '[.[] | select(.type == "assistant") | .message.content[] | select(.type == "text") | .text] | last // ""' "$EXECUTION_FILE"\`` : `The action's response is available via the \`${agentAction.textOutputKey}\` output.`}

6. **Post plan as comment**:
   - Extract Claude's plan text from the \`execution_file\` (see above) and post as a comment on the issue
   - Include \`<!-- issue-planner: #N -->\` marker for deduplication

7. **Add \`agent:implement\` label and dispatch implementer**:
   - Add the \`agent:implement\` label
   - Dispatch the implementer workflow via \`gh workflow run issue-implementer.yml --field issue_number=N\`

8. **Failure handler**:
   - Add \`agent:needs-judgment\` label
   - Post error comment with run link

**Concurrency**: Use a concurrency group keyed on the issue number:
\`\`\`yaml
concurrency:
  group: issue-planner-$\{{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: true
\`\`\`

### 2. Planner prompt

The planner agent's instructions are stored at \`.codefactory/prompts/issue-planner.md\` in the repository. This file is managed by the CodeFactory CLI and can be customized by the team.

**The workflow must read this file at runtime** and pass its contents to Claude as the system prompt.

Do NOT generate a separate prompt file. The prompt lives in \`.codefactory/prompts/issue-planner.md\` and is the single source of truth.

### 3. scripts/issue-planner-guard.ts

A TypeScript utility script that determines whether the planner agent should run:

\`\`\`typescript
interface PlannerDecision {
  shouldPlan: boolean;
  issueNumber: number;
  issueTitle: string;
  reason: string;
  existingPlan: boolean;   // true if a plan comment already exists
  blockedLabels: string[]; // labels that prevent planning
}
\`\`\`

The script:
- Uses shebang: \`#!/usr/bin/env npx tsx\`
- Reads the issue payload from \`ISSUE_JSON\` environment variable
- Exports public functions: \`findExistingPlan()\`, \`evaluate()\`
- Supports \`--evaluate\` CLI mode (outputs JSON decision) and \`--self-test\` mode (runs built-in assertions)
- Checks for the \`agent:plan\` label (required)
- Checks for blocking labels (\`agent:skip\`, \`wontfix\`, \`duplicate\`, \`invalid\`)
- Searches for existing plan via \`<!-- issue-planner: #N -->\` marker in issue comments

## Critical: No Plan Mode in CI

The generated \`.codefactory/prompts/issue-planner.md\` MUST instruct the agent to **never use plan mode** (\`EnterPlanMode\`/\`ExitPlanMode\`). The agent runs in CI with no human to approve plans. It must also NOT modify any files — it is a read-only analysis agent.

## Safety Constraints

- The planner agent is read-only with respect to code — it NEVER modifies repository files
- It only interacts via the GitHub Issues API (labels and comments)
- All comments must be clearly attributed to the planner bot
- Never auto-close issues — only label and comment
- Timeout: set a hard timeout of 15 minutes for the planner workflow

## Quality Requirements

- All workflows should use \`actions/github-script@v7\` for GitHub API interactions (if GitHub Actions)
- Pin all action versions to specific SHAs or major versions for security
- Include proper error handling and clear logging at each step
- Use concurrency groups to prevent parallel runs on the same issue

${prefs.aiPlatform === 'kiro' ? getKiroCISafetyRules() : ''}

## Output Format

Return the complete file contents for each file, separated by a comment line with the target file path. All YAML must be valid. All scripts must be executable. Do not wrap in markdown code fences.`;
}
