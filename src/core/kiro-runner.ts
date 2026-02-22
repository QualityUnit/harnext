import type { AIPlatform } from './ai-runner.js';
import { GitDiffRunner } from './git-diff-runner.js';

export class KiroRunner extends GitDiffRunner {
  readonly platform: AIPlatform = 'kiro';
  protected readonly binary = 'kiro-cli';
  protected readonly logPrefix = 'kiro';

  protected buildAnalyzeArgs(prompt: string, systemPrompt: string): string[] {
    const args = ['chat', '--no-interactive'];

    if (this.options.maxTurns != null) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    args.push('--trust-tools', 'read,glob,grep,shell');
    args.push('--system-prompt', systemPrompt);
    args.push(prompt);
    return args;
  }

  protected buildGenerateArgs(prompt: string, systemPrompt?: string): string[] {
    const args = ['chat', '--no-interactive'];

    if (this.options.maxTurns != null) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    args.push('--trust-all-tools');

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push(prompt);
    return args;
  }
}
