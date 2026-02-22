import { issuePlannerHarness } from '../../../src/harnesses/issue-planner.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { DetectionResult } from '../../../src/core/detector.js';

vi.mock('../../../src/prompts/issue-planner.js', () => ({
  buildIssuePlannerPrompt: vi.fn().mockReturnValue('mocked issue planner prompt'),
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
          '/tmp/test-repo/.github/workflows/issue-planner.yml',
          '/tmp/test-repo/scripts/issue-planner-guard.ts',
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
      selectedHarnesses: ['issue-planner'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('issuePlannerHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(issuePlannerHarness.name).toBe('issue-planner');
    expect(issuePlannerHarness.displayName).toBe('Issue Planner Agent');
    expect(issuePlannerHarness.order).toBe(15);
  });

  it('isApplicable should return true', () => {
    const ctx = createMockContext();
    expect(issuePlannerHarness.isApplicable(ctx)).toBe(true);
  });

  it('should call runner.generate with the prompt containing reference content', async () => {
    const ctx = createMockContext();
    await issuePlannerHarness.execute(ctx);

    expect(ctx.runner.generate).toHaveBeenCalledOnce();
    const [prompt, systemPrompt] = (ctx.runner.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain('mocked issue planner prompt');
    expect(prompt).toContain('## Reference Implementation');
    expect(prompt).toContain('### Reference: .github/workflows/issue-planner.yml');
    expect(prompt).toContain('### Reference: scripts/issue-planner-guard.ts');
    expect(prompt).toContain('### Reference: .codefactory/prompts/issue-planner.md');
    expect(systemPrompt).toBe('mocked system prompt');
  });

  it('should return correct output with filesCreated', async () => {
    const ctx = createMockContext();
    const output = await issuePlannerHarness.execute(ctx);

    expect(output.harnessName).toBe('issue-planner');
    expect(output.filesCreated).toContain('/tmp/test-repo/.github/workflows/issue-planner.yml');
    expect(output.filesCreated).toContain('/tmp/test-repo/scripts/issue-planner-guard.ts');
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await issuePlannerHarness.execute(ctx);

    expect(ctx.previousOutputs.has('issue-planner')).toBe(true);
    const stored = ctx.previousOutputs.get('issue-planner');
    expect(stored?.harnessName).toBe('issue-planner');
  });

  it('should include metadata with workflowPath', async () => {
    const ctx = createMockContext();
    const output = await issuePlannerHarness.execute(ctx);

    expect(output.metadata).toBeDefined();
    expect(output.metadata?.workflowPath).toBe('.github/workflows/issue-planner.yml');
  });

  it('should wrap errors with descriptive message', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn().mockRejectedValue(new Error('Claude API timeout')),
        analyze: vi.fn(),
        platform: 'claude' as const,
      } as unknown as AIRunner,
    });

    await expect(issuePlannerHarness.execute(ctx)).rejects.toThrow(
      'Issue planner generation failed: Claude API timeout',
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

    await expect(issuePlannerHarness.execute(ctx)).rejects.toThrow(
      'Issue planner generation failed: network failure',
    );
  });
});
