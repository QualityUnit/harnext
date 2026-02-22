import { execFileSync } from 'node:child_process';

import type { AIPlatform, AIRunner, AIRunnerOptions } from './ai-runner.js';
import { ClaudeRunner } from './claude-runner.js';
import { KiroRunner } from './kiro-runner.js';
import { CodexRunner } from './codex-runner.js';
import { PlatformCLINotFoundError } from '../utils/errors.js';

const PLATFORM_BINARIES: Record<AIPlatform, string> = {
  claude: 'claude',
  kiro: 'kiro-cli',
  codex: 'codex',
};

export function createRunner(platform: AIPlatform, options?: AIRunnerOptions): AIRunner {
  switch (platform) {
    case 'claude':
      return new ClaudeRunner(options);
    case 'kiro':
      return new KiroRunner(options);
    case 'codex':
      return new CodexRunner(options);
    default: {
      const _exhaustive: never = platform;
      throw new Error(`Unknown AI platform: ${_exhaustive}`);
    }
  }
}

export function validatePlatformCLI(platform: AIPlatform): void {
  const binary = PLATFORM_BINARIES[platform];
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, [binary], { stdio: 'ignore' });
  } catch {
    throw new PlatformCLINotFoundError(platform, binary);
  }
}
