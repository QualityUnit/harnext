import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maskToolResultContent } from '../src/pii/masker.js';
import type { PiiMasker, MaskResult } from '../src/pii/masker.js';
import { createReadTool } from '../src/tools/read.js';

// Stub masker that replaces digit-bearing words. Avoids loading transformers.js.
function stubMasker(): PiiMasker {
  return {
    ready: async () => undefined,
    mask: async (text: string): Promise<MaskResult> => ({
      masked: text.replace(/\b\w*\d\w*\b/g, '[DIGIT]'),
      entities: [],
    }),
    dispose: () => undefined,
  };
}

describe('secure-mode read tool result anonymization', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'harnext-secure-read-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // Reproduces the bug: in secure mode the user prompt is masked, but the read
  // tool's `execute` returns raw file content. Without an `afterToolCall` hook,
  // that raw text is what gets stored in the transcript and shipped to the LLM.
  it('read tool returns unmasked file content (the bug)', async () => {
    const file = join(workDir, 'secret.txt');
    writeFileSync(file, 'card 4242-1111-2222-3333\nphone 555-1234');
    const read = createReadTool(workDir);
    const result = await read.execute('call-1', { path: 'secret.txt' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('4242-1111-2222-3333');
    expect(text).toContain('555-1234');
  });

  // Verifies the fix: passing the same result through `maskToolResultContent`
  // — which is what `afterToolCall` does in interactive secure mode — strips
  // PII before the content is forwarded.
  it('masks read tool content via maskToolResultContent', async () => {
    const file = join(workDir, 'secret.txt');
    writeFileSync(file, 'card 4242-1111-2222-3333\nphone 555-1234');
    const read = createReadTool(workDir);
    const result = await read.execute('call-1', { path: 'secret.txt' });

    const masked = await maskToolResultContent(result.content, stubMasker());
    const text = (masked[0] as { text: string }).text;
    expect(text).not.toContain('4242-1111');
    expect(text).not.toContain('555-1234');
    expect(text).toContain('[DIGIT]');
  });
});
