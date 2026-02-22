# CodeFactory

**Automated harness engineering for AI coding agents.**

CodeFactory is a CLI tool that sets up production-grade CI pipelines, code review agents, issue automation, and safety gates for any repository -- all tailored to your stack. Run `codefactory init` and it uses an AI coding agent (Claude Code, AWS Kiro, or OpenAI Codex) to analyze your repo and generate everything.

## The Problem

Setting up harness engineering for AI coding agents -- as described by [OpenAI's blog on agent-first harness engineering](https://openai.com) and [Ryan Carson's patterns](https://ryancarson.com) -- is complex and manual. A production-ready setup requires:

- Platform-agnostic agent instruction files (CLAUDE.md, KIRO.md, or CODEX.md)
- Risk-tiered CI pipelines with SHA discipline
- Automated code review with verdict classification
- Remediation loops for automated fix-and-retry cycles
- Issue triage, planning, and implementation agents
- Pre-commit hooks and architectural boundary enforcement
- Documentation garbage collection
- Incident-to-harness tracking

Doing this by hand for every repo is slow, error-prone, and inconsistent.

## Why CodeFactory

AI coding agents are powerful, but without guardrails they produce inconsistent code, skip tests, break architectural boundaries, and introduce regressions nobody catches until production. CodeFactory solves this by generating the entire safety infrastructure in minutes instead of weeks.

**What you get:**

- **Autonomous issue-to-PR pipeline.** Open an issue, and CodeFactory's generated workflows triage it, plan the implementation, write the code, open a PR, review it, and fix review feedback -- all without human intervention. You approve the final merge.
- **Risk-aware CI that adapts to what changed.** A typo in a README runs only lint. A change to your core engine triggers lint, type-check, tests, build, architectural validation, and mandatory human approval. No more one-size-fits-all pipelines.
- **AI code review on every PR.** An automated review agent reads your conventions, checks architectural boundaries, and posts structured verdicts. When it finds issues on agent-generated PRs, it dispatches a remediation agent to fix them automatically.
- **Architectural boundary enforcement.** Import rules between your layers are defined in config, validated in CI, and checked by the review agent. Violations fail the build before they reach main.
- **Self-healing documentation.** A weekly gardening workflow scans your docs for stale references, broken links, and outdated commands, then opens a PR with fixes.
- **Everything is version-controlled.** All agent prompts, guard scripts, and configuration live in your repo. Your team can customize agent behavior by editing committed files -- no external dashboards or vendor lock-in.

**The bottom line:** CodeFactory turns any repository into a self-operating development environment where AI agents work within defined safety boundaries. You ship faster because agents handle the routine work, and you ship safer because every change passes through risk-tiered quality gates before it reaches your users.

## Installation

### Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/yasha-dev1/codefactory/main/scripts/install.sh | bash
```

### npm

```bash
npm install -g codefactory
```

### Manual

Download the latest release from [GitHub Releases](https://github.com/yasha-dev1/codefactory/releases),
make it executable, and place it on your PATH:

```bash
chmod +x codefactory
sudo mv codefactory /usr/local/bin/
```

## Updating

```bash
codefactory update
```

Check for updates without installing:

```bash
codefactory update --check
```

Force re-download of the current version:

```bash
codefactory update --force
```

## Quick Start

```bash
cd your-project
codefactory init
```

CodeFactory will:

1. Detect your language, framework, CI provider, and toolchain
2. Ask you a few configuration questions (strictness level, which harnesses to enable)
3. Generate all selected harness files tailored to your stack

## AI Providers

CodeFactory supports multiple AI coding agent platforms:

| Platform         | Status    | CLI Binary | Instruction File |
| ---------------- | --------- | ---------- | ---------------- |
| **Claude Code**  | Supported | `claude`   | `CLAUDE.md`      |
| **AWS Kiro**     | Supported | `kiro-cli` | `KIRO.md`        |
| **OpenAI Codex** | Supported | `codex`    | `CODEX.md`       |

During `codefactory init`, you select your AI platform. All generated artifacts (CI workflows, instruction files, harness checks) are automatically tailored to the selected platform.

## What Gets Generated

CodeFactory produces **16 harnesses**, each targeting a specific aspect of agent-safe development:

| #   | Harness                              | What it generates                                                                                                                |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Risk Contract**                    | `harness.config.json` -- defines risk tiers (Tier 1/2/3), critical paths, architectural boundaries                               |
| 2   | **Agent Instructions**               | Agent instruction file (CLAUDE.md, KIRO.md, or CODEX.md) -- the control plane document read by all AI agents working on the repo |
| 3   | **Documentation Structure**          | `docs/` layout: `architecture.md`, `conventions.md`, `layers.md`                                                                 |
| 4   | **Pre-commit Hooks**                 | `.husky/pre-commit` + `.lintstagedrc.json` -- formats staged files with Prettier before commit                                   |
| 5   | **Risk Policy Gate**                 | `scripts/risk-policy-gate.sh` -- classifies changed files into Tier 1/2/3 and outputs required checks                            |
| 6   | **CI Pipeline**                      | `ci.yml` -- risk-gated CI with conditional jobs based on tier                                                                    |
| 7   | **Review Agent**                     | `code-review-agent.yml` + `review-agent-rerun.yml` + `auto-resolve-threads.yml`                                                  |
| 8   | **Remediation Loop**                 | `remediation-agent.yml` -- auto-fix cycle with guard, validation, and protected-file safety                                      |
| 9   | **Browser Evidence Capture**         | Screenshot and trace capture for UI verification during triage                                                                   |
| 10  | **PR Templates**                     | `.github/PULL_REQUEST_TEMPLATE.md` with risk-tier checklists                                                                     |
| 11  | **Architectural Linters**            | `structural-tests.yml` + `scripts/structural-tests.sh` -- enforces import boundaries                                             |
| 12  | **Documentation Garbage Collection** | `doc-gardening.yml` -- weekly scan for stale docs, auto-creates PR with fixes                                                    |
| 13  | **Incident-to-Harness Loop**         | Converts production incidents into new harness rules                                                                             |
| 14  | **Issue Triage**                     | `issue-triage.yml` -- evaluates new issues for quality, routes actionable ones forward                                           |
| 15  | **Issue Planner**                    | `issue-planner.yml` -- reads the codebase and produces a structured implementation plan                                          |
| 16  | **Issue Implementer**                | `issue-implementer.yml` -- implements issues, opens PRs, handles review-fix cycles                                               |

## GitHub Workflows Reference

CodeFactory generates **14 GitHub Actions workflows**. Here is exactly what each one does:

### 1. `ci.yml` -- Main CI Pipeline

**Triggers:** Pull request (opened/synchronize/reopened), push to `main`, manual dispatch with `pr_number`.

This is the central quality gate. It runs a risk classification first, then conditionally runs downstream jobs based on the tier.

**Jobs:**

| Job                | Runs when   | What it does                                                                                                                                              |
| ------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `risk-gate`        | Always      | Runs `scripts/risk-policy-gate.sh` to classify changed files into Tier 1/2/3. Outputs the list of required checks. On push to `main`, defaults to Tier 2. |
| `lint`             | Tier 1+     | Runs `npm run lint` (ESLint).                                                                                                                             |
| `type-check`       | Tier 2+     | Runs `npm run typecheck` (tsc --noEmit).                                                                                                                  |
| `test`             | Tier 2+     | Runs `vitest` with JUnit reporter. Uploads `test-results.xml` as artifact.                                                                                |
| `build`            | Tier 2+     | Runs `npm run build` (tsup).                                                                                                                              |
| `structural-tests` | Tier 2+     | Runs `scripts/structural-tests.sh` to validate architectural boundaries.                                                                                  |
| `harness-smoke`    | Tier 2+     | Validates `harness.config.json` schema, checks agent instruction file exists, verifies critical files and workflow files are present.                     |
| `manual-approval`  | Tier 3 only | Requires a maintainer to approve the `tier3-approval` environment. 24-hour timeout.                                                                       |

All downstream jobs check out at the exact SHA reported by the risk gate (SHA discipline).

### 2. `risk-policy-gate.yml` -- Standalone Risk Classification

**Triggers:** Pull request (opened/synchronize/reopened), manual dispatch with `pr_number`.

Identical logic to the `risk-gate` job in `ci.yml`, but as a standalone workflow. Runs `scripts/risk-policy-gate.sh` and outputs:

- `sha` -- the verified commit SHA
- `tier` -- risk tier number (1, 2, or 3)
- `tier-name` -- friendly name (low, medium, high)
- `required-checks` -- JSON array of checks required for this tier
- `docs-drift` -- whether documentation may be stale
- `review-agent-status` -- review agent disposition

Also runs its own set of lint/type-check/test/build/harness-smoke/manual-approval jobs, gated by tier.

### 3. `code-review-agent.yml` -- Automated Code Review

**Triggers:** Pull request (opened/synchronize), manual dispatch with `pr_number`.

The core review workflow. Steps:

1. **Resolve PR context** -- gets head SHA, base ref, PR number.
2. **Determine risk tier** -- classifies changed files using the same Tier 1/2/3 logic.
3. **Skip if Tier 1** -- doc-only changes don't need review.
4. **SHA deduplication** -- checks PR comments for `<!-- harness-review: {sha} -->` marker. If the same commit was already reviewed, skips.
5. **Create check run** -- marks `review-agent` as in-progress on the PR.
6. **Read review prompt** -- loads `scripts/review-prompt.md` from `origin/main` (not from the PR branch, so the prompt can't be tampered with).
7. **Build prompt** -- combines the review template with CLAUDE.md, harness.config.json, changed files, and risk tier.
8. **Run Claude review** -- invokes `anthropics/claude-code-action@v1` with tools limited to Read/Glob/Grep/Bash (no write access). Max 100 turns.
9. **Extract review text** -- parses the execution file JSON for the result.
10. **Post review comment** -- creates a PR comment with the review text, SHA marker, and commit reference.
11. **Run verdict classifier** -- sends the review text to Claude Haiku with a JSON schema to classify as APPROVE, REQUEST_CHANGES, or COMMENT.
12. **Update comment with verdict** -- appends the verdict badge to the review comment.
13. **Complete check run** -- marks the check run as success or neutral.
14. **Check review-fix eligibility** -- if verdict is REQUEST_CHANGES, checks whether the PR has the `agent-pr` label, isn't already escalated, and hasn't exceeded 3 review-fix cycles.
15. **Dispatch implementer** -- if eligible, triggers `issue-implementer.yml` in review-fix mode.
16. **Escalate** -- if max cycles (3) exceeded, adds `agent:needs-judgment` label and posts escalation comment.

### 4. `review-agent-rerun.yml` -- Rerun Request Writer

**Triggers:** Pull request synchronize (new commits pushed).

Posts a SHA-deduplicated comment on the PR requesting re-review. Uses marker `<!-- review-agent-auto-rerun -->` with `sha:{commit}` to ensure only one rerun request per commit.

### 5. `auto-resolve-threads.yml` -- Resolve Bot Review Threads

**Triggers:** Check run completed (name: `review-agent`, conclusion: success).

After the review agent succeeds on a new commit:

1. Finds the PR associated with the check run.
2. Fetches all review comments and groups them by thread.
3. For each thread: if all comments are from bots AND the thread is from a prior commit (not the current SHA), minimizes it using GraphQL (`classifier: RESOLVED`).
4. Posts a summary comment counting resolved threads.

Human comments in threads are always preserved.

### 6. `remediation-agent.yml` -- Automated Fix Loop

**Triggers:** Manual dispatch only (called by the code-review-agent when it finds issues).

**Inputs:** `pr_number`, `head_sha`, `findings` (JSON array).

Steps:

1. **SHA discipline check** -- verifies the PR HEAD still matches `head_sha`. Fails if the branch was updated since dispatch.
2. **Checkout PR branch** -- at the verified SHA.
3. **Run remediation guard** -- `scripts/remediation-guard.ts` evaluates whether remediation should proceed (checks attempt count, security blockers, etc.).
4. **If blocked:** posts a rejection comment listing security blockers and skipped findings.
5. **If approved:**
   - Builds a prompt from `scripts/remediation-agent-prompt.md` + CLAUDE.md + harness.config.json + findings.
   - Runs Claude with max 15 turns.
   - Checks for file changes.
   - **Reverts protected files** -- any changes to `.github/workflows/*`, `harness.config.json`, `CLAUDE.md`, or lock files are automatically reverted.
   - **Validates** -- lint, type-check, tests. If any fail, all changes are reverted.
   - **Commits and pushes** if all validations pass.
   - Adds `remediation-attempt-N` label.
   - Posts an audit comment with validation results table.

### 7. `issue-triage.yml` -- Issue Quality Evaluation

**Triggers:** Issue opened, edited, or reopened.

Steps:

1. **Run triage guard** -- `scripts/issue-triage-guard.ts` decides whether to triage (skips bot issues, duplicate triage, etc.). Detects re-triage when an author updates an issue after `needs-more-info`.
2. **Ensure labels exist** -- creates `needs-more-info`, `agent:plan`, `agent:implement`, `triage:failed`, `needs-human-review` if missing.
3. **Remove needs-more-info** -- on re-triage, removes the old label.
4. **Read triage prompt** -- loads `.codefactory/prompts/issue-triage.md`.
5. **Build prompt** -- combines template with issue number, title, author, body, labels, re-triage flag.
6. **Run Claude triage** -- with JSON schema enforcing structured output: `actionable`, `confidence`, `missingInfo`, `summary`, `suggestedLabels`, `estimatedComplexity`.
7. **Browser reproduction** -- if the verdict flags a UI bug and a dev server is available, runs a Puppeteer-based reproduction attempt with screenshots.
8. **Route decision:**
   - **Actionable + confidence >= 0.7** -- adds `agent:plan` label, dispatches planner.
   - **Actionable + low confidence** -- adds `needs-more-info`, asks clarifying questions.
   - **Not actionable** -- adds `needs-more-info`, lists what's missing.
   - **High complexity** -- adds `needs-human-review`.
   - **Parse failure** -- adds `triage:failed`.
9. **Dispatch planner** -- if approved, triggers `issue-planner.yml`.

### 8. `issue-planner.yml` -- Implementation Planning

**Triggers:** Issue labeled with `agent:plan`, manual dispatch with `issue_number`.

Steps:

1. **Run planner guard** -- `scripts/issue-planner-guard.ts` validates the issue should be planned.
2. **Read planner prompt** -- loads `.codefactory/prompts/issue-planner.md`.
3. **Build prompt** -- combines template with issue details, CLAUDE.md, harness.config.json.
4. **Run Claude planning** -- uses Opus with Read/Glob/Grep/Bash tools (read-only). Max 30 turns. Analyzes the codebase and produces a structured implementation plan.
5. **Post plan comment** -- posts the plan on the issue with `<!-- issue-planner: #N -->` marker.
6. **Add `agent:implement` label** -- signals the implementer to proceed.
7. **Dispatch implementer** -- triggers `issue-implementer.yml`.

### 9. `issue-implementer.yml` -- Issue Implementation + Review-Fix

**Triggers:** Issue labeled with `agent:implement`, manual dispatch with `issue_number` or `pr_number` + `review_fix_cycle`.

Two modes:

**Issue mode** (new implementation):

1. **Run implementer guard** -- validates the issue and generates a branch name.
2. **Create branch** -- `{format}-issue-{N}` from `main`.
3. **Run baseline validation** -- captures current lint/type-check/test/build state.
4. **Extract plan** -- finds the planner comment (`<!-- issue-planner: #N -->`) if one exists.
5. **Build prompt** -- combines `.codefactory/prompts/issue-implementer.md` + issue body + plan + CLAUDE.md + harness.config.json + baseline state.
6. **Run Claude implementation** -- Opus with Edit/Write/Read/Glob/Grep/Bash. Max 100 turns.
7. **Revert protected files** -- workflows, harness config, CLAUDE.md, lock files.
8. **Quality gates** -- lint, type-check, test, build. Only fails on regressions (if a check was passing in baseline but now fails).
9. **Commit, push, create PR** -- with `agent-pr` label, `Closes #N` in body, quality gate results table.
10. **Dispatch CI + review agent** -- triggers `ci.yml`, `risk-policy-gate.yml`, and `code-review-agent.yml` for the new PR.

**Review-fix mode** (fix review feedback):

1. **Run review-fix guard** -- validates the PR and cycle count.
2. **Checkout PR branch** -- at current HEAD.
3. **Extract review feedback** -- finds the latest `REQUEST_CHANGES` review comment.
4. **Add cycle label** -- `review-fix-cycle-N`.
5. **Build prompt** -- issue-implementer template in review-fix mode with the feedback.
6. **Run Claude fix** -- Opus with full tool access. Max 100 turns.
7. **Revert protected files** -- same safety.
8. **Quality gates** -- lint, type-check, test, build. If any fail, posts failure comment, adds `agent:needs-judgment`.
9. **Commit, push** -- if all gates pass.
10. **Dispatch CI + review agent** -- re-runs full pipeline for re-review.

### 10. `doc-gardening.yml` -- Weekly Documentation Maintenance

**Triggers:** Scheduled (every Monday at 9am UTC), manual dispatch.

1. Runs Claude with `scripts/doc-gardening-prompt.md` as the prompt. Max 10 turns.
2. **Safety net** -- reverts any non-documentation files (only `.md`/`.mdx`/`.rst` changes are kept).
3. If documentation changes remain, creates or updates a PR on branch `docs/weekly-gardening` with the `documentation` and `automated` labels.

Catches: stale references to renamed/deleted files, broken internal links, outdated package.json script references, deprecated API mentions.

### 11. `weekly-metrics.yml` -- Harness Gap Tracking

**Triggers:** Scheduled (every Friday at 10am UTC), manual dispatch.

Collects metrics on issues labeled `harness-gap`:

- **MTTH** (Mean Time To Harness) -- average days from open to close.
- **Open gap counts** by priority (P0/P1/P2/P3).
- **Monthly close rate** -- % of gaps closed in the last 30 days.
- **SLO compliance** -- flags overdue gaps (P0: 1d, P1: 7d, P2: 14d, P3: 90d).

Outputs a summary table to the GitHub Actions step summary.

### 12. `structural-tests.yml` -- Architectural Boundary Validation

**Triggers:** Manual dispatch, called by CI.

Three checks:

1. **Architectural boundaries** -- runs `scripts/structural-tests.sh`.
2. **Import-type discipline** -- flags imports from `*types*` modules that don't use `import type`.
3. **No circular imports** -- verifies: `utils/` imports nothing, `core/` only imports from `utils/`, `ui/` only imports from `utils/`.

### 13. `harness-smoke.yml` -- Harness Configuration Validation

**Triggers:** Manual dispatch, called by CI.

Validates:

- `harness.config.json` schema (version, riskTiers with tier1/2/3, commands, shaDiscipline, architecturalBoundaries).
- Agent instruction file (CLAUDE.md, KIRO.md, or CODEX.md) is present and non-empty.
- Critical project files exist (src/index.ts, src/cli.ts, package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, eslint.config.js).
- CI workflow files exist.
- PR template exists.
- Risk policy gate script exists.
- Structural tests script exists.

### 14. `claude.yml` -- Manual @claude Invocation

**Triggers:** Issue comment, PR review comment, issue opened/assigned, PR review submitted -- all containing `@claude`.

Runs `anthropics/claude-code-action@v1` with the comment as the prompt. Allows team members to invoke Claude ad-hoc on any issue or PR by mentioning `@claude`.

## End-to-End Workflow

Here is the complete lifecycle of how code moves through a CodeFactory-harnessed repository:

### Starting from scratch

```
codefactory init
    │
    ├── 1. Detect stack (language, framework, CI provider, toolchain)
    ├── 2. Prompt for preferences (strictness level, harness selection)
    └── 3. Generate all artifacts:
            ├── harness.config.json          (risk tiers, boundaries)
            ├── CLAUDE.md                    (agent instructions)
            ├── docs/                        (architecture docs)
            ├── .husky/pre-commit            (pre-commit hooks)
            ├── scripts/                     (risk gate, structural tests, guards)
            ├── .codefactory/prompts/        (agent prompt templates)
            ├── .github/workflows/           (14 workflow files)
            └── .github/PULL_REQUEST_TEMPLATE.md
```

### Issue lifecycle (fully automated)

```
Issue opened
    │
    ▼
issue-triage.yml
    │ Evaluates quality, confidence, complexity
    │
    ├── Not actionable ──► "needs-more-info" label + clarifying questions
    │                       Author edits issue ──► re-triage
    │
    ├── High complexity ──► "needs-human-review" label
    │
    └── Actionable (confidence >= 0.7) ──► "agent:plan" label
            │
            ▼
      issue-planner.yml
            │ Reads codebase, produces structured plan
            │ Posts plan comment on issue
            │ Adds "agent:implement" label
            │
            ▼
      issue-implementer.yml (issue mode)
            │ Creates branch, implements changes
            │ Runs quality gates (lint/typecheck/test/build)
            │ Reverts any protected file changes
            │ Opens PR with "agent-pr" label
            │
            ▼
      ┌─────────────────────────────────────┐
      │         PR PIPELINE                  │
      │                                      │
      │  ci.yml ── risk gate + quality jobs  │
      │  code-review-agent.yml ── review     │
      │                                      │
      │  Verdict:                            │
      │  ├── APPROVE ──► ready to merge      │
      │  ├── COMMENT ──► informational       │
      │  └── REQUEST_CHANGES ──►             │
      │       issue-implementer.yml          │
      │       (review-fix mode, up to 3x)    │
      │       ├── Fix ──► push ──► re-review │
      │       └── 3 cycles ──► escalate      │
      │           "agent:needs-judgment"      │
      └─────────────────────────────────────┘
```

### PR lifecycle (human or agent)

```
Push / PR opened
    │
    ├──► ci.yml
    │     ├── risk-gate ── classify Tier 1/2/3
    │     ├── lint, type-check, test, build (conditional on tier)
    │     ├── structural-tests, harness-smoke (conditional on tier)
    │     └── manual-approval (Tier 3 only)
    │
    ├──► code-review-agent.yml
    │     ├── Skip if Tier 1 or already reviewed (SHA dedup)
    │     ├── Claude reviews with Read-only tools
    │     ├── Posts review comment + verdict
    │     └── If REQUEST_CHANGES on agent-pr: dispatch review-fix
    │
    └──► review-agent-rerun.yml
          └── Posts SHA-deduped rerun request comment
```

### Scheduled / background

```
Monday 9am UTC ──► doc-gardening.yml
                    └── Scans docs for staleness, creates PR if needed

Friday 10am UTC ──► weekly-metrics.yml
                     └── Reports MTTH, SLO compliance, overdue gaps
```

## Risk Tiers

| Tier | Name   | File patterns                           | Required checks                                                            |
| ---- | ------ | --------------------------------------- | -------------------------------------------------------------------------- |
| 1    | Low    | `docs/**`, `*.md`                       | `lint`                                                                     |
| 2    | Medium | `src/**`, `tests/**`                    | `lint`, `type-check`, `test`, `build`, `structural-tests`, `harness-smoke` |
| 3    | High   | Entry points, core engine, build config | All of Tier 2 + `manual-approval`                                          |

Tier 3 critical paths include: `src/index.ts`, `src/cli.ts`, `src/commands/init.ts`, `src/core/*.ts`, `src/harnesses/index.ts`, `src/harnesses/types.ts`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`.

## Control Plane

All agent behavior is configured through files committed to the repo:

```
.codefactory/prompts/           Agent prompt templates (edit to change behavior)
    ├── agent-system.md         Base system prompt for all agents
    ├── issue-triage.md         Triage evaluation criteria
    ├── issue-planner.md        Planning instructions
    ├── issue-implementer.md    Implementation instructions
    └── review-agent.md         Code review guidelines

scripts/
    ├── review-prompt.md        Review agent prompt (read from main branch)
    ├── remediation-agent-prompt.md    Remediation agent prompt
    ├── doc-gardening-prompt.md        Doc gardening instructions
    ├── risk-policy-gate.sh     Risk classification script
    ├── structural-tests.sh     Architectural boundary checks
    ├── issue-triage-guard.ts   Triage guard logic
    ├── issue-planner-guard.ts  Planner guard logic
    ├── issue-implementer-guard.ts     Implementer guard logic
    └── remediation-guard.ts    Remediation guard logic

harness.config.json             Risk tiers, architectural boundaries, critical paths
CLAUDE.md / KIRO.md / CODEX.md  Project conventions for all agents (platform-specific)
```

Changes to these files take effect on the next CI run. Because they are committed to the repo, agent behavior is versioned and shared with the whole team.

## Architecture

```
CLI (Commander)
  ├── Default ──► REPL (interactive input with / commands)
  │                ├── Task input ──► Worktree + Claude agent
  │                └── /prompts ──► View/edit .codefactory/prompts/
  └── init ──► Harness setup wizard
                 ├── Detector (heuristic + Claude-powered analysis)
                 └── Harness Modules (16 modules, each implementing HarnessModule)
                      └── AI Runner (Agent SDK) ──► Generated Files
```

**Core modules:**

- `src/core/ai-runner.ts` -- Defines the `AIRunner` interface and shared types. Three runner implementations (`claude-runner.ts`, `kiro-runner.ts`, `codex-runner.ts`) each provide `analyze()` for structured JSON extraction and `generate()` for file creation, tailored to their platform's CLI.
- `src/core/detector.ts` -- Two-phase stack detection: fast heuristics (file existence checks, package.json parsing) followed by Claude-powered deep analysis.
- `src/core/config.ts` -- Loads and saves `harness.config.json`.
- `src/core/file-writer.ts` -- Tracks created and modified files during harness generation.
- `src/core/prompt-store.ts` -- Manages `.codefactory/prompts/` with default agent prompts and CRUD operations.
- `src/commands/init.ts` -- Orchestrates the init flow: detect, prompt, generate.
- `src/commands/repl.ts` -- Interactive REPL with search-based input, prompt management, and task spawning.

**Harness modules** (`src/harnesses/`): 16 modules each exporting a `HarnessModule` with `name`, `order`, `isApplicable()`, and `execute()`. They run in dependency order and can reference outputs from earlier harnesses via `previousOutputs`.

**Prompts** (`src/prompts/`): 20 prompt builders that each harness module sends to the Claude Runner for file generation. Agent-facing prompts (read at CI time) live in `.codefactory/prompts/`.

## Development

```bash
git clone https://github.com/yasha-dev1/codefactory.git
cd codefactory
npm install
npm run build
npm test
npm run dev    # watch mode
npm run lint
npm run typecheck
```

## Requirements

- **Node.js** >= 20
- **AI coding agent CLI** installed and authenticated: Claude Code (`claude`), AWS Kiro (`kiro-cli`), or OpenAI Codex (`codex`)

## License

MIT
