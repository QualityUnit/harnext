# Coding Conventions

This document is the authoritative reference for CodeFactory's coding standards. Both human developers and AI coding agents must follow these rules. Violations will be caught by linters, type-checking, and review-agent CI gates.

## Naming Conventions

### Files

All source files use **kebab-case** with `.ts` extension:

```
claude-runner.ts    risk-policy-gate.ts    file-writer.ts
```

Test files mirror source names with a `.test.ts` suffix, located in `tests/`:

```
tests/unit/detector.test.ts
tests/unit/harnesses/risk-contract.test.ts
tests/integration/init-flow.test.ts
```

### Variables and Functions

**camelCase** for all variables and functions:

```typescript
const repoRoot = await getRepoRoot();
const harnessChoices = allHarnesses.map((h) => ({ ... }));
```

### Types, Interfaces, and Classes

**PascalCase** with no prefix (no `I` on interfaces, no `T` on types):

```typescript
export interface HarnessModule { ... }
export interface DetectionResult { ... }
export interface AIRunner { ... }
export class ClaudeRunner { ... }
export class GitDiffRunner { ... }
export class FileWriter { ... }
export class PlatformCLINotFoundError extends Error { ... }
export class NotAGitRepoError extends Error { ... }
```

### Constants

Module-level constants use **UPPER_SNAKE_CASE** for plain data, **camelCase** for functional values:

```typescript
const CONFIG_FILENAME = 'harness.config.json';
const HARNESS_SCRIPTS: Record<string, Record<string, string>> = { ... };
```

Exported singleton instances use **camelCase**:

```typescript
export const githubActionsProvider = new GitHubActionsProvider();
export const logger = { info() { ... }, ... };
```

## Import / Module Organization

### Import Order

Imports are grouped in this order, separated by blank lines:

1. **Node built-ins** — prefixed with `node:`
2. **External packages**
3. **Local imports** — relative paths

```typescript
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';

import { z } from 'zod';
import chalk from 'chalk';

import { logger } from '../ui/logger.js';
import { fileExists } from '../utils/fs.js';
import type { DetectionResult } from '../core/detector.js';
```

### Type Imports

Use `import type` for type-only imports. The `verbatimModuleSyntax` flag in `tsconfig.json` enforces this at compile time:

```typescript
import type { HarnessModule } from './types.js';
import type { ClaudeRunner } from '../core/claude-runner.js';
```

### ESM Extensions

This is a pure ESM package (`"type": "module"`). All local imports **must** include `.js` extensions:

```typescript
import { fileExists } from '../utils/fs.js'; // correct
import { fileExists } from '../utils/fs'; // wrong — will fail at runtime
```

### Barrel Exports

Each layer uses an `index.ts` barrel file for re-exports. The harness registry re-exports types from `types.ts`:

```typescript
// src/harnesses/index.ts
export {
  type HarnessModule,
  type HarnessContext,
  type HarnessOutput,
  type UserPreferences,
} from './types.js';
```

### Module Boundaries

Imports must respect the architectural boundary rules defined in `harness.config.json` → `architecturalBoundaries`. See `docs/layers.md` for the full dependency matrix.

## Exports

**Named exports only.** No default exports in source files:

```typescript
export class ClaudeRunner { ... }           // correct
export function getHarnessModules() { ... } // correct
export default class ClaudeRunner { ... }   // forbidden
```

## Error Handling

### Custom Error Classes

Throw domain-specific errors defined in `src/utils/errors.ts`:

```typescript
export class UserCancelledError extends Error { ... }
export class PlatformCLINotFoundError extends Error { ... }
export class NotAGitRepoError extends Error { ... }
```

### Error Propagation

- **Fatal errors**: Throw custom `Error` subclasses. Let the top-level CLI handler catch and display them.
- **Non-fatal errors**: Use try/catch with fallback to `null` or a warning log. Do not crash the process.

```typescript
// Fatal — stops execution
if (!(await isGitRepo())) {
  throw new NotAGitRepoError();
}

// Non-fatal — log and continue
try {
  const output = await harness.execute(ctx);
  previousOutputs.set(harness.name, output);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  logger.warn(`Harness "${harness.displayName}" failed: ${msg}`);
}
```

The `error instanceof Error ? error.message : String(error)` pattern is used consistently throughout the codebase for safe error message extraction.

## Formatting

Enforced by Prettier (`.prettierrc`):

| Rule            | Value      |
| --------------- | ---------- |
| Semicolons      | yes        |
| Quotes          | single     |
| Trailing commas | all        |
| Print width     | 100        |
| Tab width       | 2 (spaces) |

## TypeScript

- **Strict mode**: All strict flags enabled via `"strict": true` in `tsconfig.json`.
- **Target**: ES2022 with ESNext modules and bundler module resolution.
- **`verbatimModuleSyntax`**: Enforces explicit `import type` for type-only imports.
- **`isolatedModules`**: Each file must be independently transpilable.

## Testing Conventions

- **Runner**: Vitest with `globals: true` (no need to import `describe`, `it`, `expect`).
- **Location**: `tests/unit/` for unit tests, `tests/integration/` for end-to-end flows.
- **Naming**: `*.test.ts` suffix matching source file names.
- **Coverage**: V8 provider, covering `src/**/*.ts`.

What to test:

- Public API of every module (exported functions, class methods)
- Edge cases in detection logic (missing files, parse failures)
- Error paths (verify correct error class is thrown)

What is optional:

- Internal helper functions not exported from barrel files
- Prompt template string content (tested indirectly via harness integration tests)

## Git Workflow

### Branch Naming

`<type>/<short-description>` where type is one of:

```
feat/    fix/    chore/    docs/    refactor/    test/
```

Examples: `feat/add-gitlab-provider`, `fix/detection-null-check`, `chore/update-deps`.

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat: add GitLab CI provider adapter
fix: handle missing package.json in detection
chore: update vitest to 3.1
docs: add architecture decision record for CLI design
refactor: extract stream parser from ClaudeRunner
test: add integration test for dry-run mode
```

### PR Size

Keep PRs focused on a single concern. Prefer multiple small PRs over one large PR. Every PR must be classified by risk tier in the description.

## Code Review Standards

### Risk Tiers (from `harness.config.json`)

| Tier                | Scope                                                     | Required Checks                                     |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **Tier 1** (low)    | Docs, comments, config                                    | lint                                                |
| **Tier 2** (medium) | UI, utils, prompts, providers, tests                      | lint, type-check, test, review-agent                |
| **Tier 3** (high)   | Entry points, core engine, harness contracts, build infra | lint, type-check, test, review-agent, manual-review |

### Automated Review Agent

The review agent checks:

- Architectural boundary violations (imports from forbidden layers)
- Missing type annotations on public APIs
- Unsafe error handling (bare `catch` without logging)
- SHA discipline in CI workflow files

### Human Reviewer Focus

Human reviewers should focus on:

- Correctness of business logic and orchestration flow
- Prompt engineering quality (clarity, completeness, no hallucinated values)
- Security implications (unsanitized input to shell commands, secret exposure)
- Backward compatibility of `HarnessModule` and `CIProvider` interfaces

### Approval Policy

- **Tier 1**: 0 approvals, self-merge allowed
- **Tier 2**: 1 approval, review-agent required, no self-merge
- **Tier 3**: 1 approval, review-agent + manual human review required, no self-merge
