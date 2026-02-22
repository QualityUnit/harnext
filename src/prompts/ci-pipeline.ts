import type { DetectionResult, UserPreferences } from './types.js';

/**
 * Prompt for generating CI pipeline workflows.
 */
export function buildCiPipelinePrompt(
  detection: DetectionResult,
  prefs: UserPreferences,
  instructionFile = 'CLAUDE.md',
): string {
  const ciFormat = {
    'github-actions': 'GitHub Actions YAML workflow files in `.github/workflows/`',
    'gitlab-ci': 'GitLab CI YAML in `.gitlab-ci.yml`',
    bitbucket: 'Bitbucket Pipelines YAML in `bitbucket-pipelines.yml`',
  }[prefs.ciProvider];

  const ciTrigger = {
    'github-actions': 'on: pull_request (for PR checks) and on: push to main (for post-merge)',
    'gitlab-ci': 'rules with merge_request_event and push to main',
    bitbucket: 'pull-requests and push triggers',
  }[prefs.ciProvider];

  const cacheStrategy = detection.packageManager
    ? `Cache ${detection.packageManager} dependencies using the lock file hash as cache key.`
    : 'No package manager detected — skip caching.';

  return `Generate CI pipeline configuration for this repository. The output format is ${ciFormat}.

## Detected Stack Context

- **Language**: ${detection.primaryLanguage}
- **Framework**: ${detection.framework ?? 'none'}
- **Package Manager**: ${detection.packageManager ?? 'none'}
- **Test Framework**: ${detection.testFramework ?? 'none'}
- **Test Command**: \`${detection.testCommand ?? 'not detected'}\`
- **Build Command**: \`${detection.buildCommand ?? 'not detected'}\`
- **Lint Command**: \`${detection.lintCommand ?? 'not detected'}\`
- **Type Checker**: ${detection.typeChecker ?? 'none'}
- **Build Tool**: ${detection.buildTool ?? 'none'}
- **CI Provider**: ${prefs.ciProvider}
- **Monorepo**: ${detection.monorepo}
- **Has UI Components**: ${detection.hasUIComponents}
- **Strictness**: ${prefs.strictnessLevel}

## Trigger Configuration

${ciTrigger}

## Generate These Workflow Files

### 1. Main CI Pipeline (\`ci.yml\` or equivalent)

This is the primary CI workflow. It must be **gated behind the risk-policy-gate** — meaning the risk-policy-gate job runs first, determines the required checks based on risk tier, and subsequent jobs only run if the gate passes and their tier requires them.

**Jobs:**

#### a. \`risk-gate\`
- Runs the risk-policy-gate script (generated separately)
- Outputs: \`tier\` (1, 2, or 3), \`required-checks\` (JSON array of check names)
- This job always runs on every PR

#### b. \`lint\`
- Depends on: \`risk-gate\`
- Condition: runs if tier >= 1 (always)
- Steps:
  1. Checkout code at PR SHA
  2. Set up ${detection.primaryLanguage} environment
  3. Install dependencies: \`${detection.packageManager ?? 'unknown'} install\`
  4. Run linter: \`${detection.lintCommand ?? 'echo "no lint command"'}\`
- ${cacheStrategy}

#### c. \`type-check\`
- Depends on: \`risk-gate\`
- Condition: runs if tier >= 1 AND type checker is available
- Steps: Run type checker command for ${detection.typeChecker ?? 'none'}
- Skip this job entirely if no type checker is detected

#### d. \`test\`
- Depends on: \`risk-gate\`
- Condition: runs if tier >= 2
- Steps:
  1. Checkout code at PR SHA
  2. Set up ${detection.primaryLanguage} environment
  3. Install dependencies
  4. Run tests: \`${detection.testCommand ?? 'echo "no test command"'}\`
  5. Upload test results as artifacts

#### e. \`build\`
- Depends on: \`risk-gate\`
- Condition: runs if tier >= 2
- Steps:
  1. Checkout code at PR SHA
  2. Set up environment and install dependencies
  3. Run build: \`${detection.buildCommand ?? 'echo "no build command"'}\`

#### f. \`browser-evidence\`
- Depends on: \`risk-gate\`, \`test\`
- Condition: runs if tier == 3 AND hasUIComponents is true
- Steps: Run browser evidence capture (generated separately)
- Only include this job if ${detection.hasUIComponents} is true

#### g. \`structural-tests\`
- Depends on: \`risk-gate\`
- Condition: runs if tier >= 2
- Steps: Run architectural boundary validation scripts
- Verify import direction rules, module boundaries

#### h. \`harness-smoke\`
- Depends on: \`risk-gate\`
- Condition: always runs
- Steps:
  1. Validate harness.config.json is present and valid JSON
  2. Verify ${instructionFile} exists
  3. Check that required CI workflow files exist
  4. Validate PR template exists

### 2. Structural Tests Workflow (\`structural-tests.yml\`)

A dedicated workflow (or job within the main pipeline) that validates architectural boundaries:
- Run the architectural linter scripts (generated separately)
- Verify that dependency directions are respected between layers: ${detection.architecturalLayers.join(' -> ') || 'no layers detected'}
- Fail the pipeline if architectural violations are found

### 3. Harness Smoke Tests (\`harness-smoke.yml\`)

Validates the harness engineering setup itself:
- Check that harness.config.json is valid JSON and matches the expected schema
- Verify all referenced commands in harness.config.json actually exist as scripts
- Ensure ${instructionFile} is present and non-empty
- Validate that PR templates are present
- Check that all workflow files referenced in the harness config exist

## CI Best Practices to Follow

- **SHA-Pinned Actions (MANDATORY)**: ALL GitHub Actions MUST be pinned to exact commit SHAs, not version tags. Example: \`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\` (v4.2.2), \`actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af\` (v4.1.0). Never use \`@v4\` — tags can be moved.
- Use \`concurrency\` groups to cancel outdated runs on the same PR
- Set appropriate \`timeout-minutes\` for each job (10 min for lint, 20 for tests, 30 for builds)
- Use minimal permissions: \`contents: read\` by default, \`pull-requests: write\` only where needed
- Fail fast: if lint fails, skip tests to save compute
- ${cacheStrategy}
- Upload test results and coverage as artifacts
- For monorepo (${detection.monorepo}): use path filters to only run relevant jobs
- **Node Version**: Use Node.js 22 consistently across all jobs
- **TypeScript Execution**: Use \`npx tsx\` to run TypeScript scripts, NOT \`npx ts-node\` (this project uses ESM)
- **Structural Tests**: The structural-tests job must run \`bash scripts/structural-tests.sh\`, NOT \`npm test\` — it validates architectural boundaries, not unit tests

## Claude Code Integration (IMPORTANT)

Any CI workflow that invokes Claude Code MUST use the \`anthropics/claude-code-action@v1\` GitHub Action with OAuth authentication. Do NOT use \`ANTHROPIC_API_KEY\` in any workflow.

**Required pattern for all Claude-powered CI steps:**
\`\`\`yaml
permissions:
  id-token: write  # Required for Claude Code Action OAuth
  contents: read

steps:
  - uses: actions/checkout@v4
  - name: Run Claude Code
    uses: anthropics/claude-code-action@v1
    with:
      claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      prompt: 'Your task prompt here'
      claude_args: '--max-turns 5'
\`\`\`

Never reference \`ANTHROPIC_API_KEY\` or invoke the \`claude\` CLI directly with API key authentication. Always use the action with \`claude_code_oauth_token\`.

## Required Output Files (ALL mandatory)

You MUST generate ALL of the following files. Do not skip any:

1. \`.github/workflows/ci.yml\` — Main CI pipeline workflow
2. \`.github/workflows/structural-tests.yml\` — Structural tests workflow
3. \`.github/workflows/harness-smoke.yml\` — Harness smoke tests workflow
4. \`scripts/structural-tests.sh\` — Shell script for architectural boundary validation (make executable)

Write each file using the Write tool. The files must be valid YAML/shell that can be parsed without errors.`;
}
