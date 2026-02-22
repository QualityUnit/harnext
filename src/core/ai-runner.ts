import type { z } from 'zod';

export type AIPlatform = 'claude' | 'kiro' | 'codex';

export interface AIRunnerOptions {
  maxTurns?: number;
  systemPrompt?: string;
  cwd?: string;
  onLogLine?: (line: string) => void;
}

export interface GenerateResult {
  filesCreated: string[];
  filesModified: string[];
}

export interface AIRunner {
  readonly platform: AIPlatform;
  analyze<T>(prompt: string, schema: z.ZodType<T>): Promise<T>;
  generate(prompt: string, systemPromptAppend?: string): Promise<GenerateResult>;
}

export const INSTRUCTION_FILES: Record<AIPlatform, string> = {
  claude: 'CLAUDE.md',
  kiro: 'KIRO.md',
  codex: 'CODEX.md',
};

export interface CIAgentAction {
  /** The GitHub Action to use (e.g., 'anthropics/claude-code-action@v1') */
  action: string;
  /** Secret name to reference (e.g., 'CLAUDE_CODE_OAUTH_TOKEN') */
  secretName: string;
  /** Secret env key in the action's `with:` block (e.g., 'claude_code_oauth_token') */
  secretInputKey: string;
  /** Key for the prompt input (e.g., 'prompt') */
  promptInputKey: string;
  /** Key for CLI args (e.g., 'claude_args') — null if not applicable */
  argsInputKey: string | null;
  /** Output key containing the final text response */
  textOutputKey: string;
  /** Output key containing structured JSON output — null if not applicable */
  structuredOutputKey: string | null;
  /** Output key for execution file — null if not applicable */
  executionFileOutputKey: string | null;
  /** Whether this platform needs extra setup steps (Kiro's AWS OIDC + CLI install) */
  needsSetupSteps: boolean;
}

export const CI_AGENT_ACTIONS: Record<AIPlatform, CIAgentAction> = {
  claude: {
    action: 'anthropics/claude-code-action@v1',
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    secretInputKey: 'claude_code_oauth_token',
    promptInputKey: 'prompt',
    argsInputKey: 'claude_args',
    textOutputKey: 'execution_file',
    structuredOutputKey: 'structured_output',
    executionFileOutputKey: 'execution_file',
    needsSetupSteps: false,
  },
  codex: {
    action: 'openai/codex-action@v1',
    secretName: 'OPENAI_API_KEY',
    secretInputKey: 'openai_api_key',
    promptInputKey: 'prompt',
    argsInputKey: null,
    textOutputKey: 'final-message',
    structuredOutputKey: null,
    executionFileOutputKey: null,
    needsSetupSteps: false,
  },
  kiro: {
    action: 'clouatre-labs/setup-kiro-action@v1',
    secretName: 'AWS_ROLE_ARN',
    secretInputKey: '',
    promptInputKey: '',
    argsInputKey: null,
    textOutputKey: '',
    structuredOutputKey: null,
    executionFileOutputKey: null,
    needsSetupSteps: true,
  },
};

export const AI_PLATFORMS: { name: string; value: AIPlatform; description: string }[] = [
  {
    name: 'Claude Code',
    value: 'claude',
    description: 'Anthropic Claude Code CLI — claude',
  },
  {
    name: 'AWS Kiro',
    value: 'kiro',
    description: 'AWS Kiro CLI — kiro-cli',
  },
  {
    name: 'OpenAI Codex',
    value: 'codex',
    description: 'OpenAI Codex CLI — codex',
  },
];

export function extractJson(text: string): string {
  // 1. Try code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // 2. Find balanced JSON object or array using brace counting
  const startIdx = text.search(/[{[]/);
  if (startIdx !== -1) {
    const openChar = text[startIdx];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === openChar) depth++;
      else if (ch === closeChar) depth--;

      if (depth === 0) {
        return text.slice(startIdx, i + 1).trim();
      }
    }
  }

  return text.trim();
}
