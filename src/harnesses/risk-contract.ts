import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { buildRiskContractPrompt } from '../prompts/risk-contract.js';
import { buildSystemPrompt } from '../prompts/system.js';

/**
 * Builds a reference harness.config.json from detection context.
 * Used as structural template for Claude to customize.
 */
function buildRiskContractConfig(ctx: HarnessContext): string {
  const { detection, userPreferences, repoRoot } = ctx;

  // ── Build tier3 patterns from detection + user preferences ───────────
  const tier3Patterns = [
    ...detection.criticalPaths,
    ...(userPreferences.customCriticalPaths ?? []),
  ];

  // ── Build architectural boundaries ───────────────────────────────────
  const boundaries: Record<string, { allowedImports: string[] }> = {};
  const layers = detection.architecturalLayers;
  const hasUtils = layers.includes('utils');

  for (const layer of layers) {
    if (layer === 'utils') {
      boundaries[layer] = { allowedImports: [] };
    } else {
      boundaries[layer] = { allowedImports: hasUtils ? ['utils'] : [] };
    }
  }

  // ── Build commands ───────────────────────────────────────────────────
  const commands: Record<string, string> = {};
  if (detection.testCommand) commands.test = detection.testCommand;
  if (detection.buildCommand) commands.build = detection.buildCommand;
  if (detection.lintCommand) commands.lint = detection.lintCommand;
  if (detection.typeChecker) {
    const pm = detection.packageManager ?? 'npm';
    commands.typeCheck = `${pm} run typecheck`;
  }

  // ── Assemble the config object ───────────────────────────────────────
  const config = {
    version: '1.0.0',
    repoRoot,
    detection: {
      primaryLanguage: detection.primaryLanguage,
      framework: detection.framework,
      packageManager: detection.packageManager,
      ciProvider: detection.ciProvider,
      monorepo: detection.monorepo,
    },
    riskTiers: {
      tier1: {
        name: 'low',
        patterns: ['docs/**', '*.md', '**/*.md'],
        requiredChecks: ['lint'],
        mergePolicy: 'auto',
        evidenceRequirements: ['lint-clean'],
      },
      tier2: {
        name: 'medium',
        patterns: ['src/**', 'tests/**'],
        requiredChecks: ['lint', 'type-check', 'test', 'build'],
        mergePolicy: 'review-agent',
        evidenceRequirements: ['tests-pass', 'lint-clean', 'type-check-clean'],
      },
      tier3: {
        name: 'high',
        patterns: tier3Patterns,
        requiredChecks: [
          'lint',
          'type-check',
          'test',
          'build',
          'structural-tests',
          'harness-smoke',
          'manual-approval',
        ],
        mergePolicy: 'review-agent + manual',
        evidenceRequirements: ['tests-pass', 'lint-clean', 'type-check-clean', 'manual-review'],
      },
    },
    commands,
    shaDiscipline: {
      enabled: true,
      description: 'All CI gates pin to exact commit SHA from the risk policy gate',
    },
    architecturalBoundaries: boundaries,
    harnesses: [],
    generatedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  return JSON.stringify(config, null, 2) + '\n';
}

export const riskContractHarness: HarnessModule = {
  name: 'risk-contract',
  displayName: 'Risk Contract',
  description:
    'Generates harness.config.json with risk tier rules, merge policies, and evidence requirements',
  order: 1,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;

    // 1. Generate reference template from existing builder
    const refContent = buildRiskContractConfig(ctx);

    // 2. Build the prompt with reference context
    const basePrompt = buildRiskContractPrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

CRITICAL: The reference below contains the EXACT required structure. Your output
MUST include ALL of these top-level keys: version, riskTiers, commands,
shaDiscipline, architecturalBoundaries. The harness-smoke CI job validates that
these keys exist — missing any will cause CI to fail on every PR.

Customize the values (patterns, commands, thresholds) for the detected stack,
but do NOT omit any top-level section.

### Reference: harness.config.json
\`\`\`json
${refContent}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'risk-contract',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { configPath: 'harness.config.json' },
      };
      ctx.previousOutputs.set('risk-contract', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Risk contract generation failed: ${message}`);
    }
  },
};
