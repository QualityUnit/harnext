import { ClaudeRunner } from '../../src/core/claude-runner.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createMockChild, mockSpawnWith } from './helpers/mock-child-process.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

describe('ClaudeRunner', () => {
  let runner: ClaudeRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new ClaudeRunner({ maxTurns: 5 });
  });

  it('should have platform set to claude', () => {
    expect(runner.platform).toBe('claude');
  });

  describe('analyze()', () => {
    it('should parse JSON from result message', async () => {
      const expectedData = { name: 'test-project', language: 'typescript' };
      const schema = z.object({ name: z.string(), language: z.string() });

      const resultMsg = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: JSON.stringify(expectedData),
      });
      mockSpawnWith(mockedSpawn, resultMsg + '\n');

      const result = await runner.analyze('Analyze this project', schema);
      expect(result).toEqual(expectedData);
    });

    it('should extract JSON from markdown code fences', async () => {
      const schema = z.object({ count: z.number() });

      const resultMsg = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '```json\n{"count": 42}\n```',
      });
      mockSpawnWith(mockedSpawn, resultMsg + '\n');

      const result = await runner.analyze('Count items', schema);
      expect(result).toEqual({ count: 42 });
    });

    it('should throw when no response is received', async () => {
      mockSpawnWith(mockedSpawn, '\n');

      const schema = z.object({ data: z.string() });
      await expect(runner.analyze('Test', schema)).rejects.toThrow();
    });

    it('should pass correct CLI args to spawn', async () => {
      const schema = z.object({ ok: z.boolean() });
      const resultMsg = JSON.stringify({
        type: 'result',
        result: '{"ok": true}',
      });
      mockSpawnWith(mockedSpawn, resultMsg + '\n');

      await runner.analyze('Test prompt', schema);

      expect(mockedSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining([
          '--print',
          '--output-format',
          'stream-json',
          '--max-turns',
          '5',
          '--permission-mode',
          'bypassPermissions',
        ]),
        expect.objectContaining({
          stdio: ['inherit', 'pipe', 'inherit'],
        }),
      );
    });
  });

  describe('generate()', () => {
    it('should track created files from Write tool_use blocks', async () => {
      const msg = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/project/harness.config.json', content: '{}' },
            },
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/project/CLAUDE.md', content: '# CLAUDE' },
            },
          ],
        },
      });
      mockSpawnWith(mockedSpawn, msg + '\n');

      const result = await runner.generate('Generate files');
      expect(result.filesCreated).toContain('/project/harness.config.json');
      expect(result.filesCreated).toContain('/project/CLAUDE.md');
      expect(result.filesModified).toEqual([]);
    });

    it('should track modified files from Edit tool_use blocks', async () => {
      const msg = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/project/package.json', old_string: '"a"', new_string: '"b"' },
            },
          ],
        },
      });
      mockSpawnWith(mockedSpawn, msg + '\n');

      const result = await runner.generate('Modify files');
      expect(result.filesModified).toContain('/project/package.json');
      expect(result.filesCreated).toEqual([]);
    });

    it('should deduplicate files that appear in both Write and Edit', async () => {
      const msg = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/project/config.json', content: '{}' },
            },
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/project/config.json', old_string: '{}', new_string: '{"a":1}' },
            },
          ],
        },
      });
      mockSpawnWith(mockedSpawn, msg + '\n');

      const result = await runner.generate('Create and modify');
      expect(result.filesCreated).toContain('/project/config.json');
      expect(result.filesModified).not.toContain('/project/config.json');
    });
  });

  describe('error handling', () => {
    it('should reject when claude exits with non-zero code', async () => {
      mockSpawnWith(mockedSpawn, '\n', 1);

      const schema = z.object({ data: z.string() });
      await expect(runner.analyze('Test', schema)).rejects.toThrow('Claude exited with code 1');
    });

    it('should throw on invalid JSON in analyze response', async () => {
      const resultMsg = JSON.stringify({
        type: 'result',
        result: 'not valid json at all',
      });
      mockSpawnWith(mockedSpawn, resultMsg + '\n');

      const schema = z.object({ data: z.string() });
      await expect(runner.analyze('Test', schema)).rejects.toThrow();
    });

    it('should reject when spawn fails', async () => {
      const child = createMockChild('', 0);
      mockedSpawn.mockReturnValue(child as any);

      const promise = runner.analyze('Test', z.object({ data: z.string() }));

      setTimeout(() => child.emit('error', new Error('ENOENT')), 0);

      await expect(promise).rejects.toThrow('Failed to spawn Claude CLI');
    });
  });
});
