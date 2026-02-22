import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import type { DetectionResult } from '../core/detector.js';
import { INSTRUCTION_FILES } from '../core/ai-runner.js';
import { buildClaudeMdPrompt } from '../prompts/claude-md.js';
import { buildSystemPrompt } from '../prompts/system.js';

function buildProjectOverview(detection: DetectionResult): string {
  const parts: string[] = [];
  parts.push(`Written in ${detection.primaryLanguage}`);
  if (detection.framework) {
    parts.push(`using the ${detection.framework} framework`);
  }
  if (detection.packageManager) {
    parts.push(`with ${detection.packageManager} as the package manager`);
  }
  return parts.join(' ') + '.';
}

function buildCommandsSection(detection: DetectionResult): string {
  const lines: string[] = ['```bash'];

  if (detection.packageManager) {
    lines.push(
      `${detection.packageManager} install${' '.repeat(Math.max(1, 14 - `${detection.packageManager} install`.length))}# Install dependencies`,
    );
  }
  if (detection.buildCommand) {
    const pad = Math.max(1, 22 - detection.buildCommand.length);
    lines.push(`${detection.buildCommand}${' '.repeat(pad)}# Build the project`);
  }
  if (detection.testCommand) {
    const pad = Math.max(1, 22 - detection.testCommand.length);
    lines.push(`${detection.testCommand}${' '.repeat(pad)}# Run all tests`);
  }
  if (detection.lintCommand) {
    const pad = Math.max(1, 22 - detection.lintCommand.length);
    lines.push(`${detection.lintCommand}${' '.repeat(pad)}# Lint the codebase`);
  }
  if (detection.typeChecker) {
    const pm = detection.packageManager ?? 'npm';
    const cmd = `${pm} run typecheck`;
    const pad = Math.max(1, 22 - cmd.length);
    lines.push(`${cmd}${' '.repeat(pad)}# Type-check (${detection.typeChecker})`);
  }

  lines.push('```');
  return lines.join('\n');
}

function buildCodeStyleSection(detection: DetectionResult): string {
  const rules: string[] = [];

  if (detection.formatter) {
    rules.push(`- **Formatter**: ${detection.formatter}`);
  }
  if (detection.linter) {
    rules.push(`- **Linter**: ${detection.linter}`);
  }
  if (detection.primaryLanguage === 'TypeScript') {
    rules.push('- **Type imports**: Use `import type { Foo }` for type-only imports.');
  }
  rules.push('- **File naming**: Use `kebab-case` for all source files.');
  rules.push(
    '- **Naming conventions**: `camelCase` for variables/functions, `PascalCase` for interfaces/classes/types.',
  );
  rules.push('- **Exports**: Named exports only. No default exports in source files.');
  rules.push(
    '- **Error handling**: Use `try/catch` with pattern: `error instanceof Error ? error.message : String(error)`.',
  );

  if (detection.primaryLanguage === 'TypeScript' || detection.primaryLanguage === 'JavaScript') {
    rules.push(
      '- **ESM**: This is a pure ESM package. All local imports must include `.js` extensions.',
    );
  }

  return rules.join('\n');
}

function buildArchitectureSection(detection: DetectionResult): string {
  if (detection.architecturalLayers.length === 0) {
    return 'No distinct architectural layers detected.';
  }

  const lines: string[] = ['```', 'src/'];
  for (const layer of detection.architecturalLayers) {
    lines.push(`  ${layer}/`);
  }
  lines.push('```');
  return lines.join('\n');
}

function buildCriticalPathsSection(detection: DetectionResult): string {
  if (detection.criticalPaths.length === 0) {
    return 'No critical paths detected. Consider adding entry points and config files.';
  }

  const lines: string[] = [
    'Changes to these files require additional test coverage and human review:',
    '',
  ];
  for (const path of detection.criticalPaths) {
    lines.push(`- \`${path}\``);
  }
  lines.push('');
  lines.push(
    'These are classified as **Tier 3 (high risk)** in `harness.config.json`. ' +
      'All Tier 3 changes require: lint + type-check + full test suite + review-agent + manual human review.',
  );
  return lines.join('\n');
}

export const claudeMdHarness: HarnessModule = {
  name: 'claude-md',
  displayName: 'Agent Instructions',
  description: 'Generates agent instruction file (CLAUDE.md, KIRO.md, or CODEX.md)',
  order: 2,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;
    const aiPlatform = ctx.runner.platform;
    const instructionFile = INSTRUCTION_FILES[aiPlatform];

    // 1. Generate reference content from existing builders
    const refContent = `# ${instructionFile}

## Project Overview

${buildProjectOverview(detection)}

## Build & Run Commands

${buildCommandsSection(detection)}

## Code Style Rules

${buildCodeStyleSection(detection)}

## Architecture Overview

${buildArchitectureSection(detection)}

## Critical Paths -- Extra Care Required

${buildCriticalPathsSection(detection)}

## Security Constraints

- Never commit secrets, API keys, or \`.env\` files.
- Never disable linter rules, strict mode, or type checking.
- Validate all external input at system boundaries.
- Never pass unsanitized user input to shell commands.

## PR Conventions

- **Branch naming**: \`<type>/<short-description>\` (e.g., \`feat/add-auth\`, \`fix/null-check\`, \`chore/update-deps\`).
- **Commit messages**: Conventional Commits -- \`feat:\`, \`fix:\`, \`chore:\`, \`docs:\`, \`refactor:\`, \`test:\`.
- All PRs must pass lint, type-check, and test CI gates before merge.
- Classify every PR by risk tier (Tier 1/2/3) in the PR description.
`;

    // 2. Build the prompt with reference context
    const basePrompt = buildClaudeMdPrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use this as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: ${instructionFile}
\`\`\`markdown
${refContent}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'claude-md',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { instructionFile },
      };
      ctx.previousOutputs.set('claude-md', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${instructionFile} generation failed: ${message}`);
    }
  },
};
