# Layer Boundaries

This document defines the architectural layer structure of CodeFactory. These boundaries are enforced by the `architecturalBoundaries` section of `harness.config.json` and checked by the architectural-linters harness in CI.

## Layer Definitions

### utils

- **Purpose**: Pure utility functions with zero knowledge of the application domain.
- **Contains**: File system helpers (`fileExists`, `readFileIfExists`, `getDirectoryTree`), Git CLI wrappers (`isGitRepo`, `getRepoRoot`, `getRemoteUrl`), custom Error subclasses (`UserCancelledError`, `PlatformCLINotFoundError`, `NotAGitRepoError`).
- **Allowed dependencies**: none — this is the leaf layer.
- **Forbidden dependencies**: All other layers. Utils must never import from `ui`, `core`, `commands`, `prompts`, `providers`, or `harnesses`.
- **Public API**: All exports from `errors.ts`, `fs.ts`, and `git.ts`.

### ui

- **Purpose**: Terminal output and interactive user input. Wraps third-party libraries (Chalk, Ora, Inquirer) behind simple function interfaces.
- **Contains**: `logger.ts` (colored console methods: `info`, `success`, `warn`, `error`, `debug`, `header`, `dim`, `fileCreated`, `fileModified`), `spinner.ts` (`createSpinner`, `withSpinner<T>`), `prompts.ts` (`confirmPrompt`, `selectPrompt`, `multiselectPrompt`, `inputPrompt`).
- **Allowed dependencies**: `utils`
- **Forbidden dependencies**: `core`, `commands`, `prompts`, `providers`, `harnesses`. The UI layer must not contain business logic or reference domain types like `DetectionResult` or `HarnessModule`.
- **Public API**: The `logger` object, `withSpinner()`, and the four prompt functions.

### core

- **Purpose**: The engine — stack detection, AI runner abstraction, configuration persistence, and file operation tracking.
- **Contains**: `ai-runner.ts` (`AIRunner` interface, `AIPlatform` type, `INSTRUCTION_FILES` constant, `extractJson()`), `claude-runner.ts` (spawns `claude` CLI, parses stream-JSON, tracks Write/Edit operations), `git-diff-runner.ts` (abstract base for Kiro/Codex runners using git-diff file tracking), `kiro-runner.ts` (AWS Kiro runner), `codex-runner.ts` (OpenAI Codex runner), `runner-factory.ts` (`createRunner()` factory, `validatePlatformCLI()`), `detector.ts` (two-phase detection: `runHeuristicDetection` and `runFullDetection`), `config.ts` (`loadHarnessConfig`, `saveHarnessConfig`, `HarnessConfig` type), `file-writer.ts` (`FileWriter` class that tracks created vs modified files).
- **Allowed dependencies**: `utils`
- **Forbidden dependencies**: `ui`, `commands`, `prompts`, `providers`, `harnesses`. Core must never import UI components or harness-specific logic. This prevents circular dependencies and keeps the engine testable without terminal I/O.
- **Public API**: `AIRunner`, `AIPlatform`, `createRunner`, `validatePlatformCLI`, `ClaudeRunner`, `GitDiffRunner`, `KiroRunner`, `CodexRunner`, `FileWriter`, `DetectionResult`, `HeuristicResult`, `HarnessConfig`, `INSTRUCTION_FILES`, detection functions, config functions.

### prompts

- **Purpose**: Prompt templates that instruct Claude on what to generate for each harness. Each prompt builder takes detection results and user preferences and returns a string.
- **Contains**: `system.ts` (shared system prompt defining Claude's role, risk-tier model, SHA discipline, and output constraints), `detect-stack.ts` (stack analysis prompt), and one prompt builder per harness module (`risk-contract.ts`, `claude-md.ts`, `ci-pipeline.ts`, etc.).
- **Allowed dependencies**: `core`, `utils`
- **Forbidden dependencies**: `ui`, `commands`, `providers`, `harnesses`. Prompts must not trigger side effects (no file writes, no terminal output, no provider-specific logic).
- **Public API**: `buildSystemPrompt()` and one `build*Prompt()` function per harness.

### providers

- **Purpose**: CI provider adapters that translate abstract `WorkflowConfig` objects into provider-specific configuration files (YAML for GitHub Actions, etc.).
- **Contains**: `types.ts` (interfaces: `CIProvider`, `WorkflowConfig`, `WorkflowTrigger`, `WorkflowJob`, `WorkflowStep`, `MatrixConfig`), `github-actions.ts` (`GitHubActionsProvider` class with `generateWorkflow()`, `generateMatrix()`, and helper step builders).
- **Allowed dependencies**: `core`, `utils`
- **Forbidden dependencies**: `ui`, `commands`, `prompts`, `harnesses`. Providers are pure data transformers — they must not interact with the terminal or reference harness-specific logic.
- **Public API**: `CIProvider` interface, `GitHubActionsProvider` class, `githubActionsProvider` singleton, all workflow/step type definitions.

### commands

- **Purpose**: CLI command handlers that orchestrate the full user-facing flow. This is the "glue" layer that connects detection, user interaction, harness execution, and output.
- **Contains**: `init.ts` — the 10-step init flow: pre-flight checks, heuristic detection, deep detection, user prompts, harness selection, critical path configuration, harness execution loop, npm script injection, config persistence, git commit, and summary.
- **Allowed dependencies**: `core`, `ui`, `utils`
- **Forbidden dependencies**: `prompts`, `providers`, `harnesses` (directly). Commands interact with harnesses only through the registry API (`getHarnessModules()`) and the `HarnessModule` interface. They must not import individual harness files or prompt builders.
- **Public API**: `initCommand(options: InitOptions)`.

### harnesses

- **Purpose**: The 16 harness modules, each responsible for generating a specific set of artifacts (CI workflows, review-agent config, pre-commit hooks, etc.).
- **Contains**: `types.ts` (contracts: `HarnessModule`, `HarnessContext`, `HarnessOutput`, `UserPreferences`), `index.ts` (registry: `getHarnessModules()`, `getHarnessById()`), and one implementation file per harness (e.g., `risk-contract.ts`, `ci-pipeline.ts`, `review-agent.ts`).
- **Allowed dependencies**: `core`, `prompts`, `providers`, `utils`
- **Forbidden dependencies**: `ui`, `commands`. Harness modules must not produce terminal output directly — they return `HarnessOutput` objects and let the orchestrator (`commands/init.ts`) handle logging.
- **Public API**: Each harness exports a `const *Harness: HarnessModule`. The barrel `index.ts` re-exports the registry functions and all types.

## Dependency Matrix

| From \ To     | commands | core | harnesses | prompts | providers | ui  | utils |
| ------------- | -------- | ---- | --------- | ------- | --------- | --- | ----- |
| **commands**  | -        | Y    | N         | N       | N         | Y   | Y     |
| **core**      | N        | -    | N         | N       | N         | N   | Y     |
| **harnesses** | N        | Y    | -         | Y       | Y         | N   | Y     |
| **prompts**   | N        | Y    | N         | -       | N         | N   | Y     |
| **providers** | N        | Y    | N         | N       | -         | N   | Y     |
| **ui**        | N        | N    | N         | N       | N         | -   | Y     |
| **utils**     | N        | N    | N         | N       | N         | N   | -     |

**Y** = allowed import. **N** = forbidden.

Note: `commands` does not directly import `harnesses` files. It imports only from `harnesses/index.ts` (the registry) and `harnesses/types.ts` (the interfaces), which are considered part of the harnesses layer's public API. This is the one permitted cross-layer access point.

## Enforcement

### CI Gate

The `architectural-linters` harness generates a custom lint script that statically analyzes import statements against the `architecturalBoundaries` definition in `harness.config.json`. This runs as part of the `structural-tests` CI job.

A boundary violation fails the build:

```
ERROR: src/core/detector.ts imports from "ui" layer (forbidden).
       core → ui is not in allowedImports: ["utils"]
```

### Local Development

Run `npm run lint` before pushing. The ESLint configuration combined with the architectural linter script catches boundary violations locally.

### Exemptions

If a boundary violation is intentionally necessary (rare), annotate the import with a comment explaining why:

```typescript
// arch-exempt: logger needed for debug output during detection phase
import { logger } from '../ui/logger.js';
```

Exemptions must be approved by a human reviewer (not just review-agent) and documented in the PR description.

## Common Violations and Fixes

### 1. Core importing from UI

**Violation**: Adding `logger.debug()` calls inside `core/detector.ts` or `core/claude-runner.ts`.

**Why it's wrong**: Core must remain free of terminal I/O so it can be tested without mocking console output.

**Fix**: Return diagnostic data in the result object. Let `commands/init.ts` handle logging:

```typescript
// wrong — core/detector.ts
import { logger } from '../ui/logger.js';
logger.debug(`Detected ${languages.length} languages`);

// correct — core/detector.ts returns data, commands/init.ts logs it
const heuristics = await runHeuristicDetection(repoRoot);
logger.debug(`Detected ${heuristics.languages.length} languages`);
```

### 2. Harness importing from UI

**Violation**: A harness module calling `logger.success()` after generating files.

**Why it's wrong**: Harnesses return `HarnessOutput`; the orchestrator handles output display.

**Fix**: Remove the UI import. Use `metadata` in `HarnessOutput` to pass extra info to the orchestrator:

```typescript
// wrong — harnesses/ci-pipeline.ts
import { logger } from '../ui/logger.js';
logger.success('CI pipeline generated');

// correct — return output, let init.ts log it
return {
  harnessName: 'ci-pipeline',
  filesCreated: result.filesCreated,
  filesModified: result.filesModified,
  metadata: { workflowCount: 3 },
};
```

### 3. Prompts importing from providers

**Violation**: A prompt builder importing `GitHubActionsProvider` to generate inline YAML.

**Why it's wrong**: Prompts produce strings (instructions for Claude), not CI artifacts. Provider logic belongs in `providers/` or the harness module itself.

**Fix**: Keep prompt builders pure — they should reference the CI provider by name string, not by importing provider classes:

```typescript
// wrong — prompts/ci-pipeline.ts
import { GitHubActionsProvider } from '../providers/github-actions.js';

// correct — use the provider name from detection
const ciProvider = detection.ciProvider; // "GitHub Actions"
```

### 4. Utils importing from any other layer

**Violation**: Adding a utility function that needs `DetectionResult` from core.

**Why it's wrong**: Utils is the leaf layer. If it imports from core, every layer transitively depends on core, creating a tight coupling.

**Fix**: Move the function to the layer that owns the type. If the function is truly general-purpose, parameterize it to accept primitive types instead of domain objects.
