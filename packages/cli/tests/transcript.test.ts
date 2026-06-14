import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import { renderTranscript } from '../src/modes/interactive/transcript.js';
import { stripAnsi } from '../src/modes/interactive/render.js';

function plain(messages: AgentMessage[]): string {
  return stripAnsi(renderTranscript(messages));
}

describe('renderTranscript', () => {
  it('renders user prompts and assistant replies', () => {
    const out = plain([
      { role: 'user', content: 'fix the bug', timestamp: 1 } as AgentMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'On it — looking now.' }],
        timestamp: 2,
      } as AgentMessage,
    ]);
    expect(out).toContain('resumed conversation');
    expect(out).toContain('fix the bug');
    expect(out).toContain('On it — looking now.');
  });

  it('renders tool calls with their badge and output body', () => {
    const out = plain([
      { role: 'user', content: 'list files', timestamp: 1 } as AgentMessage,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 2,
      } as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'a.ts\nb.ts' }],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
    ]);
    expect(out).toContain('bash');
    expect(out).toContain('$ ls');
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
  });

  it('strips a leading system-reminder from the displayed user prompt', () => {
    const out = plain([
      {
        role: 'user',
        content: '<system-reminder>plan mode</system-reminder>\n\nrefactor auth',
        timestamp: 1,
      } as AgentMessage,
    ]);
    expect(out).toContain('refactor auth');
    expect(out).not.toContain('system-reminder');
  });

  it('renders a compaction summary as a dim block', () => {
    const out = plain([
      {
        role: 'user',
        content: '[Compacted summary of earlier conversation]\n\n## Goal\nbuild a CLI',
        timestamp: 1,
      } as AgentMessage,
    ]);
    expect(out).toContain('compacted summary of earlier conversation');
    expect(out).toContain('build a CLI');
  });

  it('returns empty string for an empty transcript', () => {
    expect(renderTranscript([])).toBe('');
  });
});
