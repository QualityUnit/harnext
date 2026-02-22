import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { buildIncidentHarnessLoopPrompt } from '../prompts/incident-harness-loop.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const incidentHarnessLoopHarness: HarnessModule = {
  name: 'incident-harness-loop',
  displayName: 'Incident-to-Harness Loop',
  description: 'Generates incident tracking templates and harness gap SLO workflows',
  order: 13,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;

    // 1. Generate reference templates from existing builders / inline content
    const refIssueTemplate = buildHarnessGapTemplate();
    const refTrackingDoc = buildHarnessGapsDoc();
    const refMetricsWorkflow = buildWeeklyMetricsYml();

    // 2. Build the prompt with reference context
    const basePrompt = buildIncidentHarnessLoopPrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: .github/ISSUE_TEMPLATE/harness-gap.md
\`\`\`markdown
${refIssueTemplate}
\`\`\`

### Reference: docs/harness-gaps.md
\`\`\`markdown
${refTrackingDoc}
\`\`\`

### Reference: .github/workflows/weekly-metrics.yml
\`\`\`yaml
${refMetricsWorkflow}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'incident-harness-loop',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { templatePath: '.github/ISSUE_TEMPLATE/' },
      };
      ctx.previousOutputs.set('incident-harness-loop', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Incident harness loop generation failed: ${message}`);
    }
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildHarnessGapTemplate(): string {
  return [
    '---',
    'name: Harness Gap Report',
    'about: Convert a production regression into a harness improvement',
    'title: "[HARNESS GAP] "',
    'labels: harness-gap, quality',
    "assignees: ''",
    '---',
    '',
    '## Incident Summary',
    '',
    '<!-- What happened in production? Include date, severity, and user impact. -->',
    '',
    '## Root Cause',
    '',
    '<!-- Why did this happen? What was the underlying defect? -->',
    '',
    '## What Should Have Caught It',
    '',
    'Which harness layer should have prevented this regression?',
    '',
    '- [ ] Pre-commit hooks',
    '- [ ] Risk policy gate',
    '- [ ] CI pipeline (lint / type-check / test / build)',
    '- [ ] Review agent',
    '- [ ] Browser evidence',
    '- [ ] Architectural linter (boundary violations)',
    '- [ ] Structural tests (harness smoke)',
    '- [ ] Other: ___',
    '',
    '## Proposed Harness Improvement',
    '',
    '<!-- What specific check, test, rule, or gate should be added or strengthened? -->',
    '',
    '## Affected Critical Paths',
    '',
    '<!-- Which paths from harness.config.json are affected? Check all that apply. -->',
    '',
    '- [ ] `src/index.ts`',
    '- [ ] `src/cli.ts`',
    '- [ ] `src/commands/init.ts`',
    '- [ ] `src/core/claude-runner.ts`',
    '- [ ] `src/core/config.ts`',
    '- [ ] `src/core/detector.ts`',
    '- [ ] `src/core/file-writer.ts`',
    '- [ ] `src/harnesses/index.ts`',
    '- [ ] `src/harnesses/types.ts`',
    '- [ ] `package.json`',
    '- [ ] `tsconfig.json`',
    '- [ ] `tsup.config.ts`',
    '- [ ] `vitest.config.ts`',
    '- [ ] `eslint.config.js`',
    '- [ ] None of the above (new critical path needed)',
    '',
    '## SLO Target',
    '',
    '- [ ] **P0**: Within 24 hours (active production breakage)',
    '- [ ] **P1**: Within 1 week (high-risk gap, could recur)',
    '- [ ] **P2**: Within 1 sprint (medium-risk, workaround exists)',
    '- [ ] **P3**: Next planning cycle (low-risk, defense-in-depth)',
    '',
    '## Test Case Specification',
    '',
    'Describe the test that would catch this regression going forward:',
    '',
    '- **Input / preconditions**: <!-- e.g., "A PR that modifies src/core/config.ts without updating the Zod schema" -->',
    '- **Expected behavior**: <!-- e.g., "CI fails at type-check or structural-tests step" -->',
    '- **Actual behavior**: <!-- e.g., "PR merged without catching the schema mismatch" -->',
    '- **Files to test**: <!-- e.g., "src/core/config.ts, tests/core/config.test.ts" -->',
    '',
    '## Evidence',
    '',
    '<!-- Links to incident reports, error logs, screenshots, or related PRs/issues. -->',
    '',
    '---',
    '',
    '> **Process**: After filing this issue, add a priority label (`P0`/`P1`/`P2`/`P3`) and update [docs/harness-gaps.md](../../docs/harness-gaps.md). See the [incident-to-harness loop process](../../docs/harness-gaps.md#process) for next steps.',
    '',
  ].join('\n');
}

function buildHarnessGapsDoc(): string {
  return [
    '# Harness Gap Tracker',
    '',
    'Tracks gaps identified in the harness engineering setup through production incidents. Each gap represents a regression that our harness system should have prevented.',
    '',
    '## Metrics',
    '',
    '| Metric | Target | Current |',
    '|--------|--------|---------|',
    '| Mean time to harness (MTTH) | < 7 days | - |',
    '| Open P0 gaps | 0 | 0 |',
    '| Open P1 gaps | < 3 | 0 |',
    '| Gap close rate (monthly) | > 80% | - |',
    '| Repeat regression rate | 0% | 0% |',
    '',
    '> Updated weekly by the [weekly-metrics workflow](../.github/workflows/weekly-metrics.yml). Run manually via `workflow_dispatch` for on-demand updates.',
    '',
    '## SLO Definitions',
    '',
    '| Priority | SLO | Description |',
    '|----------|-----|-------------|',
    '| **P0** | 24 hours | Active production breakage. Drop everything. |',
    '| **P1** | 1 week | High-risk gap that could recur imminently. |',
    '| **P2** | 1 sprint | Medium-risk gap with a known workaround. |',
    '| **P3** | Next planning cycle | Defense-in-depth improvement, low urgency. |',
    '',
    '## Open Gaps',
    '',
    '<!-- Auto-updated by weekly-metrics workflow. Manual edits are overwritten. -->',
    '',
    '| # | Title | Priority | Layer | Created | SLO Due |',
    '|---|-------|----------|-------|---------|---------|',
    '| - | No open gaps | - | - | - | - |',
    '',
    '## Closed Gaps',
    '',
    '| # | Title | Layer | Resolution | Closed |',
    '|---|-------|-------|------------|--------|',
    '| - | No closed gaps yet | - | - | - |',
    '',
    '## Process',
    '',
    '1. **Report**: When a production incident occurs, create a [Harness Gap issue](../.github/ISSUE_TEMPLATE/harness-gap.md) using the template.',
    '2. **Triage**: Add a priority label (`P0`\u2013`P3`) and identify the harness layer that should have caught it.',
    '3. **Implement**: Add the missing test, rule, or gate. Reference the gap issue in the PR.',
    '4. **Verify**: Confirm the new harness check would have caught the original regression (re-run against the offending commit if possible).',
    '5. **Close**: Close the issue and update this tracker.',
    '6. **Review**: Weekly metrics report verifies SLO compliance and flags overdue gaps.',
    '',
    '## Harness Layers Reference',
    '',
    '| Layer | Catches | Examples |',
    '|-------|---------|----------|',
    '| Pre-commit hooks | Local quality issues before push | Formatting, lint errors, type errors |',
    '| Risk policy gate | Mis-classified PR risk | Tier 3 change merged without manual review |',
    '| CI pipeline | Build/test/lint failures | Broken tests, type errors, lint violations |',
    '| Review agent | Logic errors, missing tests | Untested edge case, missing error handling |',
    '| Browser evidence | Visual/UX regressions | Broken layout, missing UI element |',
    '| Architectural linter | Boundary violations | Core importing from UI, circular deps |',
    '| Structural tests | Harness config drift | Missing critical file, invalid config schema |',
    '',
  ].join('\n');
}

function buildWeeklyMetricsYml(): string {
  /* eslint-disable no-useless-escape */
  return `name: Weekly Harness Metrics

on:
  schedule:
    - cron: '0 10 * * 5' # Every Friday at 10:00 UTC
  workflow_dispatch: {}

permissions:
  issues: read
  contents: read

jobs:
  metrics:
    name: Harness Gap Metrics
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Collect harness gap metrics
        uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1
        with:
          script: |
            const issues = await github.paginate(github.rest.issues.listForRepo, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              labels: 'harness-gap',
              state: 'all',
              per_page: 100,
            });

            const open = issues.filter(i => i.state === 'open');
            const closed = issues.filter(i => i.state === 'closed');

            const hasPriority = (issue, p) =>
              issue.labels.some(l => l.name === p);

            const p0Open = open.filter(i => hasPriority(i, 'P0'));
            const p1Open = open.filter(i => hasPriority(i, 'P1'));
            const p2Open = open.filter(i => hasPriority(i, 'P2'));
            const p3Open = open.filter(i => hasPriority(i, 'P3'));

            // Mean time to harness (days) for closed issues
            let mtthDays = 0;
            if (closed.length > 0) {
              const totalDays = closed.reduce((sum, i) => {
                const created = new Date(i.created_at);
                const closedAt = new Date(i.closed_at);
                return sum + (closedAt - created) / (1000 * 60 * 60 * 24);
              }, 0);
              mtthDays = totalDays / closed.length;
            }

            // Monthly close rate (closed in last 30 days / total that were open 30 days ago)
            const now = new Date();
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
            const closedRecently = closed.filter(
              i => new Date(i.closed_at) >= thirtyDaysAgo
            );
            const openThirtyDaysAgo = issues.filter(
              i => new Date(i.created_at) <= thirtyDaysAgo &&
                   (i.state === 'open' || new Date(i.closed_at) >= thirtyDaysAgo)
            );
            const closeRate = openThirtyDaysAgo.length > 0
              ? ((closedRecently.length / openThirtyDaysAgo.length) * 100).toFixed(0)
              : '-';

            // SLO compliance: flag overdue gaps
            const sloLimits = { P0: 1, P1: 7, P2: 14, P3: 90 };
            const overdue = open.filter(i => {
              for (const [label, days] of Object.entries(sloLimits)) {
                if (hasPriority(i, label)) {
                  const age = (now - new Date(i.created_at)) / (1000 * 60 * 60 * 24);
                  return age > days;
                }
              }
              return false;
            });

            // Build summary
            const lines = [
              '## Weekly Harness Metrics Report',
              '',
              \`_Generated: \${now.toISOString().slice(0, 10)}_\`,
              '',
              '### Summary',
              '',
              '| Metric | Target | Current | Status |',
              '|--------|--------|---------|--------|',
              \`| MTTH (days) | < 7 | \${mtthDays.toFixed(1)} | \${mtthDays <= 7 || closed.length === 0 ? ':white_check_mark:' : ':x:'} |\`,
              \`| Open P0 gaps | 0 | \${p0Open.length} | \${p0Open.length === 0 ? ':white_check_mark:' : ':x:'} |\`,
              \`| Open P1 gaps | < 3 | \${p1Open.length} | \${p1Open.length < 3 ? ':white_check_mark:' : ':x:'} |\`,
              \`| Close rate (30d) | > 80% | \${closeRate}% | \${closeRate === '-' || parseInt(closeRate) > 80 ? ':white_check_mark:' : ':x:'} |\`,
              \`| Overdue gaps | 0 | \${overdue.length} | \${overdue.length === 0 ? ':white_check_mark:' : ':x:'} |\`,
              '',
              '### Breakdown',
              '',
              '| Priority | Open | Closed | Total |',
              '|----------|------|--------|-------|',
              \`| P0 | \${p0Open.length} | \${closed.filter(i => hasPriority(i, 'P0')).length} | \${issues.filter(i => hasPriority(i, 'P0')).length} |\`,
              \`| P1 | \${p1Open.length} | \${closed.filter(i => hasPriority(i, 'P1')).length} | \${issues.filter(i => hasPriority(i, 'P1')).length} |\`,
              \`| P2 | \${p2Open.length} | \${closed.filter(i => hasPriority(i, 'P2')).length} | \${issues.filter(i => hasPriority(i, 'P2')).length} |\`,
              \`| P3 | \${p3Open.length} | \${closed.filter(i => hasPriority(i, 'P3')).length} | \${issues.filter(i => hasPriority(i, 'P3')).length} |\`,
              \`| **Total** | **\${open.length}** | **\${closed.length}** | **\${issues.length}** |\`,
            ];

            if (overdue.length > 0) {
              lines.push('', '### :warning: Overdue Gaps', '');
              lines.push('| # | Title | Priority | Age (days) | SLO |');
              lines.push('|---|-------|----------|------------|-----|');
              for (const i of overdue) {
                const age = ((now - new Date(i.created_at)) / (1000 * 60 * 60 * 24)).toFixed(0);
                const prio = ['P0', 'P1', 'P2', 'P3'].find(p => hasPriority(i, p)) || '?';
                const slo = sloLimits[prio] || '?';
                lines.push(\`| #\${i.number} | \${i.title} | \${prio} | \${age} | \${slo}d |\`);
              }
            }

            const summary = lines.join('\\n');
            await core.summary.addRaw(summary).write();
            console.log(summary);
`;
  /* eslint-enable no-useless-escape */
}
