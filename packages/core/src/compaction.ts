import type { Agent, AgentMessage } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import type { AssistantMessage, Message, Model, UserMessage } from '@mariozechner/pi-ai';

// ── Token estimation ────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 characters per token.
 * Not exact, but good enough for deciding when to compact.
 */
function estimateMessageTokens(msg: AgentMessage): number {
  if (msg.role === 'user') {
    const user = msg as UserMessage;
    if (typeof user.content === 'string') {
      return Math.ceil(user.content.length / 4);
    }
    let chars = 0;
    for (const part of user.content) {
      if (part.type === 'text') chars += part.text.length;
    }
    return Math.ceil(chars / 4);
  }

  if (msg.role === 'assistant') {
    const asst = msg as AssistantMessage;
    // Use actual usage if available
    if (asst.usage?.totalTokens) {
      return asst.usage.totalTokens;
    }
    let chars = 0;
    for (const part of asst.content) {
      if (part.type === 'text') chars += part.text.length;
      if (part.type === 'toolCall') chars += JSON.stringify(part.arguments).length;
    }
    return Math.ceil(chars / 4);
  }

  if (msg.role === 'toolResult') {
    let chars = 0;
    for (const part of (msg as { content: { type: string; text?: string }[] }).content) {
      if (part.type === 'text' && part.text) chars += part.text.length;
    }
    return Math.ceil(chars / 4);
  }

  return 0;
}

export function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ── Message text extraction ─────────────────────────────────────────

function extractText(msg: AgentMessage): string {
  if (msg.role === 'user') {
    const user = msg as UserMessage;
    if (typeof user.content === 'string') return user.content;
    return user.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  }

  if (msg.role === 'assistant') {
    const asst = msg as AssistantMessage;
    const parts: string[] = [];
    for (const c of asst.content) {
      if (c.type === 'text') parts.push(c.text);
      if (c.type === 'toolCall') parts.push(`[tool: ${c.name}]`);
    }
    return parts.join('\n');
  }

  if (msg.role === 'toolResult') {
    const tr = msg as { toolName: string; content: { type: string; text?: string }[]; isError: boolean };
    const text = tr.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('\n');
    const prefix = tr.isError ? `[tool error: ${tr.toolName}]` : `[tool result: ${tr.toolName}]`;
    // Truncate long tool results in the summary input
    const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
    return `${prefix} ${truncated}`;
  }

  return '';
}

// ── Compaction via LLM summarization ────────────────────────────────

const SUMMARY_PROMPT = `Summarize the following conversation concisely. Focus on:
- What the user asked for
- What was done (files changed, commands run, decisions made)
- Current state and any pending work

Be brief but preserve all important technical details (file paths, function names, error messages).
Do NOT include greetings or filler. Output only the summary.

Conversation:
`;

async function summarizeMessages(
  messages: AgentMessage[],
  model: Model<string>,
): Promise<string> {
  const parts: string[] = [];
  for (const msg of messages) {
    const text = extractText(msg);
    if (text) {
      parts.push(`[${msg.role}] ${text}`);
    }
  }

  const conversationText = parts.join('\n\n');
  const summaryMessages: Message[] = [
    {
      role: 'user',
      content: SUMMARY_PROMPT + conversationText,
      timestamp: Date.now(),
    },
  ];

  let summary = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const event of streamSimple(model as Model<any>, { messages: summaryMessages }, { maxTokens: 1024 })) {
    if (event.type === 'text_delta') {
      summary += event.delta;
    }
  }

  return summary || 'Previous conversation context was compacted.';
}

// ── Public API ──────────────────────────────────────────────────────

export interface CompactionOptions {
  /** Fraction of context window to trigger compaction (default: 0.7) */
  threshold?: number;
  /** Number of recent messages to always keep (default: 6) */
  keepRecent?: number;
  /** Called when compaction occurs */
  onCompact?: (stats: { originalTokens: number; compactedTokens: number; messagesPruned: number }) => void;
}

/**
 * Creates a `transformContext` function that compacts old messages
 * when the conversation approaches the model's context window limit.
 *
 * Strategy:
 * 1. Estimate total tokens in the conversation
 * 2. If over threshold, summarize older messages using the LLM
 * 3. Replace old messages with a single summary message
 * 4. Keep recent messages intact for continuity
 */
export function createCompaction(
  model: Model<string>,
  options: CompactionOptions = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const threshold = options.threshold ?? 0.7;
  const keepRecent = options.keepRecent ?? 6;
  const onCompact = options.onCompact;

  const maxTokens = Math.floor(model.contextWindow * threshold);

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const totalTokens = estimateTotalTokens(messages);

    if (totalTokens <= maxTokens || messages.length <= keepRecent) {
      return messages;
    }

    // Split: old messages to summarize, recent messages to keep
    const splitIndex = messages.length - keepRecent;
    const oldMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    // Summarize old messages
    const summary = await summarizeMessages(oldMessages, model);

    // Create a summary message that replaces the old ones
    const summaryMessage: UserMessage = {
      role: 'user',
      content: `[Conversation compacted — summary of ${oldMessages.length} previous messages]\n\n${summary}`,
      timestamp: Date.now(),
    };

    const compactedMessages: AgentMessage[] = [summaryMessage, ...recentMessages];

    if (onCompact) {
      onCompact({
        originalTokens: totalTokens,
        compactedTokens: estimateTotalTokens(compactedMessages),
        messagesPruned: oldMessages.length,
      });
    }

    return compactedMessages;
  };
}

export interface CompactNowResult {
  compacted: boolean;
  originalMessages: number;
  newMessages: number;
  originalTokens: number;
  compactedTokens: number;
}

/**
 * Force-compact the agent's conversation history now,
 * regardless of whether the threshold has been reached.
 */
export async function compactNow(
  agent: Agent,
  keepRecent = 6,
): Promise<CompactNowResult> {
  const messages = agent.state.messages;

  if (messages.length <= keepRecent) {
    return {
      compacted: false,
      originalMessages: messages.length,
      newMessages: messages.length,
      originalTokens: estimateTotalTokens(messages),
      compactedTokens: estimateTotalTokens(messages),
    };
  }

  const originalTokens = estimateTotalTokens(messages);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = agent.state.model as Model<any>;

  const splitIndex = messages.length - keepRecent;
  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);

  const summary = await summarizeMessages(oldMessages, model);

  const summaryMessage: UserMessage = {
    role: 'user',
    content: `[Conversation compacted — summary of ${oldMessages.length} previous messages]\n\n${summary}`,
    timestamp: Date.now(),
  };

  const compactedMessages: AgentMessage[] = [summaryMessage, ...recentMessages];
  const compactedTokens = estimateTotalTokens(compactedMessages);

  agent.state.messages = compactedMessages;

  return {
    compacted: true,
    originalMessages: messages.length,
    newMessages: compactedMessages.length,
    originalTokens,
    compactedTokens,
  };
}
