import { spawn } from 'node:child_process';
import type { z } from 'zod';
import chalk from 'chalk';

import type { AIRunner, AIRunnerOptions, AIPlatform, GenerateResult } from './ai-runner.js';
import { extractJson } from './ai-runner.js';

export type { GenerateResult };

interface StreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  content_block?: {
    type: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  message?: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

interface RunResult {
  resultText: string;
  filesCreated: string[];
  filesModified: string[];
}

export class ClaudeRunner implements AIRunner {
  readonly platform: AIPlatform = 'claude';
  readonly supportsParallelGeneration = true;
  private readonly options: AIRunnerOptions;

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

    const result = await this.run(prompt, {
      systemPrompt,
      maxTurns: this.options.maxTurns ?? 20,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    });

    const jsonStr = extractJson(result.resultText);
    const parsed = JSON.parse(jsonStr) as unknown;
    return schema.parse(parsed);
  }

  async generate(prompt: string, systemPromptAppend?: string): Promise<GenerateResult> {
    const systemPrompt = [this.options.systemPrompt, systemPromptAppend].filter(Boolean).join('\n');

    const result = await this.run(prompt, {
      systemPrompt: systemPrompt || undefined,
      maxTurns: this.options.maxTurns ?? 30,
      allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    });

    return {
      filesCreated: result.filesCreated,
      filesModified: result.filesModified,
    };
  }

  private run(
    prompt: string,
    config: {
      systemPrompt?: string;
      maxTurns: number;
      allowedTools: string[];
    },
  ): Promise<RunResult> {
    const cwd = this.options.cwd ?? process.cwd();

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--max-turns',
      String(config.maxTurns),
      '--permission-mode',
      'bypassPermissions',
      '--verbose',
    ];

    for (const tool of config.allowedTools) {
      args.push('--allowedTools', tool);
    }

    if (config.systemPrompt) {
      args.push('--system-prompt', config.systemPrompt);
    }

    args.push(prompt);

    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, {
        cwd,
        stdio: ['inherit', 'pipe', 'inherit'],
        env: { ...process.env },
      });

      const created = new Set<string>();
      const modified = new Set<string>();
      let resultText = '';
      let buffer = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.processStreamLine(line, created, modified, (text) => {
            resultText = text;
          });
        }
      });

      child.on('close', (code) => {
        // Process any remaining buffer
        if (buffer.trim()) {
          this.processStreamLine(buffer, created, modified, (text) => {
            resultText = text;
          });
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`Claude exited with code ${code}`));
          return;
        }

        // Deduplicate: files in both created and modified go to created only
        for (const f of created) {
          modified.delete(f);
        }

        resolve({
          resultText,
          filesCreated: [...created],
          filesModified: [...modified],
        });
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }

  private processStreamLine(
    line: string,
    created: Set<string>,
    modified: Set<string>,
    onResult: (text: string) => void,
  ): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(line) as StreamMessage;
    } catch {
      return;
    }

    // Result message — capture the final text
    if (msg.type === 'result') {
      if (msg.result) {
        onResult(msg.result);
      }
      const cost = (msg as unknown as Record<string, unknown>).cost_usd;
      if (cost !== undefined) {
        console.log(chalk.dim(`  Cost: $${Number(cost).toFixed(4)}`));
      }
      return;
    }

    // Assistant message — extract tool_use blocks for file tracking + display
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          console.log(block.text);
        }

        if (block.type === 'tool_use' && block.input) {
          const filePath = block.input.file_path as string | undefined;

          if (block.name === 'Read' || block.name === 'Glob' || block.name === 'Grep') {
            const target =
              filePath ?? (block.input.pattern as string) ?? (block.input.path as string) ?? '';
            console.log(chalk.dim(`  ${block.name}: ${target}`));
          }

          if (block.name === 'Write' || block.name === 'FileWrite') {
            if (filePath) {
              created.add(filePath);
              console.log(chalk.green(`  ✓ Write: ${filePath}`));
            }
          }

          if (
            block.name === 'Edit' ||
            block.name === 'FileEdit' ||
            block.name === 'FileMultiEdit'
          ) {
            if (filePath) {
              modified.add(filePath);
              console.log(chalk.yellow(`  ✎ Edit: ${filePath}`));
            }
          }

          if (block.name === 'Bash') {
            const cmd = block.input.command as string | undefined;
            if (cmd) {
              console.log(chalk.dim(`  $ ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`));
            }
          }
        }
      }
    }
  }
}
