import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { INSTRUCTION_FILES } from '../core/ai-runner.js';

import { buildPrTemplatesPrompt } from '../prompts/pr-templates.js';
import { buildSystemPrompt } from '../prompts/system.js';

function buildPullRequestTemplate(instructionFile: string): string {
  return `## Summary
<!-- Brief description of what this PR does and why. Link to the issue if applicable. -->

## Risk Tier
<!-- The risk-policy-gate auto-detects the tier, but classify here for reviewer context. -->
<!-- See harness.config.json for full pattern definitions. -->
- [ ] **Tier 1 (Low)**: Docs, comments, \`.md\`/\`.txt\` files, \`.gitignore\`, \`.editorconfig\`, \`.prettierrc\`, \`.vscode/\`
- [ ] **Tier 2 (Medium)**: Source in \`src/ui/\`, \`src/utils/\`, \`src/prompts/\`, \`src/providers/\`, \`tests/\`
- [ ] **Tier 3 (High)**: Entry points, core engine, harness registry, build/CI infra (\`src/index.ts\`, \`src/cli.ts\`, \`src/commands/\`, \`src/core/\`, \`src/harnesses/index.ts\`, \`src/harnesses/types.ts\`, \`package.json\`, \`tsconfig.json\`, \`tsup.config.ts\`, \`vitest.config.ts\`, \`eslint.config.js\`)

## Changes
<!-- Group modified files by logical concern. -->

### Added
-

### Changed
-

### Removed
-

## Testing
<!-- How were these changes validated? -->
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed
- [ ] All checks pass locally:
  \`\`\`
  npm run lint && npm run typecheck && npm test
  \`\`\`

## Evidence
<!-- Tier 1: none required. Tier 2: tests-pass, lint-clean, type-check-clean. Tier 3: all of Tier 2 + manual-review. -->

| Check | Result |
|-------|--------|
| \`eslint src/\` | <!-- PASS / FAIL --> |
| \`tsc --noEmit\` | <!-- PASS / FAIL --> |
| \`vitest run\` | <!-- PASS / FAIL --> |
| \`tsup\` (build) | <!-- PASS / FAIL --> |

## Architectural Compliance
<!-- Confirm layer boundaries are respected (see docs/layers.md). -->
- [ ] No circular imports introduced
- [ ] Import rules followed: \`utils\` imports nothing; \`core\` imports only \`utils\`; etc.
- [ ] No imports from \`commands\` or \`harnesses\` inside \`core\`

## Review Checklist
- [ ] Code follows project conventions (\`docs/conventions.md\`, \`${instructionFile}\`)
- [ ] ESM imports use \`.js\` extensions for local files
- [ ] \`import type\` used for type-only imports
- [ ] No secrets, API keys, or \`.env\` files committed
- [ ] No ESLint rules or TypeScript strict mode disabled
- [ ] Documentation updated if public API changed
- [ ] Risk tier accurately reflects scope of changes
`;
}

function buildAgentPrTemplate(instructionFile: string): string {
  return `## Agent-Generated PR

**Agent**: <!-- agent name and version (e.g., Claude Code v1.0, remediation-bot) -->
**Trigger**: <!-- what triggered this PR: review remediation, feature request, scheduled task -->
**Head SHA**: \`<!-- exact commit SHA this PR was generated at -->\`

## Summary
<!-- Auto-generated summary describing all changes. -->

## Risk Assessment

- **Detected Risk Tier**: <!-- auto-populated by risk-policy-gate -->
- **Critical paths touched**:
  <!-- List any files matching Tier 3 patterns from harness.config.json:
       src/index.ts, src/cli.ts, src/commands/**, src/core/**,
       src/harnesses/index.ts, src/harnesses/types.ts,
       package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, eslint.config.js -->
  -
- **Confidence level**: <!-- high / medium / low -->

## Changes Made
<!-- Complete list of every file modified. -->

| File | Change Type | Description |
|------|-------------|-------------|
| | added / modified / deleted | |

## Validation Results

| Check | Status | Command |
|-------|--------|---------|
| Lint | <!-- PASS / FAIL --> | \`eslint src/\` |
| Type Check | <!-- PASS / FAIL --> | \`tsc --noEmit\` |
| Tests | <!-- PASS / FAIL --> | \`vitest run\` |
| Build | <!-- PASS / FAIL --> | \`tsup\` |

## Architectural Compliance
<!-- Layer boundary check results (see docs/layers.md, harness.config.json -> architecturalBoundaries). -->
- [ ] No circular imports
- [ ] Import rules respected
- [ ] No protected files modified (\`.github/workflows/\`, \`harness.config.json\`, \`${instructionFile}\`, lockfiles)

## Review Agent Status
- [ ] Review agent has analyzed this PR
- [ ] No unresolved blocking findings
- [ ] Review SHA matches current HEAD (\`<!-- SHA -->\`)
- **Verdict**: <!-- APPROVE / REQUEST_CHANGES / PENDING -->

## Human Review Required
<!-- Tier 3 changes require manual approval via the tier3-approval environment gate. -->
- [ ] Required — Tier 3 (high-risk) changes detected
- [ ] Optional but recommended — Tier 2 changes

## Remediation History
<!-- Only if this PR was created or updated by the remediation agent. Remove this section otherwise. -->
- **Original PR**: #<!-- number -->
- **Remediation attempt**: <!-- 1 / 2 / 3 (max 3 per harness.config.json) -->
- **Findings fixed**: <!-- count -->
- **Findings skipped**: <!-- count, with brief reasons -->
- **Validation after fix**: <!-- all passed / partial — specify which failed -->
`;
}

export const prTemplatesHarness: HarnessModule = {
  name: 'pr-templates',
  displayName: 'PR Templates',
  description: 'Generates pull request templates with risk tier and evidence sections',
  order: 10,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;
    const instructionFile = INSTRUCTION_FILES[ctx.runner.platform];

    // 1. Build reference templates for detected platform
    const refDefaultTemplate = buildPullRequestTemplate(instructionFile);
    const refAgentTemplate = buildAgentPrTemplate(instructionFile);

    // 2. Build the prompt with reference context
    const basePrompt = buildPrTemplatesPrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: .github/PULL_REQUEST_TEMPLATE.md
\`\`\`markdown
${refDefaultTemplate}
\`\`\`

### Reference: .github/PULL_REQUEST_TEMPLATE/agent-pr.md
\`\`\`markdown
${refAgentTemplate}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'pr-templates',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { templatePath: '.github/PULL_REQUEST_TEMPLATE.md' },
      };
      ctx.previousOutputs.set('pr-templates', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PR templates generation failed: ${message}`);
    }
  },
};
