import { randomUUID } from 'node:crypto';

import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

import type { BackgroundShellManager } from './background-shells.js';
import type { McpServerManager } from './mcp-server-manager.js';
import type { Skill } from './skills.js';

/** Why the most recent run stopped. `undefined` until a run completes. */
export type StopReason = 'success' | 'max_turns' | 'aborted' | 'error';

export interface AgentSessionConfig {
  model: Model<string>;
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[];
  thinkingLevel: ThinkingLevel;
  skills: Skill[];
  mcpManager?: McpServerManager;
  /** Owns shells started with `run_in_background`; SIGTERM'd on dispose. */
  backgroundShells?: BackgroundShellManager;
  /** Stop the agent after this many assistant turns (Claude SDK `max_turns`). */
  maxTurns?: number;
  /** Stable session id surfaced in stream-json envelopes. Generated if omitted. */
  sessionId?: string;
}

export type AgentSessionEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * AgentSession wraps the raw Agent with session-level concerns:
 * system prompt management, event forwarding, lifecycle, and the
 * Claude-SDK-style run accounting (turn count, stop reason, max_turns).
 */
export class AgentSession {
  public readonly agent: Agent;
  private readonly config: AgentSessionConfig;
  public readonly sessionId: string;
  private turnCounter = 0;
  private maxTurnsHit = false;

  constructor(agent: Agent, config: AgentSessionConfig) {
    this.agent = agent;
    this.config = config;
    this.sessionId = config.sessionId ?? randomUUID();

    if (config.maxTurns && config.maxTurns > 0) {
      // Count completed assistant turns. When the limit is reached on a turn
      // that produced tool results (i.e. the agent would otherwise continue),
      // abort before the next LLM call — that truncation is a `max_turns` stop.
      // A turn with no tool results means the agent stopped on its own, so we
      // leave it alone (natural success).
      this.agent.subscribe((event) => {
        if (event.type === 'turn_end') {
          this.turnCounter += 1;
          const willContinue = event.toolResults.length > 0;
          if (willContinue && this.turnCounter >= config.maxTurns!) {
            this.maxTurnsHit = true;
            this.agent.abort();
          }
        }
      });
    }
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get tools(): AgentTool<any>[] {
    return this.config.tools;
  }

  get mcpManager(): McpServerManager | undefined {
    return this.config.mcpManager;
  }

  get backgroundShells(): BackgroundShellManager | undefined {
    return this.config.backgroundShells;
  }

  /** Number of assistant turns completed across this session's runs. */
  get turnCount(): number {
    return this.turnCounter;
  }

  /** True when the most recent run was cut short by `max_turns`. */
  get maxTurnsReached(): boolean {
    return this.maxTurnsHit;
  }

  async dispose(): Promise<void> {
    this.config.backgroundShells?.disposeAll();
    await this.config.mcpManager?.disconnectAll();
  }
}
