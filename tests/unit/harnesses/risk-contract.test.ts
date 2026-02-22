import { riskContractHarness } from '../../../src/harnesses/risk-contract.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { GenerateResult } from '../../../src/core/claude-runner.js';
import type { DetectionResult } from '../../../src/core/detector.js';

vi.mock('../../../src/prompts/risk-contract.js', () => ({
  buildRiskContractPrompt: vi.fn().mockReturnValue('mocked risk contract prompt'),
}));

vi.mock('../../../src/prompts/system.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('mocked system prompt'),
}));

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
        filesCreated: ['/tmp/test-repo/harness.config.json'],
        filesModified: [],
      }),
      analyze: vi.fn(),
      platform: 'claude' as const,
    } as unknown as AIRunner,
    fileWriter: {} as HarnessContext['fileWriter'],
    userPreferences: {
      ciProvider: 'github-actions',
      strictnessLevel: 'standard',
      selectedHarnesses: ['risk-contract'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('riskContractHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(riskContractHarness.name).toBe('risk-contract');
    expect(riskContractHarness.displayName).toBe('Risk Contract');
    expect(riskContractHarness.order).toBe(1);
  });

  it('isApplicable should return true', () => {
    const ctx = createMockContext();
    expect(riskContractHarness.isApplicable(ctx)).toBe(true);
  });

  it('should call runner.generate with the prompt including reference', async () => {
    const ctx = createMockContext();
    await riskContractHarness.execute(ctx);

    expect(ctx.runner.generate).toHaveBeenCalledOnce();
    expect(ctx.runner.generate).toHaveBeenCalledWith(
      expect.stringContaining('mocked risk contract prompt'),
      'mocked system prompt',
    );
    // Verify the reference implementation section is included
    const actualPrompt = vi.mocked(ctx.runner.generate).mock.calls[0][0];
    expect(actualPrompt).toContain('## Reference Implementation');
    expect(actualPrompt).toContain('### Reference: harness.config.json');
  });

  it('should include harness.config.json in filesCreated', async () => {
    const ctx = createMockContext();
    const output = await riskContractHarness.execute(ctx);

    expect(output.filesCreated).toContain('/tmp/test-repo/harness.config.json');
    expect(output.harnessName).toBe('risk-contract');
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await riskContractHarness.execute(ctx);

    expect(ctx.previousOutputs.has('risk-contract')).toBe(true);
    const stored = ctx.previousOutputs.get('risk-contract');
    expect(stored?.filesCreated).toContain('/tmp/test-repo/harness.config.json');
  });

  it('should include metadata with configPath', async () => {
    const ctx = createMockContext();
    const output = await riskContractHarness.execute(ctx);

    expect(output.metadata).toBeDefined();
    expect(output.metadata?.configPath).toBe('harness.config.json');
  });

  it('should wrap errors with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue(new Error('Claude API timeout')),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(riskContractHarness.execute(ctx)).rejects.toThrow(
      'Risk contract generation failed: Claude API timeout',
    );
  });
});
