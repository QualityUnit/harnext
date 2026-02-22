import type { AIPlatform } from './ai-runner.js';
import { CI_AGENT_ACTIONS } from './ai-runner.js';

export interface AgentStepConfig {
  stepName: string;
  stepId: string;
  promptExpr: string;
  argsExpr?: string;
  allowedBots?: string;
  ifCondition?: string;
  continueOnError?: boolean;
  maxTurns?: number;
  model?: string;
  jsonSchema?: string;
  allowedTools?: string;
}

/**
 * Generate YAML lines for invoking the AI agent in a CI workflow.
 *
 * For Claude: single `uses:` step with claude-code-action
 * For Codex: single `uses:` step with codex-action
 * For Kiro: 3 steps — configure AWS OIDC, setup Kiro CLI, run CLI via `run:`
 */
export function buildAgentStepLines(platform: AIPlatform, config: AgentStepConfig): string[] {
  const action = CI_AGENT_ACTIONS[platform];

  if (platform === 'kiro') {
    return buildKiroStepLines(config);
  }

  const lines: string[] = [];

  lines.push(`      - name: ${config.stepName}`);
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push(`        id: ${config.stepId}`);
  if (config.continueOnError) {
    lines.push('        continue-on-error: true');
  }
  lines.push(`        uses: ${action.action}`);
  lines.push('        with:');
  lines.push(`          ${action.secretInputKey}: \${{ secrets.${action.secretName} }}`);
  lines.push(`          ${action.promptInputKey}: ${config.promptExpr}`);

  if (action.argsInputKey && config.argsExpr) {
    lines.push(`          ${action.argsInputKey}: ${config.argsExpr}`);
  }

  if (platform === 'claude' && config.allowedBots) {
    lines.push(`          allowed_bots: '${config.allowedBots}'`);
  }

  return lines;
}

function buildKiroStepLines(config: AgentStepConfig): string[] {
  const lines: string[] = [];

  // Step 1: Configure AWS OIDC credentials
  lines.push('      - name: Configure AWS credentials (OIDC)');
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push('        uses: aws-actions/configure-aws-credentials@v4');
  lines.push('        with:');
  lines.push('          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}');
  lines.push('          aws-region: us-east-1');

  // Step 2: Install Kiro CLI
  lines.push('      - name: Setup Kiro CLI');
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push('        uses: clouatre-labs/setup-kiro-action@v1');

  // Step 3: Run Kiro CLI
  lines.push(`      - name: ${config.stepName}`);
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push(`        id: ${config.stepId}`);
  if (config.continueOnError) {
    lines.push('        continue-on-error: true');
  }
  lines.push('        run: |');
  lines.push(`          kiro-cli-chat chat --no-interactive --prompt ${config.promptExpr}`);

  return lines;
}

/**
 * Generate YAML lines for extracting the AI agent's text output.
 *
 * Claude: parse execution_file via jq
 * Codex: read final-message output directly
 * Kiro: output already captured in the run step
 */
export function buildExtractOutputLines(
  platform: AIPlatform,
  sourceStepId: string,
  outputStepId: string,
  ifCondition?: string,
): string[] {
  const lines: string[] = [];

  if (platform === 'claude') {
    lines.push('      - name: Extract review from execution file');
    if (ifCondition) {
      lines.push(`        if: ${ifCondition}`);
    }
    lines.push(`        id: ${outputStepId}`);
    lines.push('        env:');
    lines.push(`          EXECUTION_FILE: \${{ steps.${sourceStepId}.outputs.execution_file }}`);
    lines.push('        run: |');
    lines.push('          if [[ -z "$EXECUTION_FILE" || ! -f "$EXECUTION_FILE" ]]; then');
    lines.push('            echo "found=false" >> "$GITHUB_OUTPUT"');
    lines.push('            echo "::warning::No execution file available"');
    lines.push('            exit 0');
    lines.push('          fi');
    lines.push('');
    lines.push(
      '          echo "Execution file: ${EXECUTION_FILE} ($(wc -c < "$EXECUTION_FILE") bytes)"',
    );
    lines.push('');
    lines.push("          REVIEW_TEXT=$(jq -r '");
    lines.push('            [.[] | select(.type == "result")] | last | .result // ""');
    lines.push('          \' "$EXECUTION_FILE" 2>/dev/null || echo "")');
    lines.push('');
    lines.push('          if [[ -z "$REVIEW_TEXT" || "$REVIEW_TEXT" == "null" ]]; then');
    lines.push("            REVIEW_TEXT=$(jq -r '");
    lines.push('              [.[] | select(.type == "assistant") |');
    lines.push('               .message.content[] | select(.type == "text") | .text');
    lines.push('              ] | last // ""');
    lines.push('            \' "$EXECUTION_FILE" 2>/dev/null || echo "")');
    lines.push('          fi');
    lines.push('');
    lines.push('          if [[ -z "$REVIEW_TEXT" || "$REVIEW_TEXT" == "null" ]]; then');
    lines.push('            echo "found=false" >> "$GITHUB_OUTPUT"');
    lines.push('            echo "::warning::Could not extract review text from execution file"');
    lines.push('          else');
    lines.push('            REVIEW_TEXT="${REVIEW_TEXT:0:60000}"');
    lines.push('            {');
    lines.push('              echo "review<<REVIEW_EOF"');
    lines.push('              echo "$REVIEW_TEXT"');
    lines.push('              echo "REVIEW_EOF"');
    lines.push('            } >> "$GITHUB_OUTPUT"');
    lines.push('            echo "found=true" >> "$GITHUB_OUTPUT"');
    lines.push('            echo "✔ Extracted review ($(echo "$REVIEW_TEXT" | wc -c) chars)"');
    lines.push('          fi');
  } else if (platform === 'codex') {
    lines.push('      - name: Extract output from Codex');
    if (ifCondition) {
      lines.push(`        if: ${ifCondition}`);
    }
    lines.push(`        id: ${outputStepId}`);
    lines.push('        env:');
    lines.push(`          FINAL_MESSAGE: \${{ steps.${sourceStepId}.outputs.final-message }}`);
    lines.push('        run: |');
    lines.push('          if [[ -z "$FINAL_MESSAGE" ]]; then');
    lines.push('            echo "found=false" >> "$GITHUB_OUTPUT"');
    lines.push('            echo "::warning::No output from Codex"');
    lines.push('          else');
    lines.push('            REVIEW_TEXT="${FINAL_MESSAGE:0:60000}"');
    lines.push('            {');
    lines.push('              echo "review<<REVIEW_EOF"');
    lines.push('              echo "$REVIEW_TEXT"');
    lines.push('              echo "REVIEW_EOF"');
    lines.push('            } >> "$GITHUB_OUTPUT"');
    lines.push('            echo "found=true" >> "$GITHUB_OUTPUT"');
    lines.push('          fi');
  } else {
    // Kiro — output captured inline in the run step
    lines.push('      - name: Capture Kiro output');
    if (ifCondition) {
      lines.push(`        if: ${ifCondition}`);
    }
    lines.push(`        id: ${outputStepId}`);
    lines.push('        run: |');
    lines.push('          echo "found=true" >> "$GITHUB_OUTPUT"');
    lines.push('          echo "review=See Kiro CLI output above" >> "$GITHUB_OUTPUT"');
  }

  return lines;
}

/**
 * Generate the permissions block needed for a given platform.
 *
 * Kiro needs `id-token: write` for OIDC.
 * Claude needs `id-token: write` for OIDC.
 * Codex needs standard permissions only.
 */
export function getPlatformPermissions(platform: AIPlatform): string[] {
  if (platform === 'codex') {
    return ['  contents: read'];
  }

  // Claude and Kiro both need id-token: write for OIDC
  return ['  contents: read', '  id-token: write'];
}
