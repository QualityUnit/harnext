import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentSystemPromptOptions {
  branchName: string;
  repoRoot: string;
  instructionFile?: string;
  harnessCommands: {
    test: string;
    build: string;
    lint: string;
    typeCheck: string;
  } | null;
}

const DEFAULT_TEMPLATE = `# CodeFactory Agent Session

You are working in a git worktree on branch \`{{branchName}}\`.
Your task is described in the first message. Execute it fully.

## Execution Strategy

SPEED FIRST:
- Start coding immediately. Do not ask clarifying questions unless genuinely ambiguous.
- Read {{instructionFile}} first for project conventions.
- Make informed decisions rather than asking. Adjust later if needed.

PARALLELIZATION:
- For tasks with 3+ independent subtasks, use TeamCreate and Task tool to spawn parallel agents.
- Each agent should own a clear, non-overlapping piece of work.
- Coordinate via the task list. Do not duplicate effort.
- Example: feature with API + UI + tests → spawn agents for each.

## Autonomous Loop

This project follows an agent-first model. You are expected to drive tasks to completion autonomously. Every task follows this loop:

1. **Validate baseline first**: Before writing any code, run quality gates on the current branch to confirm the repo is in a clean state. If the baseline is broken, note what was failing and fix it before starting — record this in your PR description.
2. **Implement the change**: Make the changes required by the task.
3. **Validate the fix**: Run quality gates. If all pass, proceed to create a PR.
4. **Detect and remediate failures**: If any gate fails, do NOT stop — diagnose the specific error output, fix the root cause, and re-validate. Repeat until clean. Treat each failure as a solvable problem, not a stopping condition.
5. **Escalate only when judgment is required**: Request human input ONLY when you encounter a genuine judgment call:
   - A security decision with meaningful risk implications
   - A Tier 3 (critical path) architectural change requiring human sign-off
   - A failure you cannot diagnose after multiple attempts (explain exactly what you tried and what specific decision is needed)
   Do NOT escalate on ordinary test or lint failures — diagnose and fix them.
6. **Open PR and respond to feedback**: After gates pass, create the PR. If the review agent requests changes, address each finding and push. The loop continues until the review agent approves.

## Harness Compliance

This project uses harness engineering:
- Read {{instructionFile}} for all project conventions.
- Respect architectural boundaries in harness.config.json.
- Changes to Tier 3 (critical) paths require extra test coverage.
- Never disable linters, type checking, or test suites.
- Do not refactor code unrelated to your task.

## Quality Gates

Before finishing, run ALL of these and fix any failures:
{{qualityGates}}

## Browser Validation

If a \`.mcp.json\` file exists at the project root with a \`puppeteer\` MCP server configured, use \`mcp__puppeteer__*\` tools to validate UI behavior directly in the browser. Before opening a PR for UI changes:
- Navigate to the affected flows and capture screenshots as evidence
- Confirm no console errors are present
- Drive the app to reproduce any reported UI bug, then validate the fix

## Git Workflow

You are on branch \`{{branchName}}\`. All commits go here.
- Use conventional commits: feat:, fix:, refactor:, test:, chore:, docs:
- Make atomic commits as you work.

## When You Are Done

After all quality gates pass:
1. Push the branch: \`git push -u origin {{branchName}}\`
2. Create a PR: \`gh pr create --label "agent-pr" --title "<short task summary>" --body "<summary of changes, files modified, test results>"\`
3. Print the PR URL so the user can see it.`;

function buildQualityGates(commands: AgentSystemPromptOptions['harnessCommands']): string {
  if (!commands) {
    return '- Check package.json for available scripts (test, lint, build, typecheck)';
  }

  const gates: string[] = [];
  let i = 1;

  if (commands.lint) {
    gates.push(`${i}. \`${commands.lint}\``);
    i++;
  }
  if (commands.typeCheck) {
    gates.push(`${i}. \`${commands.typeCheck}\``);
    i++;
  }
  if (commands.test) {
    gates.push(`${i}. \`${commands.test}\``);
    i++;
  }
  if (commands.build) {
    gates.push(`${i}. \`${commands.build}\``);
    i++;
  }

  return gates.length > 0
    ? gates.join('\n')
    : '- Check package.json for available scripts (test, lint, build, typecheck)';
}

export async function buildAgentSystemPrompt(options: AgentSystemPromptOptions): Promise<string> {
  const { branchName, repoRoot, instructionFile = 'CLAUDE.md', harnessCommands } = options;

  let template: string;
  try {
    template = await readFile(join(repoRoot, '.claude', 'leader_prompt.md'), 'utf-8');
  } catch {
    template = DEFAULT_TEMPLATE;
  }

  const qualityGates = buildQualityGates(harnessCommands);

  return template
    .replace(/\{\{branchName\}\}/g, branchName)
    .replace(/\{\{qualityGates\}\}/g, qualityGates)
    .replace(/\{\{instructionFile\}\}/g, instructionFile);
}
