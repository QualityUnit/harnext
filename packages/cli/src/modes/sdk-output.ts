/**
 * Serializers that convert harnext agent events/messages into the exact
 * stream-json envelope shapes the Claude Agent SDK emits, so the Python SDK's
 * parser is a thin mapping layer.
 *
 * Envelope reference:
 *   {"type":"system","subtype":"init", ...}
 *   {"type":"assistant","message":{...},"session_id":...}
 *   {"type":"user","message":{content:[tool_result...]},"session_id":...}
 *   {"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution", ...}
 */

import { canonicalToolName, type AgentSession } from '@harnext/core';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ResultSubtype = 'success' | 'error_max_turns' | 'error_during_execution';

interface SdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Map a harnext pi-ai Usage object to the Claude SDK usage shape. */
export function mapUsage(usage: any): SdkUsage {
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    cache_read_input_tokens: usage?.cacheRead ?? 0,
    cache_creation_input_tokens: usage?.cacheWrite ?? 0,
  };
}

/** Concatenate the text of a content array (text blocks only). */
export function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/** Convert a harnext assistant message's content array to SDK content blocks. */
export function mapAssistantContent(content: any[]): any[] {
  const blocks: any[] = [];
  for (const part of content ?? []) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text ?? '' });
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', thinking: part.thinking ?? '' });
        break;
      case 'toolCall':
        blocks.push({
          type: 'tool_use',
          id: part.id,
          name: canonicalToolName(part.name ?? ''),
          input: part.arguments ?? {},
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/** Build the `system`/`init` envelope emitted once at session start. */
export function buildInitEnvelope(session: AgentSession, cwd: string, permissionMode?: string): any {
  return {
    type: 'system',
    subtype: 'init',
    session_id: session.sessionId,
    model: session.model.id,
    cwd,
    tools: session.tools.map((t) => canonicalToolName(t.name)),
    permissionMode: permissionMode ?? 'default',
  };
}

/** Build an `assistant` envelope from a harnext assistant message. */
export function buildAssistantEnvelope(message: any, sessionId: string): any {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      model: message.model,
      content: mapAssistantContent(message.content ?? []),
      usage: message.usage ? mapUsage(message.usage) : undefined,
      stop_reason: message.stopReason,
    },
  };
}

/** Build a `user` envelope carrying a single tool_result, from a tool_execution_end event. */
export function buildToolResultEnvelope(
  toolCallId: string,
  result: any,
  isError: boolean,
  sessionId: string,
): any {
  return {
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: extractText(result?.content),
          is_error: isError,
        },
      ],
    },
  };
}

export interface ResultEnvelopeInput {
  subtype: ResultSubtype;
  resultText: string;
  sessionId: string;
  numTurns: number;
  durationMs: number;
  usage: SdkUsage;
  totalCostUsd: number;
}

/** Build the terminal `result` envelope. */
export function buildResultEnvelope(input: ResultEnvelopeInput): any {
  return {
    type: 'result',
    subtype: input.subtype,
    is_error: input.subtype !== 'success',
    result: input.resultText,
    session_id: input.sessionId,
    num_turns: input.numTurns,
    duration_ms: input.durationMs,
    total_cost_usd: input.totalCostUsd,
    usage: input.usage,
  };
}

/** Running accumulator for usage + cost across assistant messages. */
export class UsageAccumulator {
  private usage: SdkUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private cost = 0;

  add(messageUsage: any): void {
    if (!messageUsage) return;
    const mapped = mapUsage(messageUsage);
    this.usage.input_tokens += mapped.input_tokens;
    this.usage.output_tokens += mapped.output_tokens;
    this.usage.cache_read_input_tokens += mapped.cache_read_input_tokens;
    this.usage.cache_creation_input_tokens += mapped.cache_creation_input_tokens;
    this.cost += messageUsage?.cost?.total ?? 0;
  }

  get totals(): { usage: SdkUsage; cost: number } {
    return { usage: { ...this.usage }, cost: this.cost };
  }
}
