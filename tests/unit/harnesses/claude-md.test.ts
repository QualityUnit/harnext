import { claudeMdHarness } from '../../../src/harnesses/claude-md.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { DetectionResult } from '../../../src/core/detector.js';

vi.mock('../../../src/prompts/claude-md.js', () => ({
  buildClaudeMdPrompt: vi.fn().mockReturnValue('mocked claude-md prompt'),
}));

vi.mock('../../../src/prompts/system.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('mocked system prompt'),
}));

import { buildClaudeMdPrompt } from '../../../src/prompts/claude-md.js';

function createMockContext(overrides?: Partial<HarnessContext>): HarnessContext {
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

  return {
    repoRoot: '/tmp/test-repo',
    detection,
    runner: {
      generate: vi.fn<AIRunner['generate']>().mockResolvedValue({
        filesCreated: ['/tmp/test-repo/CLAUDE.md'],
        filesModified: [],
      }),
      analyze: vi.fn(),
      platform: 'claude' as const,
    } as unknown as AIRunner,
    fileWriter: {} as HarnessContext['fileWriter'],
    userPreferences: {
      ciProvider: 'github-actions',
      strictnessLevel: 'standard',
      selectedHarnesses: ['claude-md'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('claudeMdHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(claudeMdHarness.name).toBe('claude-md');
    expect(claudeMdHarness.displayName).toBe('Agent Instructions');
    expect(claudeMdHarness.order).toBe(2);
  });

  it('isApplicable should return true', () => {
    const ctx = createMockContext();
    expect(claudeMdHarness.isApplicable(ctx)).toBe(true);
  });

  it('should call runner.generate with the prompt including reference', async () => {
    const ctx = createMockContext();
    await claudeMdHarness.execute(ctx);

    expect(ctx.runner.generate).toHaveBeenCalledOnce();
    expect(ctx.runner.generate).toHaveBeenCalledWith(
      expect.stringContaining('mocked claude-md prompt'),
      'mocked system prompt',
    );
    // Verify the reference implementation section is included
    const actualPrompt = vi.mocked(ctx.runner.generate).mock.calls[0][0];
    expect(actualPrompt).toContain('## Reference Implementation');
    expect(actualPrompt).toContain('### Reference: CLAUDE.md');
  });

  it('should include CLAUDE.md in filesCreated', async () => {
    const ctx = createMockContext();
    const output = await claudeMdHarness.execute(ctx);

    expect(output.filesCreated).toContain('/tmp/test-repo/CLAUDE.md');
    expect(output.harnessName).toBe('claude-md');
  });

  it('should pass detection and preferences to buildClaudeMdPrompt', async () => {
    const riskOutput = {
      harnessName: 'risk-contract',
      filesCreated: ['/tmp/test-repo/harness.config.json'],
      filesModified: [],
    };
    const previousOutputs = new Map([['risk-contract', riskOutput]]);
    const ctx = createMockContext({ previousOutputs });

    await claudeMdHarness.execute(ctx);

    expect(buildClaudeMdPrompt).toHaveBeenCalledWith(ctx.detection, ctx.userPreferences);
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await claudeMdHarness.execute(ctx);

    expect(ctx.previousOutputs.has('claude-md')).toBe(true);
  });

  it('should wrap errors with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue(new Error('Generation failed')),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(claudeMdHarness.execute(ctx)).rejects.toThrow(
      'CLAUDE.md generation failed: Generation failed',
    );
  });
});
