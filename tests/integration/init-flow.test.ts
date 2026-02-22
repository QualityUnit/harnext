import { fileURLToPath } from 'url';
import path from 'path';
import type { AIRunner } from '../../src/core/ai-runner.js';
import type { DetectionResult } from '../../src/core/detector.js';
import type {
  HarnessContext,
  HarnessModule,
  HarnessOutput,
  UserPreferences,
} from '../../src/harnesses/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../fixtures');

// Create mock harness modules that don't depend on prompt templates
function createMockHarness(name: string, displayName: string, order: number): HarnessModule {
  return {
    name,
    displayName,
    description: `Mock ${displayName}`,
    order,
    isApplicable: () => true,
    execute: async (ctx: HarnessContext): Promise<HarnessOutput> => {
      const result = await ctx.runner.generate(`Generate ${name}`);
      const output: HarnessOutput = {
        harnessName: name,
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
      };
      ctx.previousOutputs.set(name, output);
      return output;
    },
  };
}

const mockHarnesses: HarnessModule[] = [
  createMockHarness('risk-contract', 'Risk Contract', 1),
  createMockHarness('claude-md', 'CLAUDE.md', 2),
  createMockHarness('docs-structure', 'Documentation Structure', 3),
  createMockHarness('pre-commit-hooks', 'Pre-commit Hooks', 4),
  createMockHarness('risk-policy-gate', 'Risk Policy Gate', 5),
];

vi.mock('../../src/harnesses/index.js', () => ({
  getHarnessModules: () => [...mockHarnesses].sort((a, b) => a.order - b.order),
  getHarnessById: (name: string) => mockHarnesses.find((h) => h.name === name),
}));

// Mock child_process to prevent real CLI calls
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(),
}));

import { runHeuristicDetection } from '../../src/core/detector.js';
import { getHarnessModules, getHarnessById } from '../../src/harnesses/index.js';

describe('Init flow integration', () => {
  const nodeProjectDir = path.join(fixturesDir, 'node-project');

  it('should detect the stack correctly from fixture', async () => {
    const heuristics = await runHeuristicDetection(nodeProjectDir);

    expect(heuristics.languages).toContain('JavaScript');
    expect(heuristics.languages).toContain('TypeScript');
    expect(heuristics.framework).toBe('Next.js');
    expect(heuristics.hasTypeScript).toBe(true);
    expect(heuristics.ciProvider).toBe('GitHub Actions');
  });

  it('should load all harness modules in correct order', () => {
    const harnesses = getHarnessModules();

    expect(harnesses.length).toBeGreaterThan(0);
    // Verify ordering
    for (let i = 1; i < harnesses.length; i++) {
      expect(harnesses[i].order).toBeGreaterThanOrEqual(harnesses[i - 1].order);
    }
  });

  it('should look up harnesses by name', () => {
    const harness = getHarnessById('risk-contract');
    expect(harness).toBeDefined();
    expect(harness?.name).toBe('risk-contract');

    const missing = getHarnessById('nonexistent');
    expect(missing).toBeUndefined();
  });

  it('should filter applicable harnesses', () => {
    const harnesses = getHarnessModules();
    const detection: DetectionResult = {
      primaryLanguage: 'typescript',
      framework: 'next',
      packageManager: 'npm',
      testFramework: 'vitest',
      linter: 'eslint',
      formatter: 'prettier',
      typeChecker: 'tsc',
      buildTool: 'tsup',
      ciProvider: 'github-actions',
      existingDocs: ['README.md'],
      existingClaude: false,
      architecturalLayers: ['api', 'components'],
      monorepo: false,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      lintCommand: 'npm run lint',
      hasUIComponents: true,
      criticalPaths: ['src/api/'],
    };

    const prefs: UserPreferences = {
      ciProvider: 'github-actions',
      aiPlatform: 'claude',
      strictnessLevel: 'standard',
      selectedHarnesses: ['risk-contract', 'claude-md'],
    };

    const ctx: HarnessContext = {
      repoRoot: nodeProjectDir,
      detection,
      runner: { platform: 'claude' as const } as AIRunner,
      fileWriter: {} as HarnessContext['fileWriter'],
      userPreferences: prefs,
      previousOutputs: new Map(),
    };

    const applicable = harnesses.filter((h) => h.isApplicable(ctx));
    expect(applicable.length).toBeGreaterThan(0);
  });

  it('should execute harnesses and accumulate outputs', async () => {
    const mockRunner = {
      platform: 'claude' as const,
      generate: vi.fn<AIRunner['generate']>().mockResolvedValue({
        filesCreated: ['/tmp/test-repo/harness.config.json'],
        filesModified: [],
      }),
      analyze: vi.fn(),
    } as unknown as AIRunner;

    const detection: DetectionResult = {
      primaryLanguage: 'typescript',
      framework: 'next',
      packageManager: 'npm',
      testFramework: 'vitest',
      linter: 'eslint',
      formatter: 'prettier',
      typeChecker: 'tsc',
      buildTool: 'tsup',
      ciProvider: 'github-actions',
      existingDocs: ['README.md'],
      existingClaude: false,
      architecturalLayers: ['api', 'components'],
      monorepo: false,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      lintCommand: 'npm run lint',
      hasUIComponents: true,
      criticalPaths: ['src/api/'],
    };

    const prefs: UserPreferences = {
      ciProvider: 'github-actions',
      aiPlatform: 'claude',
      strictnessLevel: 'standard',
      selectedHarnesses: ['risk-contract', 'claude-md'],
    };

    const previousOutputs = new Map<string, HarnessOutput>();

    const ctx: HarnessContext = {
      repoRoot: nodeProjectDir,
      detection,
      runner: mockRunner,
      fileWriter: {} as HarnessContext['fileWriter'],
      userPreferences: prefs,
      previousOutputs,
    };

    const harnesses = getHarnessModules();
    const selected = harnesses.filter((h) => prefs.selectedHarnesses.includes(h.name));

    expect(selected.length).toBe(2);

    const allFilesCreated: string[] = [];

    for (const harness of selected) {
      const output = await harness.execute(ctx);
      allFilesCreated.push(...output.filesCreated);
    }

    expect(allFilesCreated.length).toBeGreaterThan(0);
    expect(mockRunner.generate).toHaveBeenCalledTimes(2);
  });

  it('should pass previous outputs between harnesses', async () => {
    const mockRunner = {
      platform: 'claude' as const,
      generate: vi.fn<AIRunner['generate']>().mockResolvedValue({
        filesCreated: ['/tmp/test-repo/generated-file.json'],
        filesModified: [],
      }),
      analyze: vi.fn(),
    } as unknown as AIRunner;

    const detection: DetectionResult = {
      primaryLanguage: 'typescript',
      framework: 'next',
      packageManager: 'npm',
      testFramework: 'vitest',
      linter: 'eslint',
      formatter: 'prettier',
      typeChecker: 'tsc',
      buildTool: 'tsup',
      ciProvider: 'github-actions',
      existingDocs: ['README.md'],
      existingClaude: false,
      architecturalLayers: ['api', 'components'],
      monorepo: false,
      testCommand: 'npm test',
      buildCommand: 'npm run build',
      lintCommand: 'npm run lint',
      hasUIComponents: true,
      criticalPaths: ['src/api/'],
    };

    const prefs: UserPreferences = {
      ciProvider: 'github-actions',
      aiPlatform: 'claude',
      strictnessLevel: 'standard',
      selectedHarnesses: ['risk-contract', 'claude-md'],
    };

    const previousOutputs = new Map<string, HarnessOutput>();

    const ctx: HarnessContext = {
      repoRoot: nodeProjectDir,
      detection,
      runner: mockRunner,
      fileWriter: {} as HarnessContext['fileWriter'],
      userPreferences: prefs,
      previousOutputs,
    };

    const harnesses = getHarnessModules();
    const selected = harnesses.filter((h) => prefs.selectedHarnesses.includes(h.name));

    // Execute in order - risk-contract first, then claude-md
    for (const harness of selected) {
      await harness.execute(ctx);
    }

    // After risk-contract executes, its output should be available
    expect(previousOutputs.has('risk-contract')).toBe(true);
    // After claude-md executes, its output should also be available
    expect(previousOutputs.has('claude-md')).toBe(true);
  });
});
