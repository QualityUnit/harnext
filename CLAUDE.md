# CLAUDE.md

## Project Overview

CodeFactory is a CLI tool that automates harness engineering setup for AI coding agents. Written in TypeScript (ESM), it uses the Claude Code Agent SDK to analyze repositories and generate production-grade CI, review, and safety artifacts. No framework; runs on Node.js >= 20.

## Build & Run Commands

```bash
npm install              # Install dependencies
npm run build            # Build with tsup → dist/
npm run dev              # Build in watch mode
npm test                 # Run all tests (vitest run)
npx vitest run src/foo   # Run a single test file by path match
npm run lint             # Lint with eslint (eslint src/)
npm run typecheck        # Type-check (tsc --noEmit)
```

## Code Style Rules

- **Formatter**: Prettier — single quotes, semicolons, trailing commas, 100-char line width, 2-space indent.
- **Import order**: Node built-ins (`node:fs`, `node:path`) → external packages (`commander`, `zod`, `chalk`) → local imports (`../core/`, `../utils/`). Keep `import type` separate from value imports.
- **Type imports**: Use `import type { Foo }` for type-only imports. `verbatimModuleSyntax` is enabled in tsconfig — the compiler enforces this.
- **File naming**: `kebab-case.ts` for all source files (e.g., `claude-runner.ts`, `risk-policy-gate.ts`).
- **Naming conventions**: `camelCase` for variables/functions, `PascalCase` for interfaces/classes/types. No prefixes (no `I` on interfaces).
- **Exports**: Named exports only. No default exports in source files. Re-export types from barrel files (`index.ts`).
- **Error handling**: Throw custom `Error` subclasses (see `src/utils/errors.ts`). Use `try/catch` with fallback to `null` or warning logs for non-fatal failures. Pattern: `error instanceof Error ? error.message : String(error)`.
- **ESM**: This is a pure ESM package (`"type": "module"`). All local imports must include `.js` extensions (e.g., `import { foo } from './bar.js'`).

## Architecture Overview

```
src/
  commands/    CLI command handlers (init flow orchestration)
  core/        Engine: ClaudeRunner (Agent SDK wrapper), detector, config, file-writer
  harnesses/   13 harness modules, each implementing HarnessModule interface
  prompts/     Prompt templates sent to Claude for each harness generation step
  providers/   CI provider adapters (GitHub Actions, GitLab CI, Bitbucket)
  ui/          Terminal output: logger, spinner, interactive prompts (Inquirer)
  utils/       Pure utilities: filesystem helpers, git ops, error classes, templates
```

**Dependency rule** (enforced in `harness.config.json` → `architecturalBoundaries`):

- `utils` imports nothing. `ui` imports only `utils`. `core` imports only `utils`.
- `commands` imports `core`, `ui`, `utils`. `prompts` imports `core`, `utils`.
- `providers` imports `core`, `utils`. `harnesses` imports `core`, `prompts`, `providers`, `utils`.
- Never create circular imports. Never import from `commands` or `harnesses` inside `core`.

## Critical Paths — Extra Care Required

Changes to these files require additional test coverage and human review (not just review-agent):

- `src/index.ts`, `src/cli.ts` — entry points
- `src/commands/init.ts` — main orchestration flow
- `src/core/claude-runner.ts` — Agent SDK integration
- `src/core/config.ts`, `src/core/detector.ts`, `src/core/file-writer.ts` — core engine
- `src/harnesses/index.ts`, `src/harnesses/types.ts` — harness registry and contracts
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js` — build/CI infra

These are classified as **Tier 3 (high risk)** in `harness.config.json`. All Tier 3 changes require: lint + type-check + full test suite + review-agent + manual human review.

## Security Constraints

- Never commit secrets, API keys, or `.env` files.
- Never disable ESLint rules, TypeScript strict mode, or type checking.
- Validate all external input at system boundaries (use Zod schemas as in `detector.ts`).
- The CLI spawns `claude` as a child process — never pass unsanitized user input to shell commands.
- Follow least-privilege: `ClaudeRunner` explicitly whitelists allowed tools per operation.

## Dependency Management

- Add dependencies: `npm add <pkg>` (runtime) or `npm add -D <pkg>` (dev).
- Always commit `package-lock.json`.
- Do not upgrade major versions without explicit instruction.
- Pin exact versions for production dependencies when possible.

## Harness System Reference

This project uses harness engineering with layered CI gates:

- **Risk tiers** defined in `harness.config.json` — Tier 1 (docs), Tier 2 (features), Tier 3 (critical paths).
- **SHA discipline** enforced — all CI gates and review passes pin to exact commit SHA.
- **Review agent** automatically reviews PRs; Tier 3 changes also require manual approval.
- **Pre-commit hooks** enforce local quality checks before push.
- See `README.md` for harness module descriptions and architectural patterns.

## PR Conventions

- **Branch naming**: `<type>/<short-description>` (e.g., `feat/add-auth`, `fix/null-check`, `chore/update-deps`).
- **Commit messages**: Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- All PRs must pass lint, type-check, and test CI gates before merge.
- Classify every PR by risk tier (Tier 1/2/3) in the PR description.
