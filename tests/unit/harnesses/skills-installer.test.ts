import { join } from 'node:path';

import { skillsInstallerHarness } from '../../../src/harnesses/skills-installer.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import type { AIRunner } from '../../../src/core/ai-runner.js';
import type { FileWriter } from '../../../src/core/file-writer.js';
import type { DetectionResult } from '../../../src/core/detector.js';

function createMockFileWriter(
  created: string[] = [],
  modified: string[] = [],
): jest.Mocked<FileWriter> {
  const createdSet = new Set(created);
  const modifiedSet = new Set(modified);

  const snapCreated = new Set<string>();
  const snapModified = new Set<string>();

  const writer = {
    write: vi.fn(async (filePath: string) => {
      createdSet.add(filePath);
    }),
    append: vi.fn(),
    snapshot: vi.fn(() => ({ created: snapCreated, modified: snapModified })),
    diffSince: vi.fn((snap: { created: Set<string>; modified: Set<string> }) => ({
      created: [...createdSet].filter((f) => !snap.created.has(f)),
      modified: [...modifiedSet].filter((f) => !snap.modified.has(f)),
    })),
    getCreatedFiles: vi.fn(() => [...createdSet]),
    getModifiedFiles: vi.fn(() => [...modifiedSet]),
    getSummary: vi.fn(() => ({ created: [...createdSet], modified: [...modifiedSet] })),
  } as unknown as jest.Mocked<FileWriter>;

  return writer;
}

function createMockContext(overrides?: Partial<HarnessContext>): HarnessContext {
  const detection: DetectionResult = {
    primaryLanguage: 'typescript',
    framework: null,
    packageManager: 'npm',
    testFramework: 'vitest',
    linter: 'eslint',
    formatter: 'prettier',
    typeChecker: 'tsc',
    buildTool: 'tsup',
    ciProvider: 'github-actions',
    existingDocs: [],
    existingClaude: false,
    architecturalLayers: [],
    monorepo: false,
    testCommand: 'npm test',
    buildCommand: 'npm run build',
    lintCommand: 'npm run lint',
    hasUIComponents: false,
    criticalPaths: [],
  };

  return {
    repoRoot: '/tmp/test-repo',
    detection,
    runner: {
      generate: vi.fn(),
      analyze: vi.fn(),
      platform: 'claude' as const,
    } as unknown as AIRunner,
    fileWriter: createMockFileWriter(),
    userPreferences: {
      ciProvider: 'github-actions',
      strictnessLevel: 'standard',
      selectedHarnesses: ['skills-installer'],
      aiPlatform: 'claude' as const,
    },
    previousOutputs: new Map(),
    ...overrides,
  };
}

describe('skillsInstallerHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(skillsInstallerHarness.name).toBe('skills-installer');
    expect(skillsInstallerHarness.displayName).toBe('Skills Installer');
    expect(skillsInstallerHarness.order).toBe(17);
  });

  it('isApplicable should return true', () => {
    const ctx = createMockContext();
    expect(skillsInstallerHarness.isApplicable(ctx)).toBe(true);
  });

  it('should write check-docs and chrome-devtools SKILL.md files', async () => {
    const ctx = createMockContext();
    await skillsInstallerHarness.execute(ctx);

    expect(ctx.fileWriter.write).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(ctx.fileWriter.write).mock.calls;
    const paths = calls.map((c) => c[0]);

    expect(paths).toContain(join('/tmp/test-repo', '.claude', 'skills', 'check-docs', 'SKILL.md'));
    expect(paths).toContain(
      join('/tmp/test-repo', '.claude', 'skills', 'chrome-devtools', 'SKILL.md'),
    );
  });

  it('should write correct check-docs content', async () => {
    const ctx = createMockContext();
    await skillsInstallerHarness.execute(ctx);

    const calls = vi.mocked(ctx.fileWriter.write).mock.calls;
    const checkDocsCall = calls.find((c) => c[0].endsWith(join('check-docs', 'SKILL.md')));

    expect(checkDocsCall).toBeDefined();
    expect(checkDocsCall![1]).toContain('name: check-docs');
    expect(checkDocsCall![1]).toContain('Check Documentation First');
  });

  it('should write correct chrome-devtools content', async () => {
    const ctx = createMockContext();
    await skillsInstallerHarness.execute(ctx);

    const calls = vi.mocked(ctx.fileWriter.write).mock.calls;
    const chromeCall = calls.find((c) => c[0].endsWith(join('chrome-devtools', 'SKILL.md')));

    expect(chromeCall).toBeDefined();
    expect(chromeCall![1]).toContain('name: chrome-devtools');
    expect(chromeCall![1]).toContain('Chrome DevTools MCP');
  });

  it('should store output in previousOutputs map', async () => {
    const ctx = createMockContext();
    await skillsInstallerHarness.execute(ctx);

    expect(ctx.previousOutputs.has('skills-installer')).toBe(true);
    const stored = ctx.previousOutputs.get('skills-installer');
    expect(stored?.harnessName).toBe('skills-installer');
  });

  it('should include skillsInstalled in metadata', async () => {
    const ctx = createMockContext();
    const output = await skillsInstallerHarness.execute(ctx);

    expect(output.metadata?.skillsInstalled).toEqual(['check-docs', 'chrome-devtools']);
  });

  it('should use platform-specific instruction file in check-docs skill', async () => {
    const ctx = createMockContext({
      runner: {
        generate: vi.fn(),
        analyze: vi.fn(),
        platform: 'kiro' as const,
      } as unknown as AIRunner,
    });
    await skillsInstallerHarness.execute(ctx);

    const calls = vi.mocked(ctx.fileWriter.write).mock.calls;
    const checkDocsCall = calls.find((c) => c[0].endsWith(join('check-docs', 'SKILL.md')));
    expect(checkDocsCall).toBeDefined();
    expect(checkDocsCall![1]).toContain('KIRO.md');
    expect(checkDocsCall![1]).not.toContain('Claude Code Docs Section');
  });

  it('should not call runner.generate', async () => {
    const ctx = createMockContext();
    await skillsInstallerHarness.execute(ctx);

    expect(ctx.runner.generate).not.toHaveBeenCalled();
  });
});
