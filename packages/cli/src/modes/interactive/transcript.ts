/**
 * Replays a stored transcript into the scrollback when a session is resumed,
 * so the user can see the prior conversation instead of an empty screen.
 *
 * Reuses the exact same render helpers the live loop uses (user echo, tool
 * badges + bodies, markdown-styled assistant text), so a replayed turn looks
 * identical to how it looked when it first streamed.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import chalk from 'chalk';

import { createMarkdownStreamer } from './markdown-stream.js';
import * as render from './render.js';

const COMPACTED_MARKER = '[Compacted summary of earlier conversation]';

/** Plain text of a user message's content (text parts only). */
function userText(message: UserMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

/** Drop a leading `<system-reminder>…</system-reminder>` block (plan-mode prefix). */
function stripSystemReminder(text: string): string {
  return text.replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '').trimStart();
}

/** Render the assistant's prose with the same markdown styling as the live stream. */
function renderAssistantText(text: string): string {
  const md = createMarkdownStreamer();
  return (md.feed(text) + md.flush()).replace(/\n+$/, '');
}

function renderCompactedBlock(text: string): string {
  const summary = text.slice(COMPACTED_MARKER.length).trim();
  const lines = [chalk.dim('  ⟲ compacted summary of earlier conversation')];
  for (const line of summary.split('\n')) lines.push(chalk.dim('  ' + line));
  return lines.join('\n');
}

/**
 * Render the full `messages` transcript to a single string, ready to write
 * above the input. Blocks are separated by blank lines to match the live UI.
 */
export function renderTranscript(messages: AgentMessage[]): string {
  // Tool args live on the assistant's toolCall blocks; the later toolResult
  // message only carries the id. Map id → {name, args} so the result body can
  // render its diff/output exactly like it did live.
  const toolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const block of (m as AssistantMessage).content) {
      if (block.type === 'toolCall') {
        toolCalls.set(block.id, {
          name: block.name,
          args: (block.arguments as Record<string, unknown> | undefined) ?? {},
        });
      }
    }
  }

  const blocks: string[] = [];

  for (const m of messages) {
    if (m.role === 'user') {
      const raw = userText(m as UserMessage);
      if (raw.startsWith(COMPACTED_MARKER)) {
        blocks.push(renderCompactedBlock(raw));
        continue;
      }
      const text = stripSystemReminder(raw).trim();
      if (text) blocks.push(render.userMessage(text));
    } else if (m.role === 'assistant') {
      const asst = m as AssistantMessage;
      const text = asst.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      if (text.trim()) blocks.push(renderAssistantText(text));
      for (const block of asst.content) {
        if (block.type === 'toolCall') {
          const args = (block.arguments as Record<string, unknown> | undefined) ?? {};
          blocks.push(render.toolStart(block.name, args));
        }
      }
    } else if (m.role === 'toolResult') {
      const tr = m as ToolResultMessage;
      const call = toolCalls.get(tr.toolCallId);
      const name = call?.name ?? tr.toolName ?? '';
      const args = call?.args ?? {};
      const resultText = tr.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text?: string }).text ?? '')
        .join('\n');
      const body = render.toolEnd(name, args, resultText, !!tr.isError);
      if (body) blocks.push(body);
    }
  }

  if (blocks.length === 0) return '';
  const header = chalk.dim('  ─── resumed conversation ───');
  return '\n' + header + '\n\n' + blocks.join('\n\n') + '\n';
}
