import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so these are available inside vi.mock factories (which are hoisted above imports).
const { mockPromptStoreInstance, MockPromptStore } = vi.hoisted(() => {
  const mockPromptStoreInstance = {
    ensureDefaults: vi.fn(),
    list: vi
      .fn()
      .mockReturnValue([
        { name: 'agent-system', displayName: 'Agent System', description: 'desc' },
      ]),
    getPath: vi.fn().mockReturnValue('/tmp/test/.codefactory/prompts/agent-system.md'),
    read: vi.fn().mockResolvedValue('prompt content'),
    write: vi.fn(),
    resetToDefault: vi.fn(),
    isCustomized: vi.fn().mockResolvedValue(false),
  };

  const MockPromptStore = vi.fn().mockImplementation(() => mockPromptStoreInstance);

  return { mockPromptStoreInstance, MockPromptStore };
});

const { mockedBorderedInput } = vi.hoisted(() => ({
  mockedBorderedInput: vi.fn(),
}));

// Mock all external dependencies BEFORE importing the module under test

vi.mock('../../src/ui/logger.js', () => ({
  logger: {
    header: vi.fn(),
    dim: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/ui/banner.js', () => ({
  printBanner: vi.fn(),
}));

vi.mock('../../src/ui/spinner.js', () => ({
  withSpinner: vi.fn((_text: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/ui/prompts.js', () => ({
  inputPrompt: vi.fn(),
  selectPrompt: vi.fn(),
  confirmPrompt: vi.fn(),
}));

vi.mock('../../src/ui/bordered-input.js', () => ({
  borderedInput: mockedBorderedInput,
}));

vi.mock('../../src/utils/git.js', () => ({
  isGitRepo: vi.fn(),
  getRepoRoot: vi.fn(),
  hasUncommittedChanges: vi.fn(),
}));

vi.mock('../../src/utils/fs.js', () => ({
  readFileIfExists: vi.fn(),
  fileExists: vi.fn(),
}));

// Mock execFileSync so that the claude CLI check works.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/prompt-store.js', () => ({
  PromptStore: MockPromptStore,
}));

vi.mock('../../src/core/worktree.js', () => ({
  generateBranchName: vi.fn().mockResolvedValue('cf/feat/test-abc123'),
  createWorktree: vi.fn().mockResolvedValue({
    path: '/tmp/worktree',
    branchName: 'cf/feat/test',
  }),
}));

vi.mock('../../src/core/terminal.js', () => ({
  openInNewTerminal: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isGitRepo, getRepoRoot, hasUncommittedChanges } from '../../src/utils/git.js';
import { inputPrompt, selectPrompt, confirmPrompt } from '../../src/ui/prompts.js';
import { replCommand } from '../../src/commands/repl.js';
import { NotAGitRepoError, PlatformCLINotFoundError } from '../../src/utils/errors.js';
import { createWorktree } from '../../src/core/worktree.js';
import { openInNewTerminal } from '../../src/core/terminal.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedIsGitRepo = vi.mocked(isGitRepo);
const mockedGetRepoRoot = vi.mocked(getRepoRoot);
const mockedHasUncommittedChanges = vi.mocked(hasUncommittedChanges);
const mockedInputPrompt = vi.mocked(inputPrompt);
const mockedSelectPrompt = vi.mocked(selectPrompt);
const mockedConfirmPrompt = vi.mocked(confirmPrompt);
const mockedCreateWorktree = vi.mocked(createWorktree);
const mockedOpenInNewTerminal = vi.mocked(openInNewTerminal);
const mockedWriteFile = vi.mocked(writeFile);

describe('replCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock process.exit so the REPL loop can be broken without killing the test runner.
    // We throw an error so the test can catch and assert on exit behavior.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('should throw NotAGitRepoError when not in a git repo', async () => {
    mockedIsGitRepo.mockResolvedValue(false);

    await expect(replCommand()).rejects.toThrow(NotAGitRepoError);
    expect(mockedIsGitRepo).toHaveBeenCalledOnce();
  });

  it('should throw PlatformCLINotFoundError when claude is not installed', async () => {
    mockedIsGitRepo.mockResolvedValue(true);

    // Make execFileSync throw (simulates `which claude` failing)
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    await expect(replCommand()).rejects.toThrow(PlatformCLINotFoundError);
  });

  /**
   * Helper: configure mocks so replCommand gets past startup checks
   * and enters the main loop. borderedInput must be configured by each test.
   */
  function setupReplStartup(repoRoot = '/fake/repo'): void {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetRepoRoot.mockResolvedValue(repoRoot);
    mockedExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
  }

  /** Throw ExitPromptError to break out of the REPL loop. */
  function makeExitPromptError(): Error {
    const err = new Error('exit');
    err.name = 'ExitPromptError';
    Object.defineProperty(err.constructor, 'name', { value: 'ExitPromptError' });
    return err;
  }

  it('should initialize PromptStore on start', async () => {
    setupReplStartup();
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    expect(MockPromptStore).toHaveBeenCalledWith('/fake/repo');
    expect(mockPromptStoreInstance.ensureDefaults).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should write shell-escaped paths in launcher script (happy path)', async () => {
    setupReplStartup();
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedInputPrompt.mockResolvedValue('feat/my-feature');
    mockedConfirmPrompt.mockResolvedValue(true);
    mockedCreateWorktree.mockResolvedValue({
      path: '/tmp/worktrees/feat/my-feature',
      branchName: 'feat/my-feature',
    });
    mockPromptStoreInstance.read.mockResolvedValue('system prompt {{branchName}} {{qualityGates}}');
    mockedOpenInNewTerminal.mockResolvedValue(undefined);

    // First call returns a task, second call exits
    mockedBorderedInput.mockResolvedValueOnce('implement login page');
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    // Verify writeFile was called for the launcher script (3rd call: prompt, task, launcher)
    const writeFileCalls = mockedWriteFile.mock.calls;
    const launcherCall = writeFileCalls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('launch.sh'),
    );
    expect(launcherCall).toBeDefined();

    const scriptContent = launcherCall![1] as string;
    // Paths must be single-quoted to prevent command injection
    expect(scriptContent).toContain(
      "PROMPT=$(<'/tmp/worktrees/feat/my-feature/.codefactory/system-prompt')",
    );
    expect(scriptContent).toContain("TASK=$(<'/tmp/worktrees/feat/my-feature/.codefactory/task')");

    // Verify openInNewTerminal was called with single-quoted launcher path
    expect(mockedOpenInNewTerminal).toHaveBeenCalledWith(
      "bash '/tmp/worktrees/feat/my-feature/.codefactory/launch.sh'",
      '/tmp/worktrees/feat/my-feature',
    );
  });

  it('should escape paths with special characters to prevent command injection', async () => {
    setupReplStartup();
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedInputPrompt.mockResolvedValue('feat/$(malicious-cmd)');
    mockedConfirmPrompt.mockResolvedValue(true);
    mockedCreateWorktree.mockResolvedValue({
      path: '/tmp/worktrees/feat/$(malicious-cmd)',
      branchName: 'feat/$(malicious-cmd)',
    });
    mockPromptStoreInstance.read.mockResolvedValue('system prompt {{branchName}}');
    mockedOpenInNewTerminal.mockResolvedValue(undefined);

    mockedBorderedInput.mockResolvedValueOnce('exploit test');
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    const writeFileCalls = mockedWriteFile.mock.calls;
    const launcherCall = writeFileCalls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('launch.sh'),
    );
    expect(launcherCall).toBeDefined();

    const scriptContent = launcherCall![1] as string;
    // Single quotes prevent $(malicious-cmd) from being expanded by bash
    expect(scriptContent).toContain(
      "PROMPT=$(<'/tmp/worktrees/feat/$(malicious-cmd)/.codefactory/system-prompt')",
    );
    expect(scriptContent).toContain(
      "TASK=$(<'/tmp/worktrees/feat/$(malicious-cmd)/.codefactory/task')",
    );
    // Must NOT contain double-quoted paths that would allow expansion
    expect(scriptContent).not.toMatch(/PROMPT=\$\(<"/);
    expect(scriptContent).not.toMatch(/TASK=\$\(<"/);
  });

  it('should escape paths containing single quotes', async () => {
    setupReplStartup();
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedInputPrompt.mockResolvedValue("feat/it's-a-test");
    mockedConfirmPrompt.mockResolvedValue(true);
    mockedCreateWorktree.mockResolvedValue({
      path: "/tmp/worktrees/feat/it's-a-test",
      branchName: "feat/it's-a-test",
    });
    mockPromptStoreInstance.read.mockResolvedValue('system prompt');
    mockedOpenInNewTerminal.mockResolvedValue(undefined);

    mockedBorderedInput.mockResolvedValueOnce('quote test');
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    const writeFileCalls = mockedWriteFile.mock.calls;
    const launcherCall = writeFileCalls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('launch.sh'),
    );
    expect(launcherCall).toBeDefined();

    const scriptContent = launcherCall![1] as string;
    // Single quotes in path must be escaped as '\'' so the overall single-quoted
    // string remains valid bash
    expect(scriptContent).toContain("it'\\''s-a-test");
  });

  it('should pass commands array to borderedInput', async () => {
    setupReplStartup();
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    expect(mockedBorderedInput).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: expect.arrayContaining([
          expect.objectContaining({ name: 'agent-system' }),
          expect.objectContaining({ name: 'init' }),
          expect.objectContaining({ name: 'help' }),
          expect.objectContaining({ name: 'exit' }),
        ]),
      }),
    );
  });

  it('should execute exact slash command without showing selectPrompt', async () => {
    setupReplStartup();

    // User types /exit (exact match)
    mockedBorderedInput.mockResolvedValueOnce('/exit');

    await expect(replCommand()).rejects.toThrow('process.exit');

    // selectPrompt should NOT have been called because /exit is an exact match
    expect(mockedSelectPrompt).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('should skip empty input without error', async () => {
    setupReplStartup();

    // First call returns empty string, second call exits
    mockedBorderedInput.mockResolvedValueOnce('');
    mockedBorderedInput.mockRejectedValueOnce(makeExitPromptError());

    await expect(replCommand()).rejects.toThrow('process.exit');

    // borderedInput was called twice (empty input → loop continues → exit)
    expect(mockedBorderedInput).toHaveBeenCalledTimes(2);
  });
});
