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
 * For Kiro: 3 steps — configure AWS credentials, setup Kiro CLI, run CLI via `run:`
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

  // Step 1: Configure AWS credentials (supports OIDC and static keys)
  // continue-on-error: true because OIDC role may not be configured — the OIDC
  // token refresh in step 3 handles auth independently of AWS credentials.
  lines.push('      - name: Configure AWS credentials');
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push('        continue-on-error: true');
  lines.push('        uses: aws-actions/configure-aws-credentials@v4');
  lines.push('        with:');
  lines.push('          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}');
  lines.push('          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}');
  lines.push('          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}');
  lines.push("          aws-region: ${{ vars.AWS_REGION || 'us-east-1' }}");

  // Step 2: Install Kiro CLI
  lines.push('      - name: Setup Kiro CLI');
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push('        uses: clouatre-labs/setup-kiro-action@v1');
  lines.push('        with:');
  lines.push("          enable-sigv4: 'true'");
  lines.push("          aws-region: ${{ vars.AWS_REGION || 'us-east-1' }}");

  // Step 3: Authenticate Kiro CLI via OIDC token refresh + SQLite injection
  // Kiro CLI does not support headless auth natively — this workaround refreshes
  // a pre-existing OIDC session and injects it into the CLI's SQLite auth store.
  lines.push('      - name: Authenticate Kiro CLI');
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push('        env:');
  lines.push('          KIRO_CLIENT_ID: ${{ secrets.KIRO_CLIENT_ID }}');
  lines.push('          KIRO_CLIENT_SECRET: ${{ secrets.KIRO_CLIENT_SECRET }}');
  lines.push('          KIRO_REFRESH_TOKEN: ${{ secrets.KIRO_REFRESH_TOKEN }}');
  lines.push('          KIRO_PROFILE_ARN: ${{ secrets.KIRO_PROFILE_ARN }}');
  lines.push("          KIRO_OIDC_REGION: ${{ vars.AWS_REGION || 'us-east-1' }}");
  lines.push("          KIRO_START_URL: ${{ secrets.KIRO_START_URL || '' }}");
  lines.push('        run: |');
  lines.push('          RESPONSE=$(curl -s -X POST \\');
  lines.push('            "https://oidc.${KIRO_OIDC_REGION}.amazonaws.com/token" \\');
  lines.push('            -H "Content-Type: application/json" \\');
  lines.push('            -d "{');
  lines.push('              \\"grantType\\": \\"refresh_token\\",');
  lines.push('              \\"clientId\\": \\"${KIRO_CLIENT_ID}\\",');
  lines.push('              \\"clientSecret\\": \\"${KIRO_CLIENT_SECRET}\\",');
  lines.push('              \\"refreshToken\\": \\"${KIRO_REFRESH_TOKEN}\\"');
  lines.push('            }")');
  lines.push('          ACCESS_TOKEN=$(echo "$RESPONSE" | jq -r \'.accessToken // empty\')');
  lines.push('          NEW_REFRESH=$(echo "$RESPONSE" | jq -r \'.refreshToken // empty\')');
  lines.push('          if [[ -z "$ACCESS_TOKEN" ]]; then');
  lines.push('            echo "::error::Kiro OIDC token refresh failed"');
  lines.push('            echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"');
  lines.push('            exit 1');
  lines.push('          fi');
  lines.push('          echo "::add-mask::${ACCESS_TOKEN}"');
  lines.push('          echo "::add-mask::${NEW_REFRESH}"');
  lines.push('          mkdir -p ~/.local/share/kiro-cli');
  lines.push('          EXPIRES_AT=$(date -u -d "+3600 seconds" +"%Y-%m-%dT%H:%M:%S.%6NZ")');
  lines.push('          CLIENT_EXPIRES=$(date -u -d "+90 days" +"%Y-%m-%dT%H:%M:%S.000Z")');
  lines.push('          python3 -c "');
  lines.push('          import sqlite3, json, sys, os, time');
  lines.push("          db = os.path.expanduser('~/.local/share/kiro-cli/data.sqlite3')");
  lines.push('          conn = sqlite3.connect(db)');
  lines.push('          c = conn.cursor()');
  lines.push("          c.executescript('''");
  lines.push('            CREATE TABLE IF NOT EXISTS migrations (');
  lines.push('              id INTEGER PRIMARY KEY, version INTEGER NOT NULL,');
  lines.push('              migration_time INTEGER NOT NULL);');
  lines.push('            CREATE TABLE IF NOT EXISTS auth_kv (');
  lines.push('              key TEXT PRIMARY KEY, value TEXT);');
  lines.push('            CREATE TABLE IF NOT EXISTS state (');
  lines.push('              key TEXT PRIMARY KEY, value BLOB);');
  lines.push('            CREATE TABLE IF NOT EXISTS history (');
  lines.push('              id INTEGER PRIMARY KEY);');
  lines.push('            CREATE TABLE IF NOT EXISTS conversations (');
  lines.push('              key TEXT PRIMARY KEY, value TEXT);');
  lines.push('            CREATE TABLE IF NOT EXISTS conversations_v2 (');
  lines.push('              key TEXT NOT NULL, conversation_id TEXT NOT NULL,');
  lines.push('              value TEXT NOT NULL, created_at INTEGER NOT NULL,');
  lines.push('              updated_at INTEGER NOT NULL,');
  lines.push('              PRIMARY KEY (key, conversation_id));');
  lines.push("          ''')");
  lines.push('          now = int(time.time())');
  lines.push('          for i in range(9):');
  lines.push(
    "            c.execute('INSERT OR IGNORE INTO migrations VALUES (?,?,?)', (i+1,i,now))",
  );
  lines.push(
    "          token = json.dumps({'access_token': sys.argv[1], 'expires_at': sys.argv[2],",
  );
  lines.push("            'refresh_token': sys.argv[3], 'region': sys.argv[6],");
  lines.push("            'start_url': sys.argv[7] or '', 'oauth_flow': 'Pkce',");
  lines.push(
    "            'scopes': ['codewhisperer:completions','codewhisperer:analysis','codewhisperer:conversations']})",
  );
  lines.push("          reg = json.dumps({'client_id': sys.argv[4], 'client_secret': sys.argv[5],");
  lines.push("            'client_secret_expires_at': sys.argv[8], 'region': sys.argv[6],");
  lines.push("            'oauth_flow': 'Pkce', 'scopes': ['codewhisperer:completions',");
  lines.push("            'codewhisperer:analysis','codewhisperer:conversations']})");
  lines.push(
    "          c.execute('INSERT OR REPLACE INTO auth_kv VALUES (?,?)', ('kirocli:odic:token', token))",
  );
  lines.push(
    "          c.execute('INSERT OR REPLACE INTO auth_kv VALUES (?,?)', ('kirocli:odic:device-registration', reg))",
  );
  lines.push('          if sys.argv[9]:');
  lines.push(
    "            profile = json.dumps({'arn': sys.argv[9], 'profile_name': sys.argv[9].split('/')[-1]})",
  );
  lines.push(
    "            c.execute('INSERT OR REPLACE INTO state VALUES (?,?)', ('api.codewhisperer.profile', profile))",
  );
  lines.push(
    "          c.execute('INSERT OR REPLACE INTO state VALUES (?,?)', ('profile.Migrated', '1'))",
  );
  lines.push('          conn.commit()');
  lines.push('          conn.close()');
  lines.push('          " "$ACCESS_TOKEN" "$EXPIRES_AT" "$NEW_REFRESH" \\');
  lines.push('            "$KIRO_CLIENT_ID" "$KIRO_CLIENT_SECRET" "$KIRO_OIDC_REGION" \\');
  lines.push('            "$KIRO_START_URL" "$CLIENT_EXPIRES" "$KIRO_PROFILE_ARN"');
  lines.push('          kiro-cli-chat whoami');

  // Step 4: Run Kiro CLI (binary is kiro-cli-chat, installed by setup action)
  lines.push(`      - name: ${config.stepName}`);
  if (config.ifCondition) {
    lines.push(`        if: ${config.ifCondition}`);
  }
  lines.push(`        id: ${config.stepId}`);
  if (config.continueOnError) {
    lines.push('        continue-on-error: true');
  }
  lines.push('        run: |');
  lines.push(
    `          kiro-cli-chat chat --no-interactive --trust-all-tools ${config.promptExpr}`,
  );

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
 * Return Kiro-specific CI safety rules for inclusion in AI-generation prompts.
 *
 * These rules prevent the most common failures observed during E2E testing:
 * shell expansion of user content, YAML block scalar breakage, and misuse
 * of the setup-kiro-action as a full agent action.
 */
export function getKiroCISafetyRules(): string {
  return `
## Kiro CI — Mandatory Safety Rules

These rules apply to ALL generated GitHub Actions workflow YAML when the target AI platform is Kiro.

### 1. Kiro Agent Invocation Pattern (4-step auth)

\`clouatre-labs/setup-kiro-action@v1\` is ONLY a binary installer — it does NOT accept \`prompt\`, \`aws_role_arn\`, or any agent inputs. Do NOT use it as a \`uses:\` step with action inputs. Instead, Kiro requires a 4-step authentication and invocation pattern:

1. **Configure AWS credentials** — \`aws-actions/configure-aws-credentials@v4\` with \`continue-on-error: true\`
2. **Setup Kiro CLI** — \`clouatre-labs/setup-kiro-action@v1\` (binary installer only, inputs: \`enable-sigv4\`, \`aws-region\`)
3. **Authenticate Kiro CLI** — OIDC token refresh via curl + SQLite injection into \`~/.local/share/kiro-cli/data.sqlite3\`
4. **Run agent** — \`kiro-cli-chat chat --no-interactive --trust-all-tools "$PROMPT"\` as a \`run:\` step

The Kiro auth step uses these secrets: \`KIRO_CLIENT_ID\`, \`KIRO_CLIENT_SECRET\`, \`KIRO_REFRESH_TOKEN\`, \`KIRO_PROFILE_ARN\`, \`KIRO_START_URL\` (optional), and the variable \`AWS_REGION\` (defaults to \`us-east-1\`).

### 2. Shell Expansion Safety

NEVER inline \`\${{ toJSON(github.event.issue) }}\` or other expressions containing user-generated content directly inside \`run: |\` blocks. Backticks and parentheses in issue titles/bodies will break bash. Instead, pass them via \`env:\` block:

**WRONG:**
\`\`\`yaml
run: |
  export ISSUE_JSON='\${{ toJSON(github.event.issue) }}'
\`\`\`

**CORRECT:**
\`\`\`yaml
run: |
  echo "$ISSUE_JSON" | jq .
env:
  ISSUE_JSON: \${{ toJSON(github.event.issue) }}
\`\`\`

### 3. YAML Block Scalar Indentation

In \`run: |\` blocks, ALL content lines must be indented relative to the YAML key. Lines starting at column 1 (like \`|-------|\`, \`## Heading\`, \`Branch: ...\`) break YAML block scalar parsing. For complex multi-line content (PR bodies, comment bodies with tables), use \`actions/github-script@v7\` or \`printf\` instead of inline heredocs.

### 4. AWS Credentials — continue-on-error

Always set \`continue-on-error: true\` on the "Configure AWS credentials" step. The OIDC token refresh in the "Authenticate Kiro CLI" step handles auth independently — the AWS credentials step is optional (only needed if using IAM role assumption on top of OIDC).

### 5. GitHub CLI — use \`--json author\` not \`--json user\`

When fetching issue data via \`gh issue view\`, use \`--json number,title,body,labels,author\` (not \`user\`). The \`user\` field does not exist in \`gh\` CLI output. Remap \`author\` to match the \`github.event.issue\` shape: \`jq '{number, title, body, labels, user: {login: .author.login}}'\`.

### 6. GITHUB_TOKEN Event Chaining

Labels added or PRs created using the default \`GITHUB_TOKEN\` do NOT trigger subsequent \`labeled\` or \`pull_request\` workflow events. When one workflow needs to chain to another (triage→planner, planner→implementer, review→implementer), use explicit \`gh workflow run\` dispatch.`;
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
