/**
 * Registry of coding agents harnext can drive from the pipeline.
 *
 * The harness (GitHub poller, setup wizard, etc.) reads this registry to
 * know how to invoke each agent and which model IDs the agent accepts on
 * its command line. `harnext` is the built-in agent — it has no static
 * model list because its provider/model selection goes through the
 * existing preferences + provider registry.
 */

export const CODING_AGENT_IDS = ['harnext', 'claude-code', 'codex'] as const;
export type CodingAgentId = (typeof CODING_AGENT_IDS)[number];

export interface CodingAgentSpec {
  /** Stable identifier used in config files. */
  id: CodingAgentId;
  /** Human-readable label for pickers. */
  label: string;
  /** Short hint shown next to the label in pickers. */
  hint: string;
  /**
   * Binary invoked on PATH. Undefined for `harnext`, which runs in-process
   * via the pi-agent-core runtime rather than as a separate subprocess.
   */
  binary?: string;
  /** CLI flag used to pass the model id, e.g. `--model`. */
  modelFlag?: string;
  /**
   * Model IDs the agent's CLI currently accepts. Empty for `harnext`: the
   * model picker uses the provider registry + preferences instead.
   */
  supportedModels: readonly string[];
}

export const CODING_AGENTS: Record<CodingAgentId, CodingAgentSpec> = {
  harnext: {
    id: 'harnext',
    label: 'harnext',
    hint: 'built-in agent (provider/model picker)',
    supportedModels: [],
  },
  'claude-code': {
    id: 'claude-code',
    label: 'claude-code',
    hint: "Anthropic's Claude Code CLI",
    binary: 'claude',
    modelFlag: '--model',
    supportedModels: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
    ],
  },
  codex: {
    id: 'codex',
    label: 'codex',
    hint: "OpenAI's Codex CLI",
    binary: 'codex',
    modelFlag: '--model',
    supportedModels: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
    ],
  },
};

export function isCodingAgentId(value: unknown): value is CodingAgentId {
  return typeof value === 'string' && (CODING_AGENT_IDS as readonly string[]).includes(value);
}

export function getCodingAgentSpec(id: CodingAgentId): CodingAgentSpec {
  return CODING_AGENTS[id];
}

export function listCodingAgents(): CodingAgentSpec[] {
  return CODING_AGENT_IDS.map((id) => CODING_AGENTS[id]);
}
