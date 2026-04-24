/**
 * Deterministic builder for the harnext **tagger** GitHub Actions
 * workflow.
 *
 * When the wizard's first stage runs on `github-actions` (rather than
 * the local cron poller), there's no process on the user's machine
 * that can tag newly-created issues with the first-stage label to
 * kick off the pipeline. This workflow fills that role: on any issue
 * event it checks the filter criteria and, if the issue is unlabeled
 * by harnext and matches the filter, applies the first-stage label.
 *
 * Why deterministic (not LLM-generated): the workflow body is small,
 * well-specified, and security-sensitive (it applies labels on new
 * issues). We don't want the coding agent hallucinating a different
 * shape each run. It's also instant vs. the 1–2 minute agent roundtrip
 * of `generateStageWorkflow`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  AWAITING_APPROVAL_LABEL,
  NEEDS_JUDGMENT_LABEL,
  getStageRunner,
  type GithubIssueFilter,
  type StageEntry,
} from './github-connection.js';

/** Repo-relative path the wizard always writes to. */
export const TAGGER_WORKFLOW_PATH = '.github/workflows/harnext-tagger.yml';

export interface BuildTaggerWorkflowInput {
  /** First stage in the pipeline — its label becomes the initial tag. */
  firstStage: StageEntry;
  /** Filter the wizard picked; controls which new issues get tagged. */
  filter: GithubIssueFilter;
}

/** Convention for the first-stage workflow filename, matching the setup wizard. */
function firstStageWorkflowFilename(firstStage: StageEntry): string {
  return `harnext-${firstStage.id}.yml`;
}

/**
 * Render the tagger workflow YAML as a string. Pure — no filesystem
 * side effects, safe to snapshot-test.
 */
export function buildTaggerWorkflow(input: BuildTaggerWorkflowInput): string {
  const firstLabel = input.firstStage.label;
  const filterStep = filterStepBody(input.filter);
  const filterSummary = filterSummary_(input.filter);
  // When the first stage runs on GitHub Actions, applying its label
  // via GITHUB_TOKEN does NOT fire the stage workflow's
  // `issues.labeled` trigger — GitHub suppresses those to avoid
  // infinite loops. The tagger must explicitly dispatch the first
  // stage's workflow via `gh workflow run`. When the first stage runs
  // locally, we skip the dispatch (the cron poller picks up by label).
  const firstStageRunner = getStageRunner(input.firstStage);
  const dispatchFirstStage = firstStageRunner.kind === 'github-actions';
  const firstStageFilename = firstStageWorkflowFilename(input.firstStage);

  return [
    `# harnext tagger — bootstraps new issues into the pipeline.`,
    `# Applies ${firstLabel} to issues that:`,
    `#   1. are not already carrying any harnext:* label`,
    `#   2. match the configured filter (${filterSummary})`,
    `# Regenerate via the harnext setup wizard; hand-edits survive re-runs only`,
    `# when the setup wizard's first stage stays on github-actions.`,
    `name: harnext-tagger`,
    ``,
    `on:`,
    `  issues:`,
    `    types: [opened, reopened, labeled, assigned]`,
    ``,
    `concurrency:`,
    `  group: harnext-tagger-\${{ github.event.issue.number }}`,
    `  cancel-in-progress: false`,
    ``,
    `jobs:`,
    `  tag-new-issue:`,
    `    if: \${{ !github.event.issue.pull_request }}`,
    `    runs-on: ubuntu-latest`,
    `    permissions:`,
    `      issues: write`,
    // `actions: write` is only needed when we dispatch the first
    // stage's workflow. Keep the grant narrow for the local-first-stage
    // case so the tagger's token footprint stays minimal.
    ...(dispatchFirstStage ? [`      actions: write`] : []),
    `    steps:`,
    `      - name: Skip if the issue is already in the harnext pipeline`,
    `        id: gate`,
    `        env:`,
    `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    `        run: |`,
    `          set -euo pipefail`,
    `          labels=$(gh issue view "\${{ github.event.issue.number }}" \\`,
    `            --repo "\${{ github.repository }}" \\`,
    `            --json labels --jq '.labels[].name')`,
    `          # Any stage label means a human (or earlier tick) already`,
    `          # claimed this issue for harnext. Control labels`,
    `          # (${AWAITING_APPROVAL_LABEL} / ${NEEDS_JUDGMENT_LABEL}) also`,
    `          # mean "waiting on a human, don't re-label."`,
    `          if printf '%s\\n' "$labels" | grep -qE '^harnext:'; then`,
    `            echo "already=true" >> "$GITHUB_OUTPUT"`,
    `            exit 0`,
    `          fi`,
    `          echo "already=false" >> "$GITHUB_OUTPUT"`,
    ``,
    `      - name: Apply filter`,
    `        if: steps.gate.outputs.already == 'false'`,
    `        id: filter`,
    `        env:`,
    `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    `        run: |`,
    `          set -euo pipefail`,
    indent(filterStep, 10),
    ``,
    `      - name: Apply first-stage label`,
    `        if: steps.filter.outputs.matches == 'true'`,
    `        env:`,
    `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    `        run: |`,
    `          set -euo pipefail`,
    `          gh issue edit "\${{ github.event.issue.number }}" \\`,
    `            --repo "\${{ github.repository }}" \\`,
    `            --add-label "${firstLabel}"`,
    ...(dispatchFirstStage
      ? [
          ``,
          `      - name: Dispatch first-stage workflow`,
          `        if: steps.filter.outputs.matches == 'true'`,
          `        env:`,
          `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
          `        run: |`,
          `          set -euo pipefail`,
          `          # Label-add via GITHUB_TOKEN does not fire \`issues.labeled\`,`,
          `          # so the first stage's workflow will not auto-trigger from`,
          `          # the label alone. Dispatch it explicitly via workflow_dispatch.`,
          `          gh workflow run "${firstStageFilename}" \\`,
          `            --repo "\${{ github.repository }}" \\`,
          `            --field issue_number="\${{ github.event.issue.number }}"`,
        ]
      : []),
    ``,
  ].join('\n');
}

/**
 * Filesystem side of the generator — writes the YAML at the expected
 * path. Returns whether the file was new or overwritten so the wizard
 * can report it. Never prompts the user here; confirmation is the
 * wizard's job.
 */
export function writeTaggerWorkflow(input: {
  cwd: string;
  firstStage: StageEntry;
  filter: GithubIssueFilter;
}): { path: string; existed: boolean } {
  const rel = TAGGER_WORKFLOW_PATH;
  const abs = isAbsolute(rel) ? rel : join(input.cwd, rel);
  const existed = existsSync(abs);
  mkdirSync(dirname(abs), { recursive: true });
  const yaml = buildTaggerWorkflow({
    firstStage: input.firstStage,
    filter: input.filter,
  });
  writeFileSync(abs, yaml, 'utf-8');
  return { path: abs, existed };
}

// ──────────────────────────────────────────────────────────────────────

/**
 * Build the bash body for the filter step. Writes `matches=true|false`
 * to `$GITHUB_OUTPUT` for the next step to gate on.
 */
function filterStepBody(filter: GithubIssueFilter): string {
  switch (filter.kind) {
    case 'none':
      return 'echo "matches=true" >> "$GITHUB_OUTPUT"';
    case 'label': {
      const needle = shellEscape(filter.label);
      return [
        `labels=$(gh issue view "\${{ github.event.issue.number }}" \\`,
        `  --repo "\${{ github.repository }}" \\`,
        `  --json labels --jq '.labels[].name')`,
        `if printf '%s\\n' "$labels" | grep -qx "${needle}"; then`,
        `  echo "matches=true" >> "$GITHUB_OUTPUT"`,
        `else`,
        `  echo "matches=false" >> "$GITHUB_OUTPUT"`,
        `fi`,
      ].join('\n');
    }
    case 'assignee': {
      const needle = shellEscape(filter.assignee);
      return [
        `assignees=$(gh issue view "\${{ github.event.issue.number }}" \\`,
        `  --repo "\${{ github.repository }}" \\`,
        `  --json assignees --jq '.assignees[].login')`,
        `if printf '%s\\n' "$assignees" | grep -qx "${needle}"; then`,
        `  echo "matches=true" >> "$GITHUB_OUTPUT"`,
        `else`,
        `  echo "matches=false" >> "$GITHUB_OUTPUT"`,
        `fi`,
      ].join('\n');
    }
  }
}

function filterSummary_(filter: GithubIssueFilter): string {
  switch (filter.kind) {
    case 'none':
      return 'any open issue';
    case 'label':
      return `label = ${filter.label}`;
    case 'assignee':
      return `assignee = ${filter.assignee}`;
  }
}

function shellEscape(s: string): string {
  // Strip anything that could break the grep -qx value. Label and
  // login names are constrained server-side but we still sanity-check
  // to avoid workflow-syntax surprises.
  return s.replace(/[`"$\\]/g, '');
}

function indent(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line) => (line.length === 0 ? '' : pad + line))
    .join('\n');
}
