import { CodexRunner } from '../../src/core/codex-runner.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createMockChild, mockSpawnWith } from './helpers/mock-child-process.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/utils/git.js', () => ({
  snapshotUntrackedFiles: vi.fn(),
  snapshotModifiedFiles: vi.fn(),
  diffWorkingTree: vi.fn(),
}));

import {
  snapshotUntrackedFiles,
  snapshotModifiedFiles,
  diffWorkingTree,
} from '../../src/utils/git.js';

const mockedSpawn = vi.mocked(spawn);
const mockedSnapshotUntrackedFiles = vi.mocked(snapshotUntrackedFiles);
const mockedSnapshotModifiedFiles = vi.mocked(snapshotModifiedFiles);
const mockedDiffWorkingTree = vi.mocked(diffWorkingTree);

describe('CodexRunner', () => {
  let runner: CodexRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new CodexRunner({ maxTurns: 5 });
    mockedSnapshotUntrackedFiles.mockReturnValue(new Set());
    mockedSnapshotModifiedFiles.mockReturnValue(new Set());
    mockedDiffWorkingTree.mockReturnValue({ created: [], modified: [] });
  });

  it('should have platform set to codex', () => {
    expect(runner.platform).toBe('codex');
  });

  describe('analyze()', () => {
    it('should parse JSON from CLI output', async () => {
      const expectedData = { name: 'test-project', language: 'python' };
      const schema = z.object({ name: z.string(), language: z.string() });

      mockSpawnWith(mockedSpawn, JSON.stringify(expectedData) + '\n');

      const result = await runner.analyze('Analyze this project', schema);
      expect(result).toEqual(expectedData);
    });

    it('should extract JSON from markdown code fences', async () => {
      const schema = z.object({ count: z.number() });

      mockSpawnWith(mockedSpawn, '```json\n{"count": 42}\n```\n');

      const result = await runner.analyze('Count items', schema);
      expect(result).toEqual({ count: 42 });
    });

    it('should pass correct CLI args to spawn', async () => {
      const schema = z.object({ ok: z.boolean() });
      mockSpawnWith(mockedSpawn, '{"ok": true}\n');

      await runner.analyze('Test prompt', schema);

      expect(mockedSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining([
          'exec',
          'Test prompt',
          '--approval-mode',
          'full-auto',
          '--quiet',
          '--max-turns',
          '5',
          '--system-prompt',
          expect.any(String),
        ]),
        expect.objectContaining({
          stdio: ['inherit', 'pipe', 'inherit'],
        }),
      );
    });

    it('should throw on invalid JSON in analyze response', async () => {
      mockSpawnWith(mockedSpawn, 'not valid json at all\n');

      const schema = z.object({ data: z.string() });
      await expect(runner.analyze('Test', schema)).rejects.toThrow();
    });
  });

  describe('generate()', () => {
    it('should track files via git-diff', async () => {
      mockedSnapshotUntrackedFiles.mockReturnValue(new Set());
      mockedSnapshotModifiedFiles.mockReturnValue(new Set());
      mockedDiffWorkingTree.mockReturnValue({
        created: ['harness.config.json', 'CODEX.md'],
        modified: ['package.json'],
      });

      mockSpawnWith(mockedSpawn, 'Done generating files.\n');

      const result = await runner.generate('Generate files');
      expect(result.filesCreated).toEqual(['harness.config.json', 'CODEX.md']);
      expect(result.filesModified).toEqual(['package.json']);
    });

    it('should pass correct CLI args for generate', async () => {
      mockSpawnWith(mockedSpawn, 'Done.\n');

      await runner.generate('Generate files');

      expect(mockedSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['exec', '--approval-mode', 'full-auto', '--quiet']),
        expect.objectContaining({
          stdio: ['inherit', 'pipe', 'inherit'],
        }),
      );
    });

    it('should snapshot untracked and modified files before running', async () => {
      mockSpawnWith(mockedSpawn, 'Done.\n');

      await runner.generate('Generate files');

      expect(mockedSnapshotUntrackedFiles).toHaveBeenCalled();
      expect(mockedSnapshotModifiedFiles).toHaveBeenCalled();
      expect(mockedDiffWorkingTree).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should reject when codex exits with non-zero code', async () => {
      mockSpawnWith(mockedSpawn, '\n', 1);

      const schema = z.object({ data: z.string() });
      await expect(runner.analyze('Test', schema)).rejects.toThrow('codex exited with code 1');
    });

    it('should reject when spawn fails', async () => {
      const child = createMockChild('', 0);
      mockedSpawn.mockReturnValue(child as any);

      const promise = runner.analyze('Test', z.object({ data: z.string() }));

      // Simulate spawn error
      setTimeout(() => child.emit('error', new Error('ENOENT')), 0);

      await expect(promise).rejects.toThrow('Failed to spawn codex');
    });
  });
});
