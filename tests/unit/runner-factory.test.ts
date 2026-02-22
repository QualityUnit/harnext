import { createRunner, validatePlatformCLI } from '../../src/core/runner-factory.js';
import { ClaudeRunner } from '../../src/core/claude-runner.js';
import { KiroRunner } from '../../src/core/kiro-runner.js';
import { CodexRunner } from '../../src/core/codex-runner.js';
import { PlatformCLINotFoundError } from '../../src/utils/errors.js';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const mockedExecFileSync = vi.mocked(execFileSync);

describe('createRunner', () => {
  it('should return ClaudeRunner for claude platform', () => {
    const runner = createRunner('claude');
    expect(runner).toBeInstanceOf(ClaudeRunner);
    expect(runner.platform).toBe('claude');
  });

  it('should return KiroRunner for kiro platform', () => {
    const runner = createRunner('kiro');
    expect(runner).toBeInstanceOf(KiroRunner);
    expect(runner.platform).toBe('kiro');
  });

  it('should return CodexRunner for codex platform', () => {
    const runner = createRunner('codex');
    expect(runner).toBeInstanceOf(CodexRunner);
    expect(runner.platform).toBe('codex');
  });

  it('should throw for invalid platform', () => {
    // @ts-expect-error Testing invalid platform value
    expect(() => createRunner('invalid')).toThrow('Unknown AI platform');
  });

  it('should pass options through to the runner', () => {
    const runner = createRunner('claude', { cwd: '/tmp/test', maxTurns: 10 });
    expect(runner).toBeInstanceOf(ClaudeRunner);
  });
});

describe('validatePlatformCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not throw when CLI binary is found', () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
    expect(() => validatePlatformCLI('claude')).not.toThrow();
    const expectedCmd = process.platform === 'win32' ? 'where' : 'which';
    expect(mockedExecFileSync).toHaveBeenCalledWith(expectedCmd, ['claude'], { stdio: 'ignore' });
  });

  it('should throw PlatformCLINotFoundError when CLI binary is not found', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(() => validatePlatformCLI('kiro')).toThrow(PlatformCLINotFoundError);
    expect(() => validatePlatformCLI('kiro')).toThrow('kiro-cli CLI not found in PATH');
  });

  it('should use "where" on Windows to locate binaries', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });

    try {
      mockedExecFileSync.mockReturnValue(Buffer.from('C:\\Program Files\\claude\\claude.exe'));
      expect(() => validatePlatformCLI('claude')).not.toThrow();
      expect(mockedExecFileSync).toHaveBeenCalledWith('where', ['claude'], { stdio: 'ignore' });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    }
  });

  it('should include install instructions in error message', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    try {
      validatePlatformCLI('codex');
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformCLINotFoundError);
      expect((error as PlatformCLINotFoundError).platform).toBe('codex');
      expect((error as PlatformCLINotFoundError).binary).toBe('codex');
      expect((error as PlatformCLINotFoundError).message).toContain('npm install -g @openai/codex');
    }
  });
});
