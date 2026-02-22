import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { buildRiskPolicyGatePrompt } from '../prompts/risk-policy-gate.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const riskPolicyGateHarness: HarnessModule = {
  name: 'risk-policy-gate',
  displayName: 'Risk Policy Gate',
  description: 'Generates preflight gate workflow and script with SHA discipline',
  order: 5,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;
    const d = detection;

    // ── Build tier patterns from detection ──────────────────────────────
    const tier3Patterns =
      (d.criticalPaths ?? []).length > 0
        ? d.criticalPaths.map((p) => `    '${p}',`).join('\n')
        : [
            "    'src/index.ts',",
            "    'src/cli.ts',",
            "    'src/commands/**/*.ts',",
            "    'src/core/**/*.ts',",
            "    'src/harnesses/index.ts',",
            "    'src/harnesses/types.ts',",
            "    'package.json',",
            "    'tsconfig.json',",
            "    'tsup.config.ts',",
            "    'vitest.config.ts',",
            "    'eslint.config.js',",
          ].join('\n');

    const tier2Patterns =
      (d.architecturalLayers ?? []).length > 0
        ? d.architecturalLayers
            .filter((l) => !['commands', 'core'].includes(l))
            .map((l) => `    'src/${l}/**/*.ts',`)
            .concat(["    'tests/**/*.ts',"])
            .join('\n')
        : [
            "    'src/ui/**/*.ts',",
            "    'src/utils/**/*.ts',",
            "    'src/prompts/**/*.ts',",
            "    'src/providers/**/*.ts',",
            "    'tests/**/*.ts',",
          ].join('\n');

    const testCmd = d.testCommand ?? 'npm test';
    const lintCmd = d.lintCommand ?? 'npm run lint';
    const buildCmd = d.buildCommand ?? 'npm run build';

    // 1. Generate reference templates from existing builders
    const refShellScript = buildShellScript();
    const refTsScript = buildTsScript(tier2Patterns, tier3Patterns);
    const refWorkflow = buildWorkflowYaml(testCmd, lintCmd, buildCmd);

    // 2. Build the prompt with reference context
    const basePrompt = buildRiskPolicyGatePrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: scripts/risk-policy-gate.sh
\`\`\`bash
${refShellScript}
\`\`\`

### Reference: scripts/risk-policy-gate.ts
\`\`\`typescript
${refTsScript}
\`\`\`

### Reference: .github/workflows/risk-policy-gate.yml
\`\`\`yaml
${refWorkflow}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'risk-policy-gate',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { gatePath: 'scripts/risk-policy-gate.sh' },
      };
      ctx.previousOutputs.set('risk-policy-gate', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Risk policy gate generation failed: ${message}`);
    }
  },
};

// ── File builders ─────────────────────────────────────────────────────────

function buildShellScript(): string {
  // Shell script uses single-quoted heredoc-style approach to avoid
  // template literal escaping issues. Assembled via array join.
  const lines = [
    '#!/usr/bin/env bash',
    '# ============================================================================',
    '# Risk Policy Gate — Preflight CI gate for PR risk classification',
    '#',
    '# Determines the risk tier and required CI checks for a pull request.',
    '# Exit 0: gate passed (tier and checks computed for downstream jobs).',
    '# Exit 1: hard failure (SHA mismatch, unrecoverable error).',
    '#',
    '# Environment variables (set by CI workflow):',
    '#   EXPECTED_SHA  — PR head SHA from the CI event payload',
    '#   BASE_REF      — PR base branch name (default: main)',
    '#   STRICTNESS    — relaxed | standard | strict (default: relaxed)',
    '#   REVIEW_AGENT_STATUS — optional override from remediation loop',
    '#   GITHUB_OUTPUT — path to GitHub Actions output file (set by runner)',
    '#   GITHUB_REPOSITORY — owner/repo (set by runner)',
    '# ============================================================================',
    'set -euo pipefail',
    '',
    'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"',
    'CONFIG_FILE="${REPO_ROOT}/harness.config.json"',
    'STRICTNESS="${STRICTNESS:-relaxed}"',
    '',
    '# --- Globals populated during execution ---',
    'VERIFIED_SHA=""',
    'MAX_TIER=0',
    'TIER1_FILES=()',
    'TIER2_FILES=()',
    'TIER3_FILES=()',
    'REQUIRED_CHECKS=()',
    'DOCS_DRIFT_DETECTED=false',
    'DOCS_DRIFT_WARNING=""',
    'REVIEW_AGENT_RESULT="skipped"',
    '',
    '# ============================================================================',
    '# Step 1: SHA Discipline Check',
    '# Ensures the checked-out commit matches the expected PR head SHA.',
    '# Prevents TOCTOU races where code changes between review and merge.',
    '# ============================================================================',
    'verify_sha() {',
    '  local actual_sha',
    '  actual_sha="$(git rev-parse HEAD)"',
    '',
    '  # When running outside CI (local testing), skip SHA enforcement',
    '  if [[ -z "${EXPECTED_SHA:-}" ]]; then',
    '    echo "::notice::EXPECTED_SHA not set — skipping SHA discipline check (local mode)"',
    '    VERIFIED_SHA="$actual_sha"',
    '    return 0',
    '  fi',
    '',
    '  # Compare SHAs case-insensitively (hex strings)',
    '  if [[ "${actual_sha,,}" != "${EXPECTED_SHA,,}" ]]; then',
    '    echo "::error::SHA discipline violation: checked-out HEAD (${actual_sha}) ≠ expected PR SHA (${EXPECTED_SHA})"',
    '    echo "::error::The branch changed after this workflow was triggered. Re-run the workflow on the latest commit."',
    '    return 1',
    '  fi',
    '',
    '  VERIFIED_SHA="$actual_sha"',
    '  echo "✔ SHA verified: ${VERIFIED_SHA:0:12}"',
    '}',
    '',
    '# ============================================================================',
    '# Step 2: Changed File Classification',
    '# Gets the PR diff and classifies each file into risk tiers.',
    '# Tier 3 (critical) > Tier 2 (source) > Tier 1 (docs).',
    "# The PR's overall tier is the maximum of all changed files.",
    '# ============================================================================',
    '',
    '# Classify a single file into a tier. Checks highest tier first.',
    '# In bash case patterns, * matches any string including /.',
    'classify_file() {',
    '  local file="$1"',
    '',
    '  # Tier 3: Entry points, core engine, harness contracts, build/CI infra',
    '  case "$file" in',
    '    src/index.ts|src/cli.ts)                          echo 3; return ;;',
    '    src/commands/*.ts)                                 echo 3; return ;;',
    '    src/core/*.ts)                                     echo 3; return ;;',
    '    src/harnesses/index.ts|src/harnesses/types.ts)     echo 3; return ;;',
    '    package.json|package-lock.json)                    echo 3; return ;;',
    '    tsconfig.json|tsup.config.ts|vitest.config.ts)     echo 3; return ;;',
    '    eslint.config.js)                                  echo 3; return ;;',
    '    harness.config.json)                               echo 3; return ;;',
    '    .github/workflows/*.yml|.github/workflows/*.yaml)  echo 3; return ;;',
    '  esac',
    '',
    '  # Tier 2: Non-critical source code, tests, prompts, providers',
    '  case "$file" in',
    '    src/ui/*.ts)        echo 2; return ;;',
    '    src/utils/*.ts)     echo 2; return ;;',
    '    src/prompts/*.ts)   echo 2; return ;;',
    '    src/providers/*.ts) echo 2; return ;;',
    '    src/harnesses/*.ts) echo 2; return ;;',
    '    tests/*.ts)         echo 2; return ;;',
    '    scripts/*.ts)       echo 2; return ;;',
    '    *.ts|*.js|*.mjs)    echo 2; return ;;',
    '  esac',
    '',
    '  # Tier 1: Documentation, config cosmetics, non-code assets',
    '  case "$file" in',
    '    *.md|*.txt)    echo 1; return ;;',
    '    LICENSE*)      echo 1; return ;;',
    '    .gitignore)    echo 1; return ;;',
    '    .editorconfig) echo 1; return ;;',
    '    .prettierrc*)  echo 1; return ;;',
    '    .vscode/*)     echo 1; return ;;',
    '    docs/*)        echo 1; return ;;',
    '  esac',
    '',
    '  # Default: unknown files get medium scrutiny',
    '  echo 2',
    '}',
    '',
    'classify_changed_files() {',
    '  local base_ref="${BASE_REF:-main}"',
    '',
    '  # Ensure we have the base branch ref for computing the merge base',
    '  if ! git rev-parse --verify "origin/${base_ref}" &>/dev/null; then',
    '    git fetch origin "${base_ref}" --depth=1 2>/dev/null || true',
    '  fi',
    '',
    '  local merge_base',
    '  merge_base="$(git merge-base "origin/${base_ref}" HEAD 2>/dev/null || echo "")"',
    '',
    '  if [[ -z "$merge_base" ]]; then',
    '    echo "::warning::Could not compute merge base against origin/${base_ref}. Defaulting to Tier 3 (safest)."',
    '    MAX_TIER=3',
    '    return',
    '  fi',
    '',
    '  local changed_files',
    '  changed_files="$(git diff --name-only "${merge_base}...HEAD" 2>/dev/null || echo "")"',
    '',
    '  if [[ -z "$changed_files" ]]; then',
    '    echo "::notice::No changed files detected. Defaulting to Tier 1."',
    '    MAX_TIER=1',
    '    return',
    '  fi',
    '',
    '  while IFS= read -r file; do',
    '    [[ -z "$file" ]] && continue',
    '    local tier',
    '    tier="$(classify_file "$file")"',
    '',
    '    case "$tier" in',
    '      1) TIER1_FILES+=("$file") ;;',
    '      2) TIER2_FILES+=("$file") ;;',
    '      3) TIER3_FILES+=("$file") ;;',
    '    esac',
    '',
    '    if (( tier > MAX_TIER )); then',
    '      MAX_TIER=$tier',
    '    fi',
    '  done <<< "$changed_files"',
    '',
    '  echo "✔ Classified files: ${#TIER1_FILES[@]} tier-1, ${#TIER2_FILES[@]} tier-2, ${#TIER3_FILES[@]} tier-3 → overall Tier ${MAX_TIER}"',
    '}',
    '',
    '# ============================================================================',
    '# Step 3: Required Checks Computation',
    '# Maps the determined tier to the CI checks that must pass.',
    '# Higher tiers are strict supersets of lower tiers.',
    '# ============================================================================',
    'compute_required_checks() {',
    '  case "$MAX_TIER" in',
    '    1)',
    '      REQUIRED_CHECKS=("lint" "harness-smoke")',
    '      ;;',
    '    2)',
    '      REQUIRED_CHECKS=("lint" "type-check" "test" "build" "structural-tests" "review-agent" "harness-smoke")',
    '      ;;',
    '    3)',
    '      REQUIRED_CHECKS=("lint" "type-check" "test" "build" "structural-tests" "review-agent" "harness-smoke" "manual-approval" "expanded-coverage")',
    '      ;;',
    '    *)',
    '      echo "::warning::Unexpected tier ${MAX_TIER}. Applying Tier 3 checks as safeguard."',
    '      MAX_TIER=3',
    '      REQUIRED_CHECKS=("lint" "type-check" "test" "build" "structural-tests" "review-agent" "harness-smoke" "manual-approval" "expanded-coverage")',
    '      ;;',
    '  esac',
    '',
    '  echo "✔ Required checks (${#REQUIRED_CHECKS[@]}): ${REQUIRED_CHECKS[*]}"',
    '}',
    '',
    '# ============================================================================',
    '# Step 4: Docs Drift Assertion',
    '# Detects when source code changes lack corresponding documentation updates.',
    '#   relaxed  → skip entirely',
    '#   standard → emit warning',
    '#   strict   → fail the gate',
    '# ============================================================================',
    'check_docs_drift() {',
    '  if [[ "$STRICTNESS" == "relaxed" ]]; then',
    '    echo "✔ Docs drift check skipped (strictness=relaxed)"',
    '    return 0',
    '  fi',
    '',
    '  # Only relevant when source files (tier 2+) were changed',
    '  local has_source=false',
    '  if (( ${#TIER2_FILES[@]} > 0 || ${#TIER3_FILES[@]} > 0 )); then',
    '    has_source=true',
    '  fi',
    '',
    '  if ! $has_source; then',
    '    echo "✔ No source files changed — docs drift N/A"',
    '    return 0',
    '  fi',
    '',
    '  # Check if any documentation files were also modified',
    '  local has_docs=false',
    '  for file in "${TIER1_FILES[@]+"${TIER1_FILES[@]}"}"; do',
    '    case "$file" in',
    '      *.md|docs/*) has_docs=true; break ;;',
    '    esac',
    '  done',
    '',
    '  if ! $has_docs; then',
    '    DOCS_DRIFT_DETECTED=true',
    '    DOCS_DRIFT_WARNING="Source files changed without documentation updates. Consider updating README.md or relevant docs."',
    '',
    '    if [[ "$STRICTNESS" == "strict" ]]; then',
    '      echo "::error::Docs drift: ${DOCS_DRIFT_WARNING}"',
    '      return 1',
    '    else',
    '      echo "::warning::Docs drift: ${DOCS_DRIFT_WARNING}"',
    '    fi',
    '  else',
    '    echo "✔ Documentation updated alongside source changes"',
    '  fi',
    '}',
    '',
    '# ============================================================================',
    '# Step 5: Review Agent Completion Check',
    '# For Tier 2+, verifies the review agent has analyzed this SHA.',
    '# On first run the agent hasn\'t executed yet, so status is "pending".',
    '# Subsequent runs (triggered by remediation loop) query the API.',
    '# ============================================================================',
    'check_review_agent() {',
    '  if (( MAX_TIER < 2 )); then',
    '    REVIEW_AGENT_RESULT="skipped"',
    '    echo "✔ Review agent: skipped (Tier 1)"',
    '    return 0',
    '  fi',
    '',
    '  # Accept explicit status injected by the remediation loop',
    '  if [[ -n "${REVIEW_AGENT_STATUS:-}" ]]; then',
    '    REVIEW_AGENT_RESULT="$REVIEW_AGENT_STATUS"',
    '    echo "✔ Review agent: ${REVIEW_AGENT_RESULT} (from env)"',
    '    return 0',
    '  fi',
    '',
    '  # Query GitHub API for review-agent check run on this commit',
    '  if command -v gh &>/dev/null && [[ -n "${GITHUB_REPOSITORY:-}" ]]; then',
    '    local conclusion',
    '    conclusion="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${VERIFIED_SHA}/check-runs" \\',
    '      --jq \'.check_runs[] | select(.name == "review-agent") | .conclusion\' 2>/dev/null \\',
    '      | head -1 || echo "")"',
    '',
    '    case "$conclusion" in',
    '      success)  REVIEW_AGENT_RESULT="approved" ;;',
    '      failure)  REVIEW_AGENT_RESULT="rejected" ;;',
    '      *)        REVIEW_AGENT_RESULT="pending" ;;',
    '    esac',
    '  else',
    '    REVIEW_AGENT_RESULT="pending"',
    '  fi',
    '',
    '  echo "✔ Review agent: ${REVIEW_AGENT_RESULT}"',
    '}',
    '',
    '# ============================================================================',
    '# Step 6: Output Results',
    '# Emits structured JSON and sets GitHub Actions step outputs.',
    '# ============================================================================',
    '',
    '# Build a JSON array string from arguments. Returns "[]" for no arguments.',
    'to_json_array() {',
    '  if (( $# == 0 )); then',
    '    echo "[]"',
    '    return',
    '  fi',
    '  local json="[" sep=""',
    '  for item in "$@"; do',
    '    json+="${sep}\\"${item}\\""',
    '    sep=","',
    '  done',
    '  echo "${json}]"',
    '}',
    '',
    'output_results() {',
    '  local tier_name',
    '  case "$MAX_TIER" in',
    '    1) tier_name="low" ;;',
    '    2) tier_name="medium" ;;',
    '    3) tier_name="high" ;;',
    '    *) tier_name="unknown" ;;',
    '  esac',
    '',
    '  local checks_json tier1_json tier2_json tier3_json',
    '',
    '  checks_json="$(to_json_array "${REQUIRED_CHECKS[@]}")"',
    '',
    '  if (( ${#TIER1_FILES[@]} > 0 )); then',
    '    tier1_json="$(to_json_array "${TIER1_FILES[@]}")"',
    '  else',
    '    tier1_json="[]"',
    '  fi',
    '',
    '  if (( ${#TIER2_FILES[@]} > 0 )); then',
    '    tier2_json="$(to_json_array "${TIER2_FILES[@]}")"',
    '  else',
    '    tier2_json="[]"',
    '  fi',
    '',
    '  if (( ${#TIER3_FILES[@]} > 0 )); then',
    '    tier3_json="$(to_json_array "${TIER3_FILES[@]}")"',
    '  else',
    '    tier3_json="[]"',
    '  fi',
    '',
    '  # Escape warning message for JSON safety',
    '  local escaped_warning="${DOCS_DRIFT_WARNING//\\\\/\\\\\\\\}"',
    '  escaped_warning="${escaped_warning//\\"/\\\\\\"}"',
    '',
    '  local result',
    '  result=$(cat <<EOF',
    '{',
    '  "sha": "${VERIFIED_SHA}",',
    '  "tier": ${MAX_TIER},',
    '  "tierName": "${tier_name}",',
    '  "requiredChecks": ${checks_json},',
    '  "changedFiles": {',
    '    "tier1": ${tier1_json},',
    '    "tier2": ${tier2_json},',
    '    "tier3": ${tier3_json}',
    '  },',
    '  "docsDrift": {',
    '    "detected": ${DOCS_DRIFT_DETECTED},',
    '    "warning": "${escaped_warning}"',
    '  },',
    '  "reviewAgentStatus": "${REVIEW_AGENT_RESULT}"',
    '}',
    'EOF',
    ')',
    '',
    '  echo ""',
    '  echo "═══════════════════════════════════════════════════"',
    '  echo " Risk Policy Gate Result"',
    '  echo "═══════════════════════════════════════════════════"',
    '  echo "$result"',
    '  echo "═══════════════════════════════════════════════════"',
    '',
    '  # Set GitHub Actions step outputs for downstream job conditionals',
    '  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then',
    '    {',
    '      echo "sha=${VERIFIED_SHA}"',
    '      echo "tier=${MAX_TIER}"',
    '      echo "tier-name=${tier_name}"',
    '      echo "required-checks=${checks_json}"',
    '      echo "docs-drift=${DOCS_DRIFT_DETECTED}"',
    '      echo "review-agent-status=${REVIEW_AGENT_RESULT}"',
    '      # Multi-line output for the full JSON result',
    '      echo "result<<GATE_EOF"',
    '      echo "$result"',
    '      echo "GATE_EOF"',
    '    } >> "$GITHUB_OUTPUT"',
    '    echo ""',
    '    echo "✔ GitHub Actions outputs written"',
    '  fi',
    '}',
    '',
    '# ============================================================================',
    '# Main',
    '# ============================================================================',
    'main() {',
    '  echo "╔═════════════════════════════════════════════════╗"',
    '  echo "║       Risk Policy Gate — Preflight Check        ║"',
    '  echo "╚═════════════════════════════════════════════════╝"',
    '  echo ""',
    '',
    '  verify_sha',
    '  classify_changed_files',
    '  compute_required_checks',
    '  check_docs_drift',
    '  check_review_agent',
    '  output_results',
    '',
    '  echo ""',
    '  echo "✔ Gate completed — Tier ${MAX_TIER} ($(',
    '    case $MAX_TIER in 1) echo low;; 2) echo medium;; 3) echo high;; *) echo unknown;; esac',
    '  )) — ${#REQUIRED_CHECKS[@]} checks required"',
    '}',
    '',
    'main "$@"',
  ];
  return lines.join('\n') + '\n';
}

function buildTsScript(tier2Patterns: string, tier3Patterns: string): string {
  return `#!/usr/bin/env npx tsx
// ============================================================================
// Risk Policy Gate — TypeScript alternative for complex logic
//
// Runs the same preflight checks as the shell version but with:
//   - Proper glob matching against harness.config.json patterns
//   - Type-safe JSON output
//   - Structured error handling
//
// Usage: npx tsx scripts/risk-policy-gate.ts
//
// Environment variables (set by CI workflow):
//   EXPECTED_SHA          — PR head SHA from the CI event payload
//   BASE_REF              — PR base branch name (default: main)
//   STRICTNESS            — relaxed | standard | strict (default: relaxed)
//   REVIEW_AGENT_STATUS   — optional override from remediation loop
//   GITHUB_OUTPUT         — path to GitHub Actions output file
//   GITHUB_REPOSITORY     — owner/repo
// ============================================================================

import { execSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// --- Types ---

interface RiskTierDef {
  name: string;
  patterns: string[];
  requiredChecks: string[];
}

interface HarnessRiskConfig {
  version: string;
  riskTiers: {
    tier1: RiskTierDef;
    tier2: RiskTierDef;
    tier3: RiskTierDef;
  };
  docsDrift?: {
    trackedDocs?: string[];
    requireUpdateWithCodeChange?: boolean;
    exemptPatterns?: string[];
  };
  shaDiscipline?: {
    enforceExactSha?: boolean;
  };
}

interface GateResult {
  sha: string;
  tier: 1 | 2 | 3;
  tierName: 'low' | 'medium' | 'high';
  requiredChecks: string[];
  changedFiles: {
    tier1: string[];
    tier2: string[];
    tier3: string[];
  };
  docsDrift: {
    detected: boolean;
    warning: string;
  };
  reviewAgentStatus: 'pending' | 'approved' | 'rejected' | 'skipped';
}

// --- Defaults (used when harness.config.json is missing or malformed) ---

const DEFAULT_CONFIG: HarnessRiskConfig = {
  version: '1.0.0',
  riskTiers: {
    tier1: {
      name: 'low',
      patterns: ['**/*.md', '**/*.txt', 'LICENSE', '.gitignore', '.editorconfig', '.prettierrc*', '.vscode/**'],
      requiredChecks: ['lint'],
    },
    tier2: {
      name: 'medium',
      patterns: [
${tier2Patterns}
      ],
      requiredChecks: ['lint', 'type-check', 'test', 'review-agent'],
    },
    tier3: {
      name: 'high',
      patterns: [
${tier3Patterns}
      ],
      requiredChecks: ['lint', 'type-check', 'test', 'review-agent', 'manual-review'],
    },
  },
  docsDrift: {
    trackedDocs: ['README.md'],
    requireUpdateWithCodeChange: false,
  },
};

// --- Required checks per tier (full gate-enforced set) ---

const TIER_CHECKS: Record<number, string[]> = {
  1: ['lint', 'harness-smoke'],
  2: ['lint', 'type-check', 'test', 'build', 'structural-tests', 'review-agent', 'harness-smoke'],
  3: [
    'lint',
    'type-check',
    'test',
    'build',
    'structural-tests',
    'review-agent',
    'harness-smoke',
    'manual-approval',
    'expanded-coverage',
  ],
};

// --- Glob matching ---

/**
 * Converts a glob pattern to a regular expression.
 * Supports: ** (any path), * (any segment), ? (single char), . (escaped).
 */
function globToRegex(pattern: string): RegExp {
  let regex = '^';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === '*' && next === '*') {
      // ** — match any path depth
      if (pattern[i + 2] === '/') {
        regex += '(.+/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
    } else if (char === '*') {
      // * — match within a single path segment
      regex += '[^/]*';
      i++;
    } else if (char === '?') {
      regex += '[^/]';
      i++;
    } else if (char === '.') {
      regex += '\\\\.';
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  regex += '$';
  return new RegExp(regex);
}

/** Test whether a file path matches a glob pattern. */
function matchGlob(file: string, pattern: string): boolean {
  return globToRegex(pattern).test(file);
}

/** Test whether a file matches any pattern in the list. */
function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(file, p));
}

// --- Shell helpers ---

function git(...args: string[]): string {
  try {
    return execSync(\`git \\\${args.join(' ')}\`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function ghApi(endpoint: string, jq: string): string {
  try {
    return execSync(\`gh api "\\\${endpoint}" --jq '\\\${jq}'\`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

// --- Config reader ---

function loadConfig(repoRoot: string): HarnessRiskConfig {
  const configPath = join(repoRoot, 'harness.config.json');

  if (!existsSync(configPath)) {
    console.log('::notice::harness.config.json not found — using built-in defaults');
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate minimum expected structure
    if (!parsed.riskTiers?.tier1?.patterns || !parsed.riskTiers?.tier2?.patterns || !parsed.riskTiers?.tier3?.patterns) {
      console.log('::warning::harness.config.json has unexpected structure — merging with defaults');
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        riskTiers: {
          tier1: { ...DEFAULT_CONFIG.riskTiers.tier1, ...parsed.riskTiers?.tier1 },
          tier2: { ...DEFAULT_CONFIG.riskTiers.tier2, ...parsed.riskTiers?.tier2 },
          tier3: { ...DEFAULT_CONFIG.riskTiers.tier3, ...parsed.riskTiers?.tier3 },
        },
      };
    }

    return parsed as HarnessRiskConfig;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(\`::warning::Failed to parse harness.config.json: \\\${msg} — using defaults\`);
    return DEFAULT_CONFIG;
  }
}

// ============================================================================
// Step 1: SHA Discipline
// ============================================================================
function verifySha(): string {
  const actualSha = git('rev-parse', 'HEAD');
  const expectedSha = process.env.EXPECTED_SHA ?? '';

  if (!expectedSha) {
    console.log('::notice::EXPECTED_SHA not set — skipping SHA discipline check (local mode)');
    return actualSha;
  }

  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    console.error(
      \`::error::SHA discipline violation: HEAD (\\\${actualSha}) ≠ expected (\\\${expectedSha}). \` +
        'The branch changed after this workflow was triggered. Re-run on the latest commit.',
    );
    process.exit(1);
  }

  console.log(\`✔ SHA verified: \\\${actualSha.slice(0, 12)}\`);
  return actualSha;
}

// ============================================================================
// Step 2: Changed File Classification
// ============================================================================
function classifyFiles(config: HarnessRiskConfig): {
  tier1: string[];
  tier2: string[];
  tier3: string[];
  maxTier: 1 | 2 | 3;
} {
  const baseRef = process.env.BASE_REF ?? 'main';

  // Ensure base branch is fetchable
  if (!git('rev-parse', '--verify', \`origin/\\\${baseRef}\`)) {
    git('fetch', 'origin', baseRef, '--depth=1');
  }

  const mergeBase = git('merge-base', \`origin/\\\${baseRef}\`, 'HEAD');
  if (!mergeBase) {
    console.log(\`::warning::Could not compute merge base against origin/\\\${baseRef}. Defaulting to Tier 3.\`);
    return { tier1: [], tier2: [], tier3: [], maxTier: 3 };
  }

  const diff = git('diff', '--name-only', \`\\\${mergeBase}...HEAD\`);
  if (!diff) {
    console.log('::notice::No changed files detected. Defaulting to Tier 1.');
    return { tier1: [], tier2: [], tier3: [], maxTier: 1 };
  }

  const files = diff.split('\\n').filter(Boolean);
  const tier1: string[] = [];
  const tier2: string[] = [];
  const tier3: string[] = [];

  const { tier1: t1, tier2: t2, tier3: t3 } = config.riskTiers;

  for (const file of files) {
    // Check tiers in descending order — highest match wins
    if (matchesAny(file, t3.patterns)) {
      tier3.push(file);
    } else if (matchesAny(file, t2.patterns)) {
      tier2.push(file);
    } else if (matchesAny(file, t1.patterns)) {
      tier1.push(file);
    } else {
      // Default: Tier 2 for unknown files
      tier2.push(file);
    }
  }

  const maxTier: 1 | 2 | 3 = tier3.length > 0 ? 3 : tier2.length > 0 ? 2 : 1;

  console.log(\`✔ Classified files: \\\${tier1.length} tier-1, \\\${tier2.length} tier-2, \\\${tier3.length} tier-3 → overall Tier \\\${maxTier}\`);

  return { tier1, tier2, tier3, maxTier };
}

// ============================================================================
// Step 3: Required Checks
// ============================================================================
function computeChecks(tier: number): string[] {
  const checks = TIER_CHECKS[tier] ?? TIER_CHECKS[3];
  console.log(\`✔ Required checks (\\\${checks.length}): \\\${checks.join(', ')}\`);
  return checks;
}

// ============================================================================
// Step 4: Docs Drift
// ============================================================================
function checkDocsDrift(
  strictness: string,
  changedFiles: { tier1: string[]; tier2: string[]; tier3: string[] },
): { detected: boolean; warning: string } {
  if (strictness === 'relaxed') {
    console.log('✔ Docs drift check skipped (strictness=relaxed)');
    return { detected: false, warning: '' };
  }

  const hasSource = changedFiles.tier2.length > 0 || changedFiles.tier3.length > 0;
  if (!hasSource) {
    console.log('✔ No source files changed — docs drift N/A');
    return { detected: false, warning: '' };
  }

  const hasDocs = changedFiles.tier1.some((f) => f.endsWith('.md') || f.startsWith('docs/'));

  if (!hasDocs) {
    const warning = 'Source files changed without documentation updates. Consider updating README.md or relevant docs.';

    if (strictness === 'strict') {
      console.error(\`::error::Docs drift: \\\${warning}\`);
      process.exit(1);
    } else {
      console.log(\`::warning::Docs drift: \\\${warning}\`);
    }

    return { detected: true, warning };
  }

  console.log('✔ Documentation updated alongside source changes');
  return { detected: false, warning: '' };
}

// ============================================================================
// Step 5: Review Agent Status
// ============================================================================
function checkReviewAgent(tier: number, sha: string): GateResult['reviewAgentStatus'] {
  if (tier < 2) {
    console.log('✔ Review agent: skipped (Tier 1)');
    return 'skipped';
  }

  // Accept explicit override from remediation loop
  const envStatus = process.env.REVIEW_AGENT_STATUS;
  if (envStatus) {
    console.log(\`✔ Review agent: \\\${envStatus} (from env)\`);
    return envStatus as GateResult['reviewAgentStatus'];
  }

  // Query GitHub API for check-run status
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    const conclusion = ghApi(
      \`repos/\\\${repo}/commits/\\\${sha}/check-runs\`,
      '.check_runs[] | select(.name == "review-agent") | .conclusion',
    )
      .split('\\n')[0]
      ?.trim();

    if (conclusion === 'success') {
      console.log('✔ Review agent: approved');
      return 'approved';
    }
    if (conclusion === 'failure') {
      console.log('✔ Review agent: rejected');
      return 'rejected';
    }
  }

  console.log('✔ Review agent: pending');
  return 'pending';
}

// ============================================================================
// Step 6: Output
// ============================================================================
function outputResults(result: GateResult): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(' Risk Policy Gate Result');
  console.log('═══════════════════════════════════════════════════');
  console.log(JSON.stringify(result, null, 2));
  console.log('═══════════════════════════════════════════════════');

  // Set GitHub Actions outputs
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const lines = [
      \`sha=\\\${result.sha}\`,
      \`tier=\\\${result.tier}\`,
      \`tier-name=\\\${result.tierName}\`,
      \`required-checks=\\\${JSON.stringify(result.requiredChecks)}\`,
      \`docs-drift=\\\${result.docsDrift.detected}\`,
      \`review-agent-status=\\\${result.reviewAgentStatus}\`,
      \`result<<GATE_EOF\`,
      JSON.stringify(result, null, 2),
      'GATE_EOF',
    ];

    appendFileSync(outputPath, lines.join('\\n') + '\\n', 'utf-8');
    console.log('');
    console.log('✔ GitHub Actions outputs written');
  }
}

// ============================================================================
// Main
// ============================================================================
function main(): void {
  console.log('╔═════════════════════════════════════════════════╗');
  console.log('║       Risk Policy Gate — Preflight Check        ║');
  console.log('║                (TypeScript runner)               ║');
  console.log('╚═════════════════════════════════════════════════╝');
  console.log('');

  const repoRoot = git('rev-parse', '--show-toplevel') || process.cwd();
  const strictness = process.env.STRICTNESS ?? 'relaxed';
  const config = loadConfig(repoRoot);

  // Step 1
  const sha = verifySha();

  // Step 2
  const changedFiles = classifyFiles(config);

  // Step 3
  const requiredChecks = computeChecks(changedFiles.maxTier);

  // Step 4
  const docsDrift = checkDocsDrift(strictness, changedFiles);

  // Step 5
  const reviewAgentStatus = checkReviewAgent(changedFiles.maxTier, sha);

  // Step 6
  const tierNames: Record<number, GateResult['tierName']> = { 1: 'low', 2: 'medium', 3: 'high' };
  const result: GateResult = {
    sha,
    tier: changedFiles.maxTier,
    tierName: tierNames[changedFiles.maxTier] ?? 'high',
    requiredChecks,
    changedFiles: {
      tier1: changedFiles.tier1,
      tier2: changedFiles.tier2,
      tier3: changedFiles.tier3,
    },
    docsDrift,
    reviewAgentStatus,
  };

  outputResults(result);

  console.log('');
  console.log(
    \`✔ Gate completed — Tier \\\${result.tier} (\\\${result.tierName}) — \\\${requiredChecks.length} checks required\`,
  );
}

main();
`;
}

function buildWorkflowYaml(testCmd: string, lintCmd: string, buildCmd: string): string {
  // Workflow YAML uses array join to avoid template-literal escaping for ${{ }}
  const lines = [
    'name: Risk Policy Gate',
    '',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened]',
    '  workflow_dispatch:',
    '    inputs:',
    '      pr_number:',
    "        description: 'PR number to run risk gate for'",
    '        required: true',
    '        type: string',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: read',
    '',
    'concurrency:',
    '  group: risk-gate-${{ github.event.pull_request.number || inputs.pr_number }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  # ==========================================================================',
    '  # Preflight gate — classifies the PR and determines required checks.',
    '  # All other jobs depend on this and use its outputs for conditional execution.',
    '  # ==========================================================================',
    '  risk-gate:',
    '    name: Risk Policy Gate',
    '    runs-on: ubuntu-latest',
    '    outputs:',
    '      sha: ${{ steps.gate.outputs.sha }}',
    '      tier: ${{ steps.gate.outputs.tier }}',
    '      tier-name: ${{ steps.gate.outputs.tier-name }}',
    '      required-checks: ${{ steps.gate.outputs.required-checks }}',
    '      docs-drift: ${{ steps.gate.outputs.docs-drift }}',
    '      review-agent-status: ${{ steps.gate.outputs.review-agent-status }}',
    '    steps:',
    '      - name: Resolve PR context',
    '        id: pr-context',
    "        if: github.event_name == 'workflow_dispatch'",
    '        env:',
    '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '        run: |',
    '          PR_JSON=$(gh pr view "${{ inputs.pr_number }}" --repo "${{ github.repository }}" --json headRefOid,baseRefName)',
    '          echo "head-sha=$(echo "$PR_JSON" | jq -r \'.headRefOid\')" >> "$GITHUB_OUTPUT"',
    '          echo "base-ref=$(echo "$PR_JSON" | jq -r \'.baseRefName\')" >> "$GITHUB_OUTPUT"',
    '',
    '      - name: Checkout at PR head SHA',
    '        uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ steps.pr-context.outputs.head-sha || github.event.pull_request.head.sha }}',
    '          fetch-depth: 0',
    '',
    '      - name: Run risk policy gate',
    '        id: gate',
    '        run: bash scripts/risk-policy-gate.sh',
    '        env:',
    '          EXPECTED_SHA: ${{ steps.pr-context.outputs.head-sha || github.event.pull_request.head.sha }}',
    '          BASE_REF: ${{ steps.pr-context.outputs.base-ref || github.event.pull_request.base.ref }}',
    '          STRICTNESS: relaxed',
    '',
    '      - name: Annotate PR with tier',
    '        run: |',
    '          echo "### Risk Policy Gate" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "| Field | Value |" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "|-------|-------|" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "| **Tier** | ${{ steps.gate.outputs.tier }} (${{ steps.gate.outputs.tier-name }}) |" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "| **SHA** | \\`${{ steps.gate.outputs.sha }}\\` |" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "| **Docs Drift** | ${{ steps.gate.outputs.docs-drift }} |" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "| **Review Agent** | ${{ steps.gate.outputs.review-agent-status }} |" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "<details><summary>Required Checks</summary>" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "" >> "$GITHUB_STEP_SUMMARY"',
    '          echo \'```json\' >> "$GITHUB_STEP_SUMMARY"',
    '          echo \'${{ steps.gate.outputs.required-checks }}\' >> "$GITHUB_STEP_SUMMARY"',
    '          echo \'```\' >> "$GITHUB_STEP_SUMMARY"',
    '          echo "</details>" >> "$GITHUB_STEP_SUMMARY"',
    '',
    '  # ==========================================================================',
    '  # Downstream jobs — gated by risk tier using contains() on required-checks.',
    '  # Each job only runs if the gate determined it is required for this PR.',
    '  # ==========================================================================',
    '',
    '  lint:',
    '    name: Lint',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'lint')",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ needs.risk-gate.outputs.sha }}',
    '',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '18'",
    '',
    '      - uses: actions/cache@v4',
    '        with:',
    '          path: ~/.npm',
    "          key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}",
    '          restore-keys: ${{ runner.os }}-npm-',
    '',
    '      - run: npm ci',
    `      - run: ${lintCmd}`,
    '',
    '  type-check:',
    '    name: Type Check',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'type-check')",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ needs.risk-gate.outputs.sha }}',
    '',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '18'",
    '',
    '      - uses: actions/cache@v4',
    '        with:',
    '          path: ~/.npm',
    "          key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}",
    '          restore-keys: ${{ runner.os }}-npm-',
    '',
    '      - run: npm ci',
    '      - run: npm run typecheck',
    '',
    '  test:',
    '    name: Test',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'test')",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ needs.risk-gate.outputs.sha }}',
    '',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '18'",
    '',
    '      - uses: actions/cache@v4',
    '        with:',
    '          path: ~/.npm',
    "          key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}",
    '          restore-keys: ${{ runner.os }}-npm-',
    '',
    '      - run: npm ci',
    `      - run: ${testCmd}`,
    '',
    '  build:',
    '    name: Build',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'build')",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ needs.risk-gate.outputs.sha }}',
    '',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '18'",
    '',
    '      - uses: actions/cache@v4',
    '        with:',
    '          path: ~/.npm',
    "          key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}",
    '          restore-keys: ${{ runner.os }}-npm-',
    '',
    '      - run: npm ci',
    `      - run: ${buildCmd}`,
    '',
    '  harness-smoke:',
    '    name: Harness Smoke Test',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'harness-smoke')",
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ needs.risk-gate.outputs.sha }}',
    '',
    '      - name: Validate harness.config.json',
    "        run: node -e \"JSON.parse(require('fs').readFileSync('harness.config.json','utf8')); console.log('✔ harness.config.json is valid JSON')\"",
    '',
    '      - name: Check critical files exist',
    '        run: |',
    '          for f in src/index.ts src/cli.ts package.json tsconfig.json; do',
    '            if [ ! -f "$f" ]; then',
    '              echo "::error::Critical file missing: $f"',
    '              exit 1',
    '            fi',
    '          done',
    '          echo "✔ All critical files present"',
    '',
    '  manual-approval:',
    '    name: Manual Approval (Tier 3)',
    '    needs: risk-gate',
    "    if: contains(fromJSON(needs.risk-gate.outputs.required-checks), 'manual-approval')",
    '    runs-on: ubuntu-latest',
    '    environment: tier3-approval',
    '    steps:',
    '      - name: Tier 3 change detected',
    '        run: |',
    '          echo "::warning::This PR touches critical paths and requires manual approval."',
    '          echo "A maintainer must approve the \'tier3-approval\' environment to proceed."',
    '          echo ""',
    '          echo "Changed tier-3 files are listed in the Risk Policy Gate summary."',
  ];
  return lines.join('\n') + '\n';
}
