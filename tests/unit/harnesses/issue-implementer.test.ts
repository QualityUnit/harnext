import { issueImplementerHarness } from '../../../src/harnesses/issue-implementer.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { DetectionResult } from '../../../src/core/detector.js';

vi.mock('../../../src/prompts/issue-implementer.js', () => ({
  buildIssueImplementerPrompt: vi.fn().mockReturnValue('mocked issue implementer prompt'),
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
        filesCreated: [
          '/tmp/test-repo/.github/workflows/issue-implementer.yml',
          '/tmp/test-repo/scripts/issue-implementer-prompt.md',
          '/tmp/test-repo/scripts/issue-implementer-guard.ts',
        ],
        filesModified: [],
      }),
      analyze: vi.fn(),
      platform: 'claude' as const,
    } as unknown as AIRunner,
    fileWriter: {} as HarnessContext['fileWriter'],
    userPreferences: {
      ciProvider: 'github-actions',
      strictnessLevel: 'standard',
      selectedHarnesses: ['issue-implementer'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('issueImplementerHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(issueImplementerHarness.name).toBe('issue-implementer');
    expect(issueImplementerHarness.displayName).toBe('Issue Implementer Agent');
    expect(issueImplementerHarness.order).toBe(16);
  });

  it('isApplicable should return true', () => {
    const ctx = createMockContext();
    expect(issueImplementerHarness.isApplicable(ctx)).toBe(true);
  });

  it('should call runner.generate with the prompt', async () => {
    const ctx = createMockContext();
    await issueImplementerHarness.execute(ctx);

    expect(ctx.runner.generate).toHaveBeenCalledOnce();
    expect(ctx.runner.generate).toHaveBeenCalledWith(
      'mocked issue implementer prompt',
      'mocked system prompt',
    );
  });

  it('should return correct output with filesCreated', async () => {
    const ctx = createMockContext();
    const output = await issueImplementerHarness.execute(ctx);

    expect(output.harnessName).toBe('issue-implementer');
    expect(output.filesCreated).toContain('/tmp/test-repo/.github/workflows/issue-implementer.yml');
    expect(output.filesCreated).toContain('/tmp/test-repo/scripts/issue-implementer-prompt.md');
    expect(output.filesCreated).toContain('/tmp/test-repo/scripts/issue-implementer-guard.ts');
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await issueImplementerHarness.execute(ctx);

    expect(ctx.previousOutputs.has('issue-implementer')).toBe(true);
    const stored = ctx.previousOutputs.get('issue-implementer');
    expect(stored?.harnessName).toBe('issue-implementer');
  });

  it('should include metadata with targetFiles', async () => {
    const ctx = createMockContext();
    const output = await issueImplementerHarness.execute(ctx);

    expect(output.metadata).toBeDefined();
    expect(output.metadata?.targetFiles).toEqual([
      '.github/workflows/issue-implementer.yml',
      'scripts/issue-implementer-guard.ts',
    ]);
    expect(output.metadata?.promptFile).toBe('.codefactory/prompts/issue-implementer.md');
  });

  it('should wrap errors with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue(new Error('Claude API timeout')),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(issueImplementerHarness.execute(ctx)).rejects.toThrow(
      'Issue implementer generation failed: Claude API timeout',
    );
  });

  it('should wrap non-Error exceptions with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue('network failure'),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(issueImplementerHarness.execute(ctx)).rejects.toThrow(
      'Issue implementer generation failed: network failure',
    );
  });
});
