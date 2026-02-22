import type { AIPlatform } from './ai-runner.js';
import { GitDiffRunner } from './git-diff-runner.js';

export class KiroRunner extends GitDiffRunner {
  readonly platform: AIPlatform = 'kiro';
  protected readonly binary = 'kiro-cli';
  protected readonly logPrefix = 'kiro';

  protected buildAnalyzeArgs(prompt: string, systemPrompt: string): string[] {
    const args = ['chat', '--no-interactive'];
    args.push('--trust-tools', 'fs_read,fs_list,fs_search,execute_command');
    const fullPrompt = `${systemPrompt}\n\n${prompt}`;
    args.push(fullPrompt);
    return args;
  }

  protected buildGenerateArgs(prompt: string, systemPrompt?: string): string[] {
    const args = ['chat', '--no-interactive'];
    args.push('--trust-all-tools');
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    args.push(fullPrompt);
    return args;
  }
}
