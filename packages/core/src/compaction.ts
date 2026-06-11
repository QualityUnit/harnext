import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message, Model, UserMessage } from '@earendil-works/pi-ai';

import {
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from './settings.js';

// ── Token accounting (API-driven, no estimation) ────────────────────
//
// Every assistant turn carries `usage.input` (the exact token count that
// was sent to the model for that call) and `usage.output` (the exact
// token count generated). We use those numbers directly and never
// estimate from text length.
//
// The most recent assistant's `usage.input + usage.output` is the exact
// size of the conversation at the moment that response finished — i.e.
// the cumulative context the model just saw. Any messages added after
// that assistant (a fresh user prompt, or steered messages) are about
// to be sent on the *next* call; if `lastInput + lastOutput` already
// exceeds the budget, we compact before that next call goes out.

const COMPACTED_MARKER = '[Compacted summary of earlier conversation]';

interface MeasuredAssistant {
  /** Index of the assistant message in the messages array. */
  idx: number;
  /** Tokens fed to the model for this call (everything before `idx` plus user_idx-1). */
  input: number;
  /** Tokens this assistant generated. */
  output: number;
}

/**
 * Find the most recent assistant message that has real (non-empty) usage
 * numbers. Error/aborted assistant turns carry zeroed-out usage and are
 * skipped, since they tell us nothing about the actual context size.
 */
function findLatestMeasuredAssistant(messages: AgentMessage[]): MeasuredAssistant | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const u = (m as AssistantMessage).usage;
    if (!u) continue;
    if (u.input > 0 || u.output > 0) return { idx: i, input: u.input, output: u.output };
  }
  return undefined;
}

/**
 * Current measured context size: tokens that the model saw on the most
 * recent assistant turn. Returns 0 if no assistant has spoken yet — in
 * that case there's nothing to compact and the next call's input is
 * trivially small.
 */
export function getContextTokens(messages: AgentMessage[]): number {
  const last = findLatestMeasuredAssistant(messages);
  return last ? last.input + last.output : 0;
}

// ── Cut point selection (API-driven) ────────────────────────────────
//
// Each assistant message's `usage.input` records the exact prefix size
// (in tokens) at the moment that assistant was generated. We use those
// recorded values to pick a cut point: find the latest assistant whose
// recorded prefix size is small enough that summarizing everything
// before its preceding user turn still leaves at least
// `keepRecentTokens` of recent history. Then snap the cut to the user
// message that prompted that assistant — a user-message boundary is
// always safe (it can't orphan a tool call from its result).

/**
 * Returns the index of the first message to keep. Messages before that
 * index will be summarized; messages from that index onwards are kept.
 *
 * Returns 0 if no compaction is needed (everything already fits).
 * Returns -1 if no safe cut point exists (e.g. no measured assistant
 * yet, or the entire conversation is one giant turn).
 */
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0;
  const last = findLatestMeasuredAssistant(messages);
  if (!last) return -1;

  const totalCurrent = last.input + last.output;
  if (totalCurrent <= keepRecentTokens) return 0;

  // We want the latest cut where the kept tail is at least
  // `keepRecentTokens` tokens. The kept tail starts at user message U
  // that prompted some earlier assistant A; everything before U is
  // summarized. The summarized portion's size ≈ A.usage.input minus
  // the size of U itself — call it `prefixTokens`. We pick the latest A
  // such that `totalCurrent - prefixTokens >= keepRecentTokens`, i.e.
  // `prefixTokens <= totalCurrent - keepRecentTokens`.
  //
  // We approximate prefixTokens with A.usage.input (treating U as
  // negligibly small relative to the cumulative context). This errs
  // slightly conservatively — kept-size may be a touch larger than
  // strictly required, which is the safe direction.
  const maxAllowedPrefix = totalCurrent - keepRecentTokens;

  let cutAssistantIdx = -1;
  for (let i = last.idx; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const u = (m as AssistantMessage).usage;
    if (!u || (u.input === 0 && u.output === 0)) continue;
    if (u.input <= maxAllowedPrefix) {
      cutAssistantIdx = i;
      break;
    }
  }
  if (cutAssistantIdx < 0) return -1;

  // Snap to the user message that prompted this assistant.
  for (let i = cutAssistantIdx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

// ── Serialization & summarization prompt ────────────────────────────

const STRUCTURED_SUMMARY_INSTRUCTIONS = `You are summarizing an earlier portion of a coding-assistant conversation so the assistant can continue without losing context.

Output a markdown summary using exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements, conventions, or preferences mentioned]

## Progress
### Done
- [Completed work, files created/edited, commands run]

### In Progress
- [Current focus]

### Blocked
- [Open issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Specific data needed to continue: file paths, function names, error messages, IDs]

<read-files>
[one path per line; files that were read]
</read-files>

<modified-files>
[one path per line; files that were created or edited]
</modified-files>

Rules:
- Be brief but preserve all technical details (file paths, function names, error messages, command output that matters).
- Do NOT include greetings, filler, or meta-commentary.
- Output ONLY the summary in the format above.`;

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const removed = text.length - max;
  return `${text.slice(0, max)}…\n[truncated ${removed} chars]`;
}

export function serializeConversation(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const u = msg as UserMessage;
      const text =
        typeof u.content === 'string'
          ? u.content
          : u.content
              .filter((c) => c.type === 'text')
              .map((c) => (c as { text: string }).text)
              .join('\n');
      parts.push(`[User]: ${text}`);
    } else if (msg.role === 'assistant') {
      const asst = msg as AssistantMessage;
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of asst.content) {
        if (c.type === 'text') textParts.push(c.text);
        else if (c.type === 'thinking' && 'thinking' in c) {
          const t = (c as { thinking?: string }).thinking;
          if (t) thinkingParts.push(t);
        } else if (c.type === 'toolCall') {
          toolCalls.push(`${c.name}(${JSON.stringify(c.arguments ?? {})})`);
        }
      }
      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`);
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join('\n')}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
      }
    } else if (msg.role === 'toolResult') {
      const tr = msg as {
        toolName: string;
        content: { type: string; text?: string }[];
        isError: boolean;
      };
      const text = tr.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n');
      const prefix = tr.isError ? `[Tool error: ${tr.toolName}]` : `[Tool result: ${tr.toolName}]`;
      parts.push(`${prefix} ${truncate(text)}`);
    }
  }
  return parts.join('\n\n');
}

async function callSummaryLlm(
  conversationText: string,
  model: Model<string>,
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const system = STRUCTURED_SUMMARY_INSTRUCTIONS;
  const userText = customInstructions
    ? `Focus the summary on: ${customInstructions}\n\nConversation to summarize:\n\n${conversationText}`
    : `Conversation to summarize:\n\n${conversationText}`;

  const messages: Message[] = [
    { role: 'user', content: userText, timestamp: Date.now() },
  ];

  let summary = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = streamSimple(model as Model<any>, { systemPrompt: system, messages }, {
    maxTokens: 2048,
    signal,
  });
  for await (const event of stream) {
    if (event.type === 'text_delta') summary += event.delta;
  }
  return summary.trim();
}

// ── Core compaction routine ─────────────────────────────────────────

interface CompactResult {
  compacted: boolean;
  summary?: string;
  cutIndex: number;
  before: AgentMessage[];
  after: AgentMessage[];
}

async function performCompaction(
  messages: AgentMessage[],
  keepRecentTokens: number,
  model: Model<string>,
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CompactResult> {
  const cutIndex = findCutPoint(messages, keepRecentTokens);
  if (cutIndex <= 0) {
    return { compacted: false, cutIndex, before: messages, after: messages };
  }

  const toSummarize = messages.slice(0, cutIndex);
  const kept = messages.slice(cutIndex);

  // If the prefix is just a previous summary marker with nothing new
  // around it, there's nothing additional to compact.
  const onlyOldSummary =
    toSummarize.length === 1 &&
    toSummarize[0].role === 'user' &&
    typeof (toSummarize[0] as UserMessage).content === 'string' &&
    ((toSummarize[0] as UserMessage).content as string).startsWith(COMPACTED_MARKER);
  if (onlyOldSummary) {
    return { compacted: false, cutIndex, before: messages, after: messages };
  }

  const conversationText = serializeConversation(toSummarize);
  const summary = await callSummaryLlm(conversationText, model, customInstructions, signal);
  const finalSummary = summary.length > 0 ? summary : 'Earlier conversation context was compacted.';

  const summaryMessage: UserMessage = {
    role: 'user',
    content: `${COMPACTED_MARKER}\n\n${finalSummary}`,
    timestamp: Date.now(),
  };

  const compacted: AgentMessage[] = [summaryMessage, ...kept];
  return { compacted: true, summary: finalSummary, cutIndex, before: messages, after: compacted };
}

// ── Public API ──────────────────────────────────────────────────────

export interface CompactionOptions {
  /** Reserve this many tokens for the next response (default 16384). */
  reserveTokens?: number;
  /** Keep at least this many tokens of recent history when compacting (default 20000). */
  keepRecentTokens?: number;
  /** Called when compaction occurs. */
  onCompact?: (stats: {
    originalTokens: number;
    compactedTokens: number;
    cutIndex: number;
  }) => void;
}

interface ResolvedCompactionOptions {
  reserveTokens: number;
  keepRecentTokens: number;
  onCompact?: CompactionOptions['onCompact'];
}

function resolveOptions(options: CompactionOptions = {}): ResolvedCompactionOptions {
  return {
    reserveTokens: options.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: options.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    onCompact: options.onCompact,
  };
}

/**
 * Build a `transformContext` callback that auto-compacts when the next
 * LLM call would exceed `contextWindow - reserveTokens`. The threshold
 * uses the API-reported token count from the most recent assistant turn
 * (`usage.input + usage.output`) — no estimation.
 *
 * pi-agent-core's `transformContext` is otherwise transient (its return
 * value is used only for one LLM call). To make compaction *persistent*
 * across turns, we mutate `agent.state.messages` directly when a
 * compaction triggers, so the visible transcript and the next turn both
 * work from the compacted history.
 */
export function createCompaction(
  agent: Agent,
  model: Model<string>,
  options: CompactionOptions = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const { reserveTokens, keepRecentTokens, onCompact } = resolveOptions(options);
  const ctxWindow = model.contextWindow ?? 0;

  return async (messages, signal) => {
    if (!ctxWindow) return messages;
    const tokens = getContextTokens(messages);
    if (tokens === 0) return messages; // no measured turn yet
    const budget = ctxWindow - reserveTokens;
    if (tokens <= budget) return messages;

    const result = await performCompaction(messages, keepRecentTokens, model, undefined, signal);
    if (!result.compacted) return messages;

    agent.state.messages = result.after;

    onCompact?.({
      originalTokens: tokens,
      compactedTokens: getContextTokens(result.after),
      cutIndex: result.cutIndex,
    });
    return result.after;
  };
}

export interface CompactNowOptions {
  /** Recent-token budget; defaults to the keepRecentTokens used by auto-compaction. */
  keepRecentTokens?: number;
  /** Optional instructions to focus the summary. */
  instructions?: string;
}

export interface CompactNowResult {
  compacted: boolean;
  originalMessages: number;
  newMessages: number;
  originalTokens: number;
  compactedTokens: number;
}

/**
 * Force-compact the agent's conversation history now, regardless of whether
 * the token budget would otherwise trigger compaction.
 */
export async function compactNow(
  agent: Agent,
  options: CompactNowOptions = {},
): Promise<CompactNowResult> {
  const messages = agent.state.messages;
  const originalTokens = getContextTokens(messages);
  const keepRecentTokens =
    options.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = agent.state.model as Model<any>;
  const result = await performCompaction(
    messages,
    keepRecentTokens,
    model,
    options.instructions,
    undefined,
  );

  if (!result.compacted) {
    return {
      compacted: false,
      originalMessages: messages.length,
      newMessages: messages.length,
      originalTokens,
      compactedTokens: originalTokens,
    };
  }

  agent.state.messages = result.after;
  return {
    compacted: true,
    originalMessages: messages.length,
    newMessages: result.after.length,
    originalTokens,
    // After compaction, the next call's input will include the summary
    // plus the kept tail. We don't have an API measurement for that yet
    // (no call has happened post-compaction), so we report the delta as
    // (totalCurrent - summarized prefix size) ≈ kept tail. For UX we
    // surface the previous measured size for the kept tail; the next
    // assistant turn will refresh it with a real number.
    compactedTokens: getContextTokens(result.after),
  };
}

export type { CompactionSettings };
