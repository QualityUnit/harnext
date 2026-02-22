import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
  readonly supportsParallelGeneration = false;
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
    const result = await this.run(args);

    let { created, modified } = diffWorkingTree(beforeUntracked, cwd, beforeModified);

    // Fallback: when the CLI outputs file contents as text instead of using its
    // file-writing tool (e.g. kiro-cli hitting context limits), parse the text
    // output and write the files to disk.
    if (result.resultText.length > 200) {
      const alreadyCreated = new Set(created.map((f) => relative(cwd, f)));
      const recovered = parseAndWriteTextOutput(result.resultText, cwd, alreadyCreated);
      if (recovered.length > 0) {
        this.options.onLogLine?.(
          `  ${this.logPrefix}: recovered ${recovered.length} file(s) from text output`,
        );
        const diff = diffWorkingTree(beforeUntracked, cwd, beforeModified);
        created = diff.created;
        modified = diff.modified;
      }
    }

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

// ── Text output fallback parser ──────────────────────────────────────────────

/** Minimum content length (bytes) to consider a parsed section as a real file. */
const MIN_FILE_CONTENT_LENGTH = 50;

/**
 * Pattern matching file path headers in CLI text output.
 *
 * Matches formats like:
 *   File: .github/workflows/issue-planner.yml
 *   # File: scripts/guard.ts
 *   ## .codefactory/prompts/planner.md
 *   ### .github/workflows/issue-planner.yml
 *   // File: scripts/guard.ts
 *
 * Requires at least one `/` in the path to reduce false positives.
 */
const FILE_HEADER_RE =
  /^(?:#{1,4}\s+)?(?:(?:\/\/|#)\s+)?(?:File:\s*)?(\S+\/\S+\.(?:ya?ml|tsx?|jsx?|md|json|sh))\s*$/;

/**
 * Parse CLI text output for file content patterns and write them to disk.
 *
 * When a git-diff-based runner (kiro-cli, codex-cli) outputs file contents as
 * text instead of using its file-writing tool, this function extracts the
 * file path + content pairs and writes them to the working directory.
 */
export function parseAndWriteTextOutput(
  text: string,
  cwd: string,
  skip: Set<string> = new Set(),
): string[] {
  const lines = text.split('\n');
  const files: Array<{ path: string; contentLines: string[] }> = [];

  let current: { path: string; contentLines: string[] } | null = null;
  let wrappedInFence = false;

  for (const line of lines) {
    // Check for file header (only outside wrapping fences)
    if (!wrappedInFence) {
      const match = line.match(FILE_HEADER_RE);
      if (match) {
        if (current) files.push(current);
        current = { path: match[1], contentLines: [] };
        continue;
      }
    }

    if (!current) continue;

    // If the first content line is a code fence opener, mark as wrapped
    if (current.contentLines.length === 0 && !wrappedInFence && line.startsWith('```')) {
      wrappedInFence = true;
      continue; // skip the opening fence
    }

    // Closing fence for a wrapped block
    if (wrappedInFence && line.trim() === '```') {
      wrappedInFence = false;
      continue; // skip the closing fence
    }

    current.contentLines.push(line);
  }

  if (current) files.push(current);

  // Write files to disk (skip already-created ones)
  const written: string[] = [];
  for (const file of files) {
    if (skip.has(file.path)) continue;

    const content = file.contentLines.join('\n').trim();
    if (content.length < MIN_FILE_CONTENT_LENGTH) continue;

    const fullPath = join(cwd, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content + '\n');
    written.push(fullPath);
  }

  return written;
}
