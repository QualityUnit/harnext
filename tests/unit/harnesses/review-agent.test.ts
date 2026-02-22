import { reviewAgentHarness } from '../../../src/harnesses/review-agent.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { DetectionResult } from '../../../src/core/detector.js';

vi.mock('../../../src/prompts/review-agent.js', () => ({
  buildReviewAgentPrompt: vi.fn().mockReturnValue('mocked review agent prompt'),
}));

vi.mock('../../../src/prompts/system.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('mocked system prompt'),
}));

function createMockContext(overrides?: Partial<HarnessContext>): HarnessContext {
  const detection: DetectionResult = {
    primaryLanguage: 'typescript',
    languages: ['typescript', 'javascript'],
    hasTypeScript: true,
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
          '/tmp/test-repo/.github/workflows/code-review-agent.yml',
          '/tmp/test-repo/.github/workflows/review-agent-rerun.yml',
          '/tmp/test-repo/.github/workflows/auto-resolve-threads.yml',
          '/tmp/test-repo/scripts/review-agent-utils.ts',
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
      selectedHarnesses: ['review-agent'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('reviewAgentHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(reviewAgentHarness.name).toBe('review-agent');
    expect(reviewAgentHarness.displayName).toBe('Review Agent Integration');
    expect(reviewAgentHarness.order).toBe(7);
  });

  it('isApplicable should return true', () => {
    expect(reviewAgentHarness.isApplicable({} as HarnessContext)).toBe(true);
  });

  it('should call runner.generate with prompt containing reference content', async () => {
    const ctx = createMockContext();
    await reviewAgentHarness.execute(ctx);

    expect(ctx.runner.generate).toHaveBeenCalledOnce();
    const [prompt, systemPrompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain('mocked review agent prompt');
    expect(prompt).toContain('## Reference Implementation');
    expect(prompt).toContain('### Reference: .github/workflows/code-review-agent.yml');
    expect(prompt).toContain('### Reference: .github/workflows/review-agent-rerun.yml');
    expect(prompt).toContain('### Reference: .github/workflows/auto-resolve-threads.yml');
    expect(prompt).toContain('### Reference: scripts/review-agent-utils.ts');
    expect(prompt).toContain('### Reference: .codefactory/prompts/review-agent.md');
    expect(systemPrompt).toBe('mocked system prompt');
  });

  it('should not include scripts/review-prompt.md reference block', async () => {
    const ctx = createMockContext();
    await reviewAgentHarness.execute(ctx);

    const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).not.toContain('### Reference: scripts/review-prompt.md');
  });

  it('should return correct output with filesCreated', async () => {
    const ctx = createMockContext();
    const output = await reviewAgentHarness.execute(ctx);

    expect(output.harnessName).toBe('review-agent');
    expect(output.filesCreated).toContain('/tmp/test-repo/.github/workflows/code-review-agent.yml');
    expect(output.filesCreated).toContain(
      '/tmp/test-repo/.github/workflows/review-agent-rerun.yml',
    );
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await reviewAgentHarness.execute(ctx);

    expect(ctx.previousOutputs.has('review-agent')).toBe(true);
    const stored = ctx.previousOutputs.get('review-agent');
    expect(stored?.harnessName).toBe('review-agent');
  });

  it('should include metadata with correct reviewWorkflowPath', async () => {
    const ctx = createMockContext();
    const output = await reviewAgentHarness.execute(ctx);

    expect(output.metadata).toBeDefined();
    expect(output.metadata?.reviewWorkflowPath).toBe('.github/workflows/code-review-agent.yml');
  });

  it('should wrap errors with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue(new Error('Claude API timeout')),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(reviewAgentHarness.execute(ctx)).rejects.toThrow(
      'Review agent generation failed: Claude API timeout',
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

    await expect(reviewAgentHarness.execute(ctx)).rejects.toThrow(
      'Review agent generation failed: network failure',
    );
  });

  describe('Tier 1 notification in reference workflow', () => {
    it('should include Tier 1 skip notification step in the reference workflow', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('Notify PR — review agent skipped (Tier 1)');
    });

    it('should include SHA-deduped marker for Tier 1 skip', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('<!-- harness-tier1-skip:');
    });

    it('should include deduplication check before posting Tier 1 comment', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('comments.some((c) => c.body?.includes(marker))');
    });

    it('should include Tier 1 skip explanation in comment body', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('Review Agent — Skipped (Tier 1)');
      expect(prompt).toContain('Tier 1 change — review agent not required');
    });

    it('should read review prompt from .codefactory/prompts/review-agent.md', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('git show origin/main:.codefactory/prompts/review-agent.md');
      expect(prompt).not.toContain('git show origin/main:scripts/review-prompt.md');
    });

    it('should set correct permissions including issues: write and actions: write', async () => {
      const ctx = createMockContext();
      await reviewAgentHarness.execute(ctx);

      const [prompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(prompt).toContain('issues: write');
      expect(prompt).toContain('actions: write');
    });
  });
});
