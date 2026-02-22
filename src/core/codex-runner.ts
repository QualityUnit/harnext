import type { AIPlatform } from './ai-runner.js';
import { GitDiffRunner } from './git-diff-runner.js';

export class CodexRunner extends GitDiffRunner {
  readonly platform: AIPlatform = 'codex';
  protected readonly binary = 'codex';
  protected readonly logPrefix = 'codex';

  protected buildAnalyzeArgs(prompt: string, systemPrompt: string): string[] {
    const args = ['exec', prompt, '--approval-mode', 'full-auto', '--quiet'];

    if (this.options.maxTurns != null) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    args.push('--system-prompt', systemPrompt);
    return args;
  }

  protected buildGenerateArgs(prompt: string, systemPrompt?: string): string[] {
    const args = ['exec', prompt, '--approval-mode', 'full-auto', '--quiet'];

    if (this.options.maxTurns != null) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    return args;
  }
}
