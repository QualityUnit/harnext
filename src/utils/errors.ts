export class UserCancelledError extends Error {
  constructor(message = 'Operation cancelled by user') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

export class NotAGitRepoError extends Error {
  constructor(message = 'Not a git repository. Please run this command from within a git repo.') {
    super(message);
    this.name = 'NotAGitRepoError';
  }
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class UpdateError extends Error {
  constructor(message = 'Update failed') {
    super(message);
    this.name = 'UpdateError';
  }
}

export class NetworkError extends UpdateError {
  constructor(message = 'Network request failed') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ChecksumError extends UpdateError {
  constructor(message = 'Checksum verification failed') {
    super(message);
    this.name = 'ChecksumError';
  }
}

const PLATFORM_INSTALL_INSTRUCTIONS: Record<string, string> = {
  claude: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
  kiro: 'Install AWS Kiro: see https://kiro.dev/docs/install',
  codex: 'Install OpenAI Codex: npm install -g @openai/codex',
};

export class PlatformCLINotFoundError extends Error {
  readonly platform: string;
  readonly binary: string;

  constructor(platform: string, binary: string) {
    const instructions = PLATFORM_INSTALL_INSTRUCTIONS[platform] ?? `Install the ${platform} CLI`;
    super(`${binary} CLI not found in PATH. ${instructions}`);
    this.name = 'PlatformCLINotFoundError';
    this.platform = platform;
    this.binary = binary;
  }
}
