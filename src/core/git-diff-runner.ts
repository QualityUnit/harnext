import { spawn } from 'node:child_process';
import type { z } from 'zod';

import type { AIRunner, AIRunnerOptions, AIPlatform, GenerateResult } from './ai-runner.js';
import { extractJson } from './ai-runner.js';
import { snapshotUntrackedFiles, snapshotModifiedFiles, diffWorkingTree } from '../utils/git.js';

interface RunResult {
  resultText: string;
}

/**
 * Abstract base class for AI runners that use git-diff-based file tracking.
 *
 * Subclasses only need to define the CLI binary, log prefix, and how to build
 * CLI arguments for analyze/generate modes. All shared logic (spawning the CLI,
 * parsing stdout, snapshotting the working tree, diffing after the run) lives here.
 */
export abstract class GitDiffRunner implements AIRunner {
  abstract readonly platform: AIPlatform;
  protected readonly options: AIRunnerOptions;

  protected abstract readonly binary: string;
  protected abstract readonly logPrefix: string;

  protected abstract buildAnalyzeArgs(prompt: string, systemPrompt: string): string[];
  protected abstract buildGenerateArgs(prompt: string, systemPrompt?: string): string[];

  constructor(options: AIRunnerOptions = {}) {
    this.options = options;
  }

  async analyze<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
    const systemPrompt = [
      'You are a repository analysis assistant.',
      'Analyze the repository and return your findings as structured JSON.',
      'Your final response MUST be valid JSON matching the requested schema.',
      'Do not wrap the JSON in markdown code fences.',
      this.options.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n');

    const args = this.buildAnalyzeArgs(prompt, systemPrompt);
    const result = await this.run(args);

    const jsonStr = extractJson(result.resultText);
    const parsed = JSON.parse(jsonStr) as unknown;
    return schema.parse(parsed);
  }

  async generate(prompt: string, systemPromptAppend?: string): Promise<GenerateResult> {
    const cwd = this.options.cwd ?? process.cwd();
    const beforeUntracked = snapshotUntrackedFiles(cwd);
    const beforeModified = snapshotModifiedFiles(cwd);

    const systemPrompt = [this.options.systemPrompt, systemPromptAppend].filter(Boolean).join('\n');

    const args = this.buildGenerateArgs(prompt, systemPrompt || undefined);
    await this.run(args);

    const { created, modified } = diffWorkingTree(beforeUntracked, cwd, beforeModified);
    return { filesCreated: created, filesModified: modified };
  }

  protected run(args: string[]): Promise<RunResult> {
    const cwd = this.options.cwd ?? process.cwd();

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd,
        stdio: ['inherit', 'pipe', 'inherit'],
      });

      let resultText = '';
      let buffer = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          resultText += line + '\n';
          const display = line.length > 100 ? line.slice(0, 97) + '...' : line;
          this.options.onLogLine?.(`  ${this.logPrefix}: ${display}`);
        }
      });

      child.on('close', (code) => {
        if (buffer.trim()) {
          resultText += buffer;
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`${this.binary} exited with code ${code}`));
          return;
        }

        resolve({ resultText: resultText.trim() });
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn ${this.binary}: ${err.message}`));
      });
    });
  }
}
