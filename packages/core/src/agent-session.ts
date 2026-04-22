import { Agent } from '@mariozechner/pi-agent-core';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';

import type { McpServerManager } from './mcp-server-manager.js';
import type { Skill } from './skills.js';

export interface AgentSessionConfig {
  model: Model<string>;
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[];
  thinkingLevel: ThinkingLevel;
  skills: Skill[];
  mcpManager?: McpServerManager;
}

export type AgentSessionEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * AgentSession wraps the raw Agent with session-level concerns:
 * system prompt management, event forwarding, and lifecycle.
 */
export class AgentSession {
  public readonly agent: Agent;
  private readonly config: AgentSessionConfig;

  constructor(agent: Agent, config: AgentSessionConfig) {
    this.agent = agent;
    this.config = config;
  }

  get state() {
    return this.agent.state;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    return this.agent.subscribe(listener);
  }

  async prompt(text: string): Promise<void> {
    await this.agent.prompt(text);
    await this.agent.waitForIdle();
  }

  abort(): void {
    this.agent.abort();
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get model(): Model<string> {
    return this.config.model;
  }

  get systemPrompt(): string {
    return this.config.systemPrompt;
  }

  get skills(): Skill[] {
    return this.config.skills;
  }

  get mcpManager(): McpServerManager | undefined {
    return this.config.mcpManager;
  }

  async dispose(): Promise<void> {
    await this.config.mcpManager?.disconnectAll();
  }
}
