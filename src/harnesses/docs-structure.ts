import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import type { DetectionResult } from '../core/detector.js';
import { buildDocsStructurePrompt } from '../prompts/docs-structure.js';
import { buildSystemPrompt } from '../prompts/system.js';

function buildArchitectureMd(detection: DetectionResult): string {
  const lang = detection.primaryLanguage;
  const framework = detection.framework ? ` with ${detection.framework}` : '';
  const layers = detection.architecturalLayers;

  const projectTree =
    layers.length > 0
      ? layers.map((l) => `│   ├── ${l}/`).join('\n')
      : '│   └── (no layers detected)';

  const layerDescriptions =
    layers.length > 0
      ? layers
          .map((layer) => {
            return `### ${layer}\n- **Allowed imports**: ${layer === 'utils' ? 'none (leaf layer)' : 'utils'}\n`;
          })
          .join('\n')
      : '';

  const depMatrix = layers.length > 0 ? buildDependencyMatrix(layers) : '';

  return `# Architecture

This project is written in ${lang}${framework}.

## Project Structure

\`\`\`
src/
${projectTree}
\`\`\`

## Architectural Pattern

This project follows a layered modular architecture with strict unidirectional dependency flow.

Key design principles:
- **Interface-driven contracts**: Public APIs define the contracts between layers.
- **Dependency inversion**: Modules receive context objects rather than constructing their own dependencies.
- **Fail-soft execution**: Non-critical failures log warnings and do not abort the process.

## Layer Structure

${layerDescriptions}
${depMatrix ? `## Dependency Matrix\n\n${depMatrix}` : ''}
## Architecture Decision Records

### Template for Future ADRs

\`\`\`markdown
### ADR-NNN: [Title]

**Status**: Proposed | Accepted | Deprecated | Superseded by ADR-XXX

**Context**: What is the issue that we're seeing that is motivating this decision?

**Decision**: What is the change that we're proposing and/or doing?

**Rationale**: Why is this the best choice given the constraints?

**Consequences**: What trade-offs does this decision introduce?
\`\`\`
`;
}

function buildDependencyMatrix(layers: string[]): string {
  const header = ['From \\ To', ...layers].join(' | ');
  const separator = ['---', ...layers.map(() => '---')].join(' | ');

  const rows = layers.map((from) => {
    const cells = layers.map((to) => {
      if (from === to) return '-';
      if (from === 'utils') return 'N';
      if (to === 'utils') return 'Y';
      return 'N';
    });
    return [`**${from}**`, ...cells].join(' | ');
  });

  return `| ${header} |\n| ${separator} |\n${rows.map((r) => `| ${r} |`).join('\n')}\n\n**Y** = allowed import. **N** = forbidden.\n`;
}

function buildConventionsMd(detection: DetectionResult): string {
  const lang = detection.primaryLanguage;
  const ext =
    lang === 'TypeScript'
      ? '.ts'
      : lang === 'Python'
        ? '.py'
        : lang === 'Go'
          ? '.go'
          : lang === 'Rust'
            ? '.rs'
            : '.js';

  const formatterSection = detection.formatter
    ? `## Formatting\n\nEnforced by ${detection.formatter}.\n`
    : '';

  const linterSection = detection.linter
    ? `## Linting\n\nEnforced by ${detection.linter}. Run \`${detection.lintCommand ?? `${detection.linter} .`}\` before pushing.\n`
    : '';

  const typeCheckSection = detection.typeChecker
    ? `## Type Checking\n\n- **Checker**: ${detection.typeChecker}\n- All strict flags enabled.\n`
    : '';

  const testSection = detection.testFramework
    ? `## Testing Conventions\n\n- **Runner**: ${detection.testFramework}\n- **Command**: \`${detection.testCommand ?? detection.testFramework}\`\n- Test files should mirror source names with a test suffix.\n`
    : '';

  return `# Coding Conventions

This document is the authoritative reference for coding standards. Both human developers and AI coding agents must follow these rules.

## Naming Conventions

### Files

All source files use **kebab-case** with \`${ext}\` extension.

### Variables and Functions

**camelCase** for all variables and functions.

### Types, Interfaces, and Classes

**PascalCase** with no prefix (no \`I\` on interfaces, no \`T\` on types).

## Exports

**Named exports only.** No default exports in source files.

## Error Handling

### Error Propagation

- **Fatal errors**: Throw custom \`Error\` subclasses. Let the top-level handler catch and display them.
- **Non-fatal errors**: Use try/catch with fallback to \`null\` or a warning log. Do not crash the process.
- Use the pattern: \`error instanceof Error ? error.message : String(error)\`.

${formatterSection}
${linterSection}
${typeCheckSection}
${testSection}
## Git Workflow

### Branch Naming

\`<type>/<short-description>\` where type is one of:
\`\`\`
feat/    fix/    chore/    docs/    refactor/    test/
\`\`\`

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/) format:
\`\`\`
feat: add new feature
fix: handle edge case
chore: update dependencies
docs: add architecture docs
refactor: extract helper function
test: add integration tests
\`\`\`

### PR Size

Keep PRs focused on a single concern. Prefer multiple small PRs over one large PR. Every PR must be classified by risk tier in the description.

## Code Review Standards

### Risk Tiers

| Tier | Scope | Required Checks |
|---|---|---|
| **Tier 1** (low) | Docs, comments, config | lint |
| **Tier 2** (medium) | Source code, tests | lint, type-check, test, review-agent |
| **Tier 3** (high) | Entry points, core engine, build infra | lint, type-check, test, review-agent, manual-review |
`;
}

function buildLayersMd(detection: DetectionResult): string {
  const layers = detection.architecturalLayers;

  if (layers.length === 0) {
    return `# Layer Boundaries

No architectural layers detected in this project. As the project grows, consider organizing code into layers with explicit dependency rules.
`;
  }

  const layerDefs = layers
    .map((layer) => {
      const allowed = layer === 'utils' ? 'none -- this is the leaf layer.' : 'utils';
      const forbidden =
        layer === 'utils'
          ? `All other layers. ${layer} must never import from other layers.`
          : layers.filter((l) => l !== layer && l !== 'utils').join(', ') || 'none';

      return `### ${layer}

- **Allowed dependencies**: ${allowed}
- **Forbidden dependencies**: ${forbidden}
`;
    })
    .join('\n');

  const depMatrix = buildDependencyMatrix(layers);

  return `# Layer Boundaries

This document defines the architectural layer structure. These boundaries are enforced by the \`architecturalBoundaries\` section of \`harness.config.json\` and checked by the architectural-linters harness in CI.

## Layer Definitions

${layerDefs}

## Dependency Matrix

${depMatrix}

## Enforcement

### CI Gate

The \`architectural-linters\` harness generates a custom lint script that statically analyzes import statements against the \`architecturalBoundaries\` definition in \`harness.config.json\`. This runs as part of the \`structural-tests\` CI job.

A boundary violation fails the build:
\`\`\`
ERROR: src/core/example.ts imports from "ui" layer (forbidden).
       core -> ui is not in allowedImports: ["utils"]
\`\`\`

### Local Development

Run \`${detection.lintCommand ?? 'npm run lint'}\` before pushing.
`;
}

export const docsStructureHarness: HarnessModule = {
  name: 'docs-structure',
  displayName: 'Documentation Structure',
  description: 'Generates architecture, conventions, and layers documentation',
  order: 3,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;

    // 1. Generate reference content from existing builders
    const refArchitecture = buildArchitectureMd(detection);
    const refConventions = buildConventionsMd(detection);
    const refLayers = buildLayersMd(detection);

    // 2. Build the prompt with reference context
    const basePrompt = buildDocsStructurePrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: docs/architecture.md
\`\`\`markdown
${refArchitecture}
\`\`\`

### Reference: docs/conventions.md
\`\`\`markdown
${refConventions}
\`\`\`

### Reference: docs/layers.md
\`\`\`markdown
${refLayers}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'docs-structure',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { docsPath: 'docs/' },
      };
      ctx.previousOutputs.set('docs-structure', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Documentation structure generation failed: ${message}`);
    }
  },
};
