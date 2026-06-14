import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Real-binary E2E for `--input-format stream-json`: spawns the *built* CLI as a
 * subprocess and exercises the streaming-input plumbing end to end — argv
 * parsing → streaming loop → NDJSON envelopes on stdout. A dummy API key gets
 * past auth; empty stdin means no model call, so the run is deterministic and
 * needs no network. The steering behavior itself is covered deterministically
 * by streaming-print-steering.e2e.test.ts (in-process, gated fake stream).
 */
const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('stream-json CLI (real binary, e2e)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-cli-e2e-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(BIN))(
    'emits a system/init envelope and exits 0 on empty stream-json input',
    async () => {
      const child = spawn(
        process.execPath,
        [
          BIN,
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--provider',
          'anthropic',
          '-m',
          'claude-sonnet-4-6',
        ],
        {
          env: {
            ...process.env,
            HARNEXT_HOME: home,
            ANTHROPIC_API_KEY: 'sk-e2e-dummy-unused',
            HARNEXT_DISABLE_BACKGROUND_TASKS: '1',
          },
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      );

      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));

      // No messages: close stdin immediately → EOF → no run → clean exit.
      child.stdin.end();

      const code: number = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('CLI did not exit within 30s'));
        }, 30_000);
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c ?? -1);
        });
        child.on('error', reject);
      });

      const envelopes = stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));

      expect(code).toBe(0);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({ type: 'system', subtype: 'init' });
      // No user input → no run → no result envelope.
      expect(envelopes.some((e) => e.type === 'result')).toBe(false);
    },
    40_000,
  );
});
