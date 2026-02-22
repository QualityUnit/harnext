import {
  buildAgentStepLines,
  buildExtractOutputLines,
  getPlatformPermissions,
  getKiroCISafetyRules,
} from '../../src/core/ci-agent-steps.js';
import type { AgentStepConfig } from '../../src/core/ci-agent-steps.js';

const baseConfig: AgentStepConfig = {
  stepName: 'Run AI agent',
  stepId: 'agent',
  promptExpr: "'Do something'",
};

describe('buildAgentStepLines', () => {
  it('should produce a single uses: step for Claude', () => {
    const lines = buildAgentStepLines('claude', baseConfig);
    const yaml = lines.join('\n');
    expect(yaml).toContain('uses: anthropics/claude-code-action@v1');
    expect(yaml).toContain('claude_code_oauth_token');
    expect(yaml).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(yaml).toContain("prompt: 'Do something'");
  });

  it('should produce a single uses: step for Codex', () => {
    const lines = buildAgentStepLines('codex', baseConfig);
    const yaml = lines.join('\n');
    expect(yaml).toContain('uses: openai/codex-action@v1');
    expect(yaml).toContain('openai_api_key');
    expect(yaml).toContain('OPENAI_API_KEY');
    expect(yaml).toContain("prompt: 'Do something'");
  });

  it('should produce 4 steps for Kiro (AWS auth + setup + OIDC inject + run)', () => {
    const lines = buildAgentStepLines('kiro', baseConfig);
    const yaml = lines.join('\n');
    expect(yaml).toContain('Configure AWS credentials');
    expect(yaml).not.toContain('Configure AWS credentials (OIDC)');
    expect(yaml).toContain('continue-on-error: true');
    expect(yaml).toContain('aws-actions/configure-aws-credentials@v4');
    expect(yaml).toContain('role-to-assume: ${{ secrets.AWS_ROLE_ARN }}');
    expect(yaml).toContain('aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}');
    expect(yaml).toContain('aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}');
    expect(yaml).toContain("aws-region: ${{ vars.AWS_REGION || 'us-east-1' }}");
    expect(yaml).toContain('Setup Kiro CLI');
    expect(yaml).toContain('clouatre-labs/setup-kiro-action@v1');
    expect(yaml).toContain("enable-sigv4: 'true'");
    expect(yaml).not.toContain('AMAZON_Q_SIGV4');
    expect(yaml).toContain('Authenticate Kiro CLI');
    expect(yaml).toContain('KIRO_CLIENT_ID');
    expect(yaml).toContain('KIRO_REFRESH_TOKEN');
    expect(yaml).toContain('KIRO_PROFILE_ARN');
    expect(yaml).toContain('oidc.');
    expect(yaml).toContain('auth_kv');
    expect(yaml).toContain('kiro-cli-chat whoami');
    expect(yaml).toContain('kiro-cli-chat chat --no-interactive --trust-all-tools');
    // Verify ANSI stripping and structured output capture
    expect(yaml).toContain('KIRO_PROMPT');
    expect(yaml).toContain('sed');
    expect(yaml).toContain('x1b');
    expect(yaml).toContain('structured_output');
    expect(yaml).toContain('KIRO_JSON_EOF');
  });

  it('should include claude_args for Claude when argsExpr is provided', () => {
    const config: AgentStepConfig = {
      ...baseConfig,
      argsExpr: "'--max-turns 10'",
    };
    const lines = buildAgentStepLines('claude', config);
    const yaml = lines.join('\n');
    expect(yaml).toContain("claude_args: '--max-turns 10'");
  });

  it('should NOT include args for Codex (no argsInputKey)', () => {
    const config: AgentStepConfig = {
      ...baseConfig,
      argsExpr: "'--max-turns 10'",
    };
    const lines = buildAgentStepLines('codex', config);
    const yaml = lines.join('\n');
    expect(yaml).not.toContain('--max-turns');
  });

  it('should include allowed_bots only for Claude', () => {
    const config: AgentStepConfig = {
      ...baseConfig,
      allowedBots: 'github-actions',
    };
    const claudeLines = buildAgentStepLines('claude', config);
    const codexLines = buildAgentStepLines('codex', config);
    expect(claudeLines.join('\n')).toContain("allowed_bots: 'github-actions'");
    expect(codexLines.join('\n')).not.toContain('allowed_bots');
  });

  it('should include if condition when provided', () => {
    const config: AgentStepConfig = {
      ...baseConfig,
      ifCondition: "steps.guard.outputs.should-run == 'true'",
    };
    const lines = buildAgentStepLines('claude', config);
    expect(lines.join('\n')).toContain("if: steps.guard.outputs.should-run == 'true'");
  });

  it('should include continue-on-error when set', () => {
    const config: AgentStepConfig = {
      ...baseConfig,
      continueOnError: true,
    };
    const lines = buildAgentStepLines('claude', config);
    expect(lines.join('\n')).toContain('continue-on-error: true');
  });

  it('should produce valid YAML indentation for all platforms', () => {
    for (const platform of ['claude', 'codex', 'kiro'] as const) {
      const lines = buildAgentStepLines(platform, baseConfig);
      for (const line of lines) {
        // Each line should start with spaces (YAML indentation)
        expect(line).toMatch(/^ /);
      }
    }
  });
});

describe('buildExtractOutputLines', () => {
  it('should extract from execution_file for Claude', () => {
    const lines = buildExtractOutputLines('claude', 'review', 'extract');
    const yaml = lines.join('\n');
    expect(yaml).toContain('execution_file');
    expect(yaml).toContain('jq -r');
    expect(yaml).toContain('found=true');
    expect(yaml).toContain('found=false');
  });

  it('should extract from final-message for Codex', () => {
    const lines = buildExtractOutputLines('codex', 'review', 'extract');
    const yaml = lines.join('\n');
    expect(yaml).toContain('final-message');
    expect(yaml).toContain('FINAL_MESSAGE');
    expect(yaml).toContain('found=true');
    expect(yaml).toContain('found=false');
  });

  it('should produce inline output capture for Kiro', () => {
    const lines = buildExtractOutputLines('kiro', 'review', 'extract');
    const yaml = lines.join('\n');
    expect(yaml).toContain('Capture Kiro output');
    expect(yaml).toContain('found=true');
  });

  it('should include if condition when provided', () => {
    const lines = buildExtractOutputLines('claude', 'review', 'extract', 'always()');
    expect(lines.join('\n')).toContain('if: always()');
  });

  it('should reference the correct source step ID', () => {
    const lines = buildExtractOutputLines('claude', 'my-review-step', 'my-extract');
    const yaml = lines.join('\n');
    expect(yaml).toContain('steps.my-review-step.outputs');
    expect(yaml).toContain('id: my-extract');
  });
});

describe('getKiroCISafetyRules', () => {
  it('should include all 6 safety rules', () => {
    const rules = getKiroCISafetyRules();
    expect(rules).toContain('continue-on-error: true');
    expect(rules).toContain('setup-kiro-action');
    expect(rules).toContain('Shell Expansion Safety');
    expect(rules).toContain('NEVER Use Heredocs');
    expect(rules).toContain('--json author');
    expect(rules).toContain('GITHUB_TOKEN Event Chaining');
  });

  it('should include verbatim Kiro auth YAML reference with Python migration', () => {
    const rules = getKiroCISafetyRules();
    expect(rules).toContain('kiro-cli-chat whoami');
    expect(rules).toContain('auth_kv');
    expect(rules).toContain('kirocli:odic:token');
    expect(rules).toContain('kirocli:odic:device-registration');
    expect(rules).toContain('profile.Migrated');
    expect(rules).toContain('oidc.${AWS_REGION}.amazonaws.com/token');
    expect(rules).toContain('kiro-cli-chat chat --no-interactive --trust-all-tools');
    // Must use Python-based migration (not bare sqlite3) to avoid kiro-cli migration conflicts
    expect(rules).toContain('python3');
    expect(rules).toContain('CREATE TABLE IF NOT EXISTS migrations');
    expect(rules).toContain('value BLOB');
    expect(rules).toContain('INSERT OR IGNORE INTO migrations');
    expect(rules).toContain('conversations_v2');
  });

  it('should include printf as correct pattern for multi-line strings', () => {
    const rules = getKiroCISafetyRules();
    expect(rules).toContain('printf');
    expect(rules).toContain('CORRECT');
    expect(rules).toContain('WRONG');
  });
});

describe('getPlatformPermissions', () => {
  it('should include id-token: write for Claude', () => {
    const perms = getPlatformPermissions('claude');
    expect(perms).toContain('  contents: read');
    expect(perms).toContain('  id-token: write');
  });

  it('should include id-token: write for Kiro', () => {
    const perms = getPlatformPermissions('kiro');
    expect(perms).toContain('  contents: read');
    expect(perms).toContain('  id-token: write');
  });

  it('should NOT include id-token: write for Codex', () => {
    const perms = getPlatformPermissions('codex');
    expect(perms).toContain('  contents: read');
    expect(perms).not.toContain('  id-token: write');
  });
});
