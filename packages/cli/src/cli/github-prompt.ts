import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

import chalk from 'chalk';
import {
  AWAITING_APPROVAL_LABEL,
  DEFAULT_INTAKE,
  DEFAULT_S3_KEY_PREFIX,
  DEFAULT_S3_RETENTION_DAYS,
  DEFAULT_STAGES,
  NEEDS_JUDGMENT_LABEL,
  buildHarnextLabelSpecs,
  checkPublicRepoApprovalGate,
  createAndSwitchBranch,
  defaultStageWorkflowPath,
  deleteGithubConnection,
  deregisterRunner,
  deriveFixWorkflowPath,
  ensureRepoLabels,
  generateStageWorkflow,
  getCodingAgentSpec,
  getCurrentGitBranch,
  getGithubConfigPath,
  getRepoFromCwd,
  getStageRunner,
  getStageTrigger,
  getTechStackPath,
  installRunner,
  installRunnerService,
  listCodingAgents,
  listRepoAssignableUsers,
  listRepoLabels,
  loadGithubConnection,
  loadTechStack,
  registerRunner,
  runCodeAnalysisPipeline,
  runGhWithInput,
  saveGithubConnection,
  tryLoadRunnerMetadata,
  writeTaggerWorkflow,
  TAGGER_WORKFLOW_PATH,
  setDefault,
  verifyGhAuth,
  type AnalysisEvent,
  type CodingAgentId,
  type GhResult,
  type GithubConnectionConfig,
  type GithubIssueFilter,
  type IntakeStage,
  type NormalStage,
  type ReviewLoopStage,
  type RunsOn,
  type StageEntry,
  type StageMode,
  type StageRunner,
  type TechStack,
  type VerifyArtifactKind,
  type VerifyS3Config,
} from '@harnext/core';

import { editPrompt } from './external-editor.js';
import { pickModel } from './model-picker.js';
import { select } from './select.js';
import type { SelectItem } from './select.js';

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read a line from stdin without echoing the typed characters — used for
 * AWS access-key entry. Each printable character echoes a `*`; backspace
 * and ctrl-c behave as expected. Falls back to `readLine` (echoing) if
 * stdin isn't a TTY (tests, CI piping, etc.) so behavior stays scriptable.
 */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine(prompt);
  process.stdout.write(prompt);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf-8');
  return new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.pause();
          stdin.setRawMode(wasRaw);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // ctrl-c
          stdin.removeListener('data', onData);
          stdin.setRawMode(wasRaw);
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await readLine(chalk.cyan(`  ${question} ${suffix}: `))).trim();
  if (answer.length === 0) return defaultYes;
  if (defaultYes) return !/^n(o)?$/i.test(answer);
  return /^y(es)?$/i.test(answer);
}

function formatFilter(filter: GithubIssueFilter): string {
  switch (filter.kind) {
    case 'label':
      return `label = ${filter.label}`;
    case 'assignee':
      return `assignee = ${filter.assignee}`;
    case 'none':
      return 'all open issues';
  }
}

function formatMode(mode: StageMode): string {
  return mode === 'yolo' ? 'YOLO (auto-chain)' : 'Human approval';
}

function describeEntryKind(s: StageEntry): string {
  return s.kind === 'review-loop' ? 'loop' : 'stage';
}

function describeEntryMode(s: StageEntry): string {
  if (s.kind === 'review-loop') {
    const onExit = s.onExit === 'yolo' ? 'YOLO' : 'Human approval';
    return `×${s.maxIterations} → ${onExit}`;
  }
  return formatMode(s.mode);
}

function describeRunner(s: StageEntry): string {
  const r = getStageRunner(s);
  const where = r.runsOn === 'self-hosted' ? 'self-hosted' : 'gh-hosted';
  return `${where}:${basename(r.workflowPath || defaultStageWorkflowPath(s.id))}`;
}

function renderStagesTable(stages: StageEntry[]): void {
  console.log(
    chalk.dim('  #  type  id            label                          runner              behaviour'),
  );
  stages.forEach((s, i) => {
    const idx = String(i + 1).padEnd(2);
    const kind = describeEntryKind(s).padEnd(5);
    const id = s.id.padEnd(12);
    const label = s.label.padEnd(30);
    const kindColored = s.kind === 'review-loop' ? chalk.magenta(kind) : chalk.blue(kind);
    const r = getStageRunner(s);
    const runnerRaw = describeRunner(s).padEnd(19);
    const runnerColored =
      r.runsOn === 'self-hosted' ? chalk.cyan(runnerRaw) : chalk.yellow(runnerRaw);
    console.log(
      chalk.dim(`  ${idx} `) +
        kindColored +
        ' ' +
        chalk.cyan(id) +
        ' ' +
        label +
        ' ' +
        runnerColored +
        ' ' +
        describeEntryMode(s),
    );
  });
}

function validateStageLabel(label: string, stages: StageEntry[], self?: number): string | null {
  if (!label) return 'label is required';
  if (/\s/.test(label)) return 'label must not contain whitespace';
  const duplicate = stages.findIndex((s, i) => s.label === label && i !== self);
  if (duplicate >= 0) return `label "${label}" already used by stage ${duplicate + 1}`;
  return null;
}

function cloneStages(stages: StageEntry[]): StageEntry[] {
  return stages.map((s) => {
    const runner = s.runner ? { ...s.runner } : undefined;
    if (s.kind === 'review-loop') {
      return {
        ...s,
        review: { ...s.review },
        fix: { ...s.fix },
        runner,
      };
    }
    return { ...s, runner };
  });
}

async function pickStageMode(
  current: StageMode,
  title = 'When the agent finishes this stage…',
): Promise<StageMode | undefined> {
  const items: SelectItem<StageMode>[] = [
    {
      label: 'YOLO (auto-chain)',
      value: 'yolo',
      hint:
        current === 'yolo'
          ? 'current — poller moves to the next stage automatically'
          : 'poller moves to the next stage automatically',
    },
    {
      label: 'Human approval',
      value: 'human-approval',
      hint:
        current === 'human-approval'
          ? 'current — poller stops and waits for a human'
          : 'poller stops and waits for a human',
    },
  ];
  return select(items, { title });
}

const MAX_ITERATIONS = 20;

async function pickIterations(current?: number): Promise<number | undefined> {
  const def = current ?? 3;
  const answer = (
    await readLine(chalk.cyan(`  max iterations (1-${MAX_ITERATIONS}) [${def}]: `))
  ).trim();
  if (!answer) return def;
  const n = Number.parseInt(answer, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ITERATIONS) {
    console.log(chalk.red(`  must be an integer between 1 and ${MAX_ITERATIONS}`));
    return undefined;
  }
  return n;
}

/**
 * Edit a single stage. Dispatches on `kind` so normal stages and review-loop
 * groups each get their own editor. Mutates `stages` in place. Returns true
 * if anything was changed.
 */
async function editStage(
  stages: StageEntry[],
  index: number,
  cwd: string,
): Promise<boolean> {
  const entry = stages[index];
  if (entry.kind === 'review-loop') {
    return editReviewLoopStage(stages, index, cwd);
  }
  return editNormalStage(stages, index, cwd);
}

/**
 * Stage-runner toggle. Picks `runsOn` ('self-hosted' = workflow targets a
 * runner registered against the user's PC, 'github-hosted' = ubuntu-latest)
 * and a workflow file path. Every stage produces a workflow now — the
 * "generate via agent" deep-dive still lives in `runRunnersStep`.
 */
async function editStageRunner(stage: StageEntry, cwd: string): Promise<boolean> {
  const current = getStageRunner(stage);
  const items: SelectItem<RunsOn>[] = [
    {
      label: 'This PC (self-hosted)',
      value: 'self-hosted',
      hint:
        current.runsOn === 'self-hosted'
          ? 'current — workflow runs on a runner registered to your machine'
          : 'workflow runs on a runner registered to your machine',
    },
    {
      label: 'GitHub-hosted runners',
      value: 'github-hosted',
      hint:
        current.runsOn === 'github-hosted'
          ? 'current — workflow runs on ubuntu-latest'
          : 'workflow runs on ubuntu-latest (billed against the repo)',
    },
  ];
  const runsOn = await select(items, { title: 'Where should this stage run?' });
  if (!runsOn) return false;

  const existing = listExistingWorkflows(cwd);
  let workflowPath =
    current.workflowPath && current.workflowPath.length > 0
      ? current.workflowPath
      : defaultWorkflowPath(stage.id);
  if (existing.length > 0) {
    const pathItems: SelectItem<string>[] = existing.map((p) => ({ label: p, value: p }));
    pathItems.push({ label: 'Use the harnext default', value: defaultWorkflowPath(stage.id) });
    pathItems.push({ label: 'Enter a path manually…', value: '__manual__' });
    const sel = await select(pathItems, { title: 'Which workflow file handles this stage?' });
    if (!sel) return false;
    if (sel !== '__manual__') workflowPath = sel;
  }
  if (!existing.includes(workflowPath)) {
    const answer = (
      await readLine(chalk.cyan(`  workflow path [${workflowPath}]: `))
    ).trim() || workflowPath;
    if (!isValidWorkflowPath(answer)) {
      console.log(chalk.red('  must start with .github/workflows/ and end with .yml or .yaml'));
      return false;
    }
    workflowPath = answer;
  }
  const origin: StageRunner['origin'] = existing.includes(workflowPath) ? 'connected' : 'generated';
  const next: StageRunner = { workflowPath, origin, runsOn };
  if (
    current.workflowPath === next.workflowPath &&
    current.origin === next.origin &&
    current.runsOn === next.runsOn
  ) {
    return false;
  }
  (stage as { runner?: StageRunner }).runner = next;
  return true;
}

function getVerifyArtifactKind(stage: NormalStage): VerifyArtifactKind {
  return stage.verify?.artifactKind ?? 'local';
}

function describeVerifyArtifactKind(kind: VerifyArtifactKind): string {
  switch (kind) {
    case 'local':
      return 'Local — keep artifacts on runner only';
    case 's3-image':
      return 'S3 — image only';
    case 's3-image-and-video':
      return 'S3 — image + video';
  }
}

function describeVerifySummary(stage: NormalStage): string {
  const kind = getVerifyArtifactKind(stage);
  if (kind === 'local') return 'local';
  const s3 = stage.verify?.s3;
  if (!s3) return `${kind} (S3 bucket not configured)`;
  const prefix = s3.keyPrefix ?? DEFAULT_S3_KEY_PREFIX;
  return `${kind} → s3://${s3.bucket}/${prefix} (${s3.region}, ${s3.retentionDays}d)`;
}

async function pickVerifyArtifactKind(
  current: VerifyArtifactKind,
): Promise<VerifyArtifactKind | undefined> {
  const items: SelectItem<VerifyArtifactKind>[] = (
    ['local', 's3-image', 's3-image-and-video'] as const
  ).map((kind) => ({
    label: describeVerifyArtifactKind(kind),
    value: kind,
    hint: kind === current ? 'current' : undefined,
  }));
  return select(items, { title: 'Verification artifact handling' });
}

/**
 * Inline editor for the S3 bucket coords on a verify stage. Mutates
 * `stage.verify.s3` in place; returns true when at least one field changed.
 * Caller must ensure `stage.verify.artifactKind` is an s3-* mode before
 * invoking — this function never sets the artifact kind itself.
 */
async function editVerifyS3Bucket(stage: NormalStage): Promise<boolean> {
  const existing: VerifyS3Config | undefined = stage.verify?.s3;
  const bucketAnswer = (
    await readLine(chalk.cyan(`  S3 bucket [${existing?.bucket ?? ''}]: `))
  ).trim();
  const bucket = bucketAnswer || existing?.bucket || '';
  if (!bucket) {
    console.log(chalk.red('  bucket is required'));
    return false;
  }
  const regionAnswer = (
    await readLine(chalk.cyan(`  AWS region [${existing?.region ?? 'us-east-1'}]: `))
  ).trim();
  const region = regionAnswer || existing?.region || 'us-east-1';
  const retentionAnswer = (
    await readLine(
      chalk.cyan(
        `  retention days [${existing?.retentionDays ?? DEFAULT_S3_RETENTION_DAYS}]: `,
      ),
    )
  ).trim();
  const retentionParsed = retentionAnswer.length > 0 ? Number(retentionAnswer) : NaN;
  const retentionDays =
    Number.isFinite(retentionParsed) && retentionParsed > 0
      ? Math.floor(retentionParsed)
      : existing?.retentionDays ?? DEFAULT_S3_RETENTION_DAYS;
  const prefixAnswer = (
    await readLine(
      chalk.cyan(`  key prefix [${existing?.keyPrefix ?? DEFAULT_S3_KEY_PREFIX}]: `),
    )
  ).trim();
  const keyPrefix = prefixAnswer || existing?.keyPrefix || DEFAULT_S3_KEY_PREFIX;

  const next: VerifyS3Config = {
    bucket,
    region,
    retentionDays,
    keyPrefix: keyPrefix === DEFAULT_S3_KEY_PREFIX ? undefined : keyPrefix,
  };
  const changed =
    !existing ||
    existing.bucket !== next.bucket ||
    existing.region !== next.region ||
    existing.retentionDays !== next.retentionDays ||
    (existing.keyPrefix ?? DEFAULT_S3_KEY_PREFIX) !==
      (next.keyPrefix ?? DEFAULT_S3_KEY_PREFIX);
  if (!stage.verify) {
    stage.verify = { artifactKind: 's3-image', s3: next };
  } else {
    stage.verify.s3 = next;
  }
  return changed;
}

/**
 * Prompt for AWS access key ID + secret access key (masked) and write them
 * as repo secrets via `gh secret set`. Returns true on success so callers
 * can update local "configured" state without re-querying GitHub.
 */
async function setVerifyS3Secrets(repo: string): Promise<boolean> {
  console.log();
  console.log(
    chalk.dim('  AWS keys go straight to repo secrets (AWS_ACCESS_KEY_ID +'),
  );
  console.log(
    chalk.dim('  AWS_SECRET_ACCESS_KEY) via `gh secret set`. Values are masked'),
  );
  console.log(chalk.dim('  on input and never written to disk.'));
  const accessKey = (await readSecret(chalk.cyan('  AWS_ACCESS_KEY_ID: '))).trim();
  if (!accessKey) {
    console.log(chalk.red('  cancelled (no key entered)'));
    return false;
  }
  const secretKey = (await readSecret(chalk.cyan('  AWS_SECRET_ACCESS_KEY: '))).trim();
  if (!secretKey) {
    console.log(chalk.red('  cancelled (no secret entered)'));
    return false;
  }

  const setAccess = runGhWithInput(
    ['secret', 'set', 'AWS_ACCESS_KEY_ID', '--repo', repo],
    accessKey,
  );
  if (!setAccess.ok) {
    console.log(chalk.red(`  gh secret set AWS_ACCESS_KEY_ID failed: ${setAccess.message}`));
    return false;
  }
  const setSecret = runGhWithInput(
    ['secret', 'set', 'AWS_SECRET_ACCESS_KEY', '--repo', repo],
    secretKey,
  );
  if (!setSecret.ok) {
    console.log(chalk.red(`  gh secret set AWS_SECRET_ACCESS_KEY failed: ${setSecret.message}`));
    return false;
  }
  console.log(chalk.green(`  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY set on ${repo}`));
  return true;
}

/**
 * Print the prerequisites the user must arrange in their AWS account for
 * the verify stage's uploads to work. Harnext does not touch the user's
 * AWS account — IAM and billing belong to them — so we just print the
 * exact `aws` commands they can copy-paste.
 */
function printS3BucketPrereqs(s3: VerifyS3Config): void {
  const lifecycleJson = JSON.stringify(
    {
      Rules: [
        {
          ID: 'harnext-verify-retention',
          Status: 'Enabled',
          Filter: { Prefix: `${s3.keyPrefix ?? DEFAULT_S3_KEY_PREFIX}/` },
          Expiration: { Days: s3.retentionDays },
        },
      ],
    },
    null,
    2,
  );
  console.log();
  console.log(chalk.bold('  S3 bucket prerequisites (run in your AWS account):'));
  console.log(
    chalk.dim('    Harnext does not manage your bucket — these are the one-time'),
  );
  console.log(chalk.dim('    setup steps so verify uploads + public reads work.'));
  console.log();
  console.log(chalk.dim('    1. Create / confirm the bucket:'));
  console.log(chalk.cyan(`         aws s3api create-bucket --bucket ${s3.bucket} \\`));
  console.log(chalk.cyan(`           --region ${s3.region}`));
  console.log();
  console.log(chalk.dim('    2. Allow public reads (block-public-access OFF):'));
  console.log(
    chalk.cyan(`         aws s3api put-public-access-block --bucket ${s3.bucket} \\`),
  );
  console.log(
    chalk.cyan(
      '           --public-access-block-configuration ' +
        '"BlockPublicAcls=false,IgnorePublicAcls=false,' +
        'BlockPublicPolicy=false,RestrictPublicBuckets=false"',
    ),
  );
  console.log();
  console.log(chalk.dim(`    3. Lifecycle rule — delete after ${s3.retentionDays} days:`));
  console.log(chalk.cyan(`         cat > /tmp/harnext-lifecycle.json <<'EOF'`));
  for (const line of lifecycleJson.split('\n')) console.log(chalk.cyan(`         ${line}`));
  console.log(chalk.cyan(`         EOF`));
  console.log(
    chalk.cyan(
      `         aws s3api put-bucket-lifecycle-configuration --bucket ${s3.bucket} \\`,
    ),
  );
  console.log(chalk.cyan(`           --lifecycle-configuration file:///tmp/harnext-lifecycle.json`));
  console.log();
}

async function editVerifyConfig(stage: NormalStage, cwd: string): Promise<boolean> {
  let changed = false;
  for (;;) {
    console.log();
    console.log(chalk.dim(`    verify: ${describeVerifySummary(stage)}`));
    type Action =
      | { kind: 'artifact' }
      | { kind: 's3-bucket' }
      | { kind: 's3-secrets' }
      | { kind: 'done' };
    const items: SelectItem<Action>[] = [
      {
        label: 'Edit verification artifact',
        value: { kind: 'artifact' },
        hint: describeVerifyArtifactKind(getVerifyArtifactKind(stage)),
      },
    ];
    const isS3Mode = getVerifyArtifactKind(stage) !== 'local';
    if (isS3Mode) {
      items.push({
        label: 'Edit S3 bucket',
        value: { kind: 's3-bucket' },
        hint: stage.verify?.s3
          ? `${stage.verify.s3.bucket} (${stage.verify.s3.region})`
          : 'unset',
      });
      items.push({
        label: 'Set S3 credentials (repo secrets)',
        value: { kind: 's3-secrets' },
        hint: 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → gh secret set',
      });
    }
    items.push({ label: 'Back', value: { kind: 'done' } });

    const action = await select(items, { title: 'Verify stage settings' });
    if (!action || action.kind === 'done') return changed;

    if (action.kind === 'artifact') {
      const picked = await pickVerifyArtifactKind(getVerifyArtifactKind(stage));
      if (!picked) continue;
      const previous = getVerifyArtifactKind(stage);
      if (picked === previous) continue;
      if (picked === 'local') {
        stage.verify = undefined;
        changed = true;
        continue;
      }
      // Switching into / between s3-* modes. Preserve any existing s3
      // coords; chain into the bucket editor when none is configured yet.
      const existingS3 = stage.verify?.s3;
      stage.verify = { artifactKind: picked, s3: existingS3 };
      changed = true;
      if (!existingS3) {
        console.log(chalk.dim('  No S3 bucket configured yet — entering bucket editor.'));
        const bucketChanged = await editVerifyS3Bucket(stage);
        if (!bucketChanged && !stage.verify.s3) {
          // Bucket entry failed — revert to local so the config stays valid.
          console.log(chalk.red('  S3 bucket not set — reverting to local.'));
          stage.verify = undefined;
        }
      }
    } else if (action.kind === 's3-bucket') {
      if (await editVerifyS3Bucket(stage)) changed = true;
    } else if (action.kind === 's3-secrets') {
      const repoResult = getRepoFromCwd(cwd);
      if (!repoResult.ok) {
        console.log(chalk.red(`  could not detect repo: ${repoResult.message}`));
        continue;
      }
      if (await setVerifyS3Secrets(repoResult.value)) {
        if (stage.verify?.s3) printS3BucketPrereqs(stage.verify.s3);
      }
    }
  }
}

async function editNormalStage(
  stages: StageEntry[],
  index: number,
  cwd: string,
): Promise<boolean> {
  const stage = stages[index] as NormalStage;
  let changed = false;

  for (;;) {
    console.log();
    console.log(chalk.bold(`  Editing stage ${index + 1}: `) + chalk.cyan(stage.id));
    console.log(chalk.dim(`    type:   normal`));
    console.log(chalk.dim(`    label:  ${stage.label}`));
    console.log(chalk.dim(`    mode:   ${formatMode(stage.mode)}`));
    console.log(chalk.dim(`    runner: ${describeRunner(stage)}`));
    console.log(chalk.dim(`    prompt: ${stage.prompt.split('\n')[0].slice(0, 80)}…`));
    if (stage.id === 'verify') {
      console.log(chalk.dim(`    verify: ${describeVerifySummary(stage)}`));
    }

    type Action =
      | { kind: 'label' }
      | { kind: 'prompt' }
      | { kind: 'mode' }
      | { kind: 'id' }
      | { kind: 'runner' }
      | { kind: 'verify' }
      | { kind: 'done' };
    const items: SelectItem<Action>[] = [
      { label: 'Edit label', value: { kind: 'label' } },
      { label: 'Edit prompt', value: { kind: 'prompt' } },
      { label: 'Edit mode', value: { kind: 'mode' } },
      { label: 'Edit id', value: { kind: 'id' }, hint: 'internal identifier — used in logs' },
      {
        label: 'Edit runner',
        value: { kind: 'runner' },
        hint: 'this PC (self-hosted) or GitHub-hosted',
      },
    ];
    if (stage.id === 'verify') {
      items.push({
        label: 'Edit verify settings',
        value: { kind: 'verify' },
        hint: 'artifact upload (local / S3) + bucket coords + repo secrets',
      });
    }
    items.push({ label: 'Done', value: { kind: 'done' } });
    const action = await select(items, { title: 'What do you want to change?' });
    if (!action || action.kind === 'done') return changed;

    if (action.kind === 'label') {
      const answer = (await readLine(chalk.cyan(`  label [${stage.label}]: `))).trim();
      if (!answer) continue;
      const err = validateStageLabel(answer, stages, index);
      if (err) {
        console.log(chalk.red(`  ${err}`));
        continue;
      }
      stage.label = answer;
      changed = true;
    } else if (action.kind === 'prompt') {
      const updated = await editPrompt(stage.prompt, {
        title: `Edit prompt for stage "${stage.id}"`,
      });
      if (updated && updated !== stage.prompt) {
        stage.prompt = updated;
        changed = true;
      }
    } else if (action.kind === 'mode') {
      const mode = await pickStageMode(stage.mode);
      if (mode && mode !== stage.mode) {
        stage.mode = mode;
        changed = true;
      }
    } else if (action.kind === 'id') {
      const answer = (await readLine(chalk.cyan(`  id [${stage.id}]: `))).trim();
      if (!answer || answer === stage.id) continue;
      if (!/^[a-z0-9-]+$/.test(answer)) {
        console.log(chalk.red('  id must be lowercase a-z, 0-9, hyphens'));
        continue;
      }
      stage.id = answer;
      changed = true;
    } else if (action.kind === 'runner') {
      if (await editStageRunner(stage, cwd)) changed = true;
    } else if (action.kind === 'verify') {
      if (await editVerifyConfig(stage, cwd)) changed = true;
    }
  }
}

async function editReviewLoopStage(
  stages: StageEntry[],
  index: number,
  cwd: string,
): Promise<boolean> {
  const group = stages[index] as ReviewLoopStage;
  let changed = false;

  for (;;) {
    console.log();
    console.log(chalk.bold(`  Editing review-loop ${index + 1}: `) + chalk.cyan(group.id));
    console.log(chalk.dim(`    type:       review-loop`));
    console.log(chalk.dim(`    label:      ${group.label}`));
    console.log(chalk.dim(`    iterations: ${group.maxIterations}`));
    console.log(chalk.dim(`    onExit:     ${formatMode(group.onExit)}`));
    console.log(chalk.dim(`    runner:     ${describeRunner(group)}`));
    console.log(chalk.dim(`    review:     ${group.review.prompt.split('\n')[0].slice(0, 70)}…`));
    console.log(chalk.dim(`    fix:        ${group.fix.prompt.split('\n')[0].slice(0, 70)}…`));

    type Action =
      | { kind: 'label' }
      | { kind: 'id' }
      | { kind: 'iterations' }
      | { kind: 'review' }
      | { kind: 'fix' }
      | { kind: 'onExit' }
      | { kind: 'runner' }
      | { kind: 'done' };
    const items: SelectItem<Action>[] = [
      { label: 'Edit label', value: { kind: 'label' } },
      { label: 'Edit id', value: { kind: 'id' }, hint: 'internal identifier — used in logs' },
      {
        label: 'Edit max iterations',
        value: { kind: 'iterations' },
        hint: `cap on review↔fix cycles (current: ${group.maxIterations})`,
      },
      { label: 'Edit review prompt', value: { kind: 'review' }, hint: 'reviewer agent' },
      { label: 'Edit fix prompt', value: { kind: 'fix' }, hint: 'fixer agent' },
      {
        label: 'Edit onExit mode',
        value: { kind: 'onExit' },
        hint: 'what happens after the loop terminates (approved/commented)',
      },
      {
        label: 'Edit runner',
        value: { kind: 'runner' },
        hint: 'this PC (self-hosted) or GitHub-hosted',
      },
      { label: 'Done', value: { kind: 'done' } },
    ];
    const action = await select(items, { title: 'What do you want to change?' });
    if (!action || action.kind === 'done') return changed;

    if (action.kind === 'label') {
      const answer = (await readLine(chalk.cyan(`  label [${group.label}]: `))).trim();
      if (!answer) continue;
      const err = validateStageLabel(answer, stages, index);
      if (err) {
        console.log(chalk.red(`  ${err}`));
        continue;
      }
      group.label = answer;
      changed = true;
    } else if (action.kind === 'id') {
      const answer = (await readLine(chalk.cyan(`  id [${group.id}]: `))).trim();
      if (!answer || answer === group.id) continue;
      if (!/^[a-z0-9-]+$/.test(answer)) {
        console.log(chalk.red('  id must be lowercase a-z, 0-9, hyphens'));
        continue;
      }
      group.id = answer;
      changed = true;
    } else if (action.kind === 'iterations') {
      const picked = await pickIterations(group.maxIterations);
      if (picked !== undefined && picked !== group.maxIterations) {
        group.maxIterations = picked;
        changed = true;
      }
    } else if (action.kind === 'review') {
      const updated = await editPrompt(group.review.prompt, {
        title: `Edit review prompt for "${group.id}"`,
      });
      if (updated && updated !== group.review.prompt) {
        group.review.prompt = updated;
        changed = true;
      }
    } else if (action.kind === 'fix') {
      const updated = await editPrompt(group.fix.prompt, {
        title: `Edit fix prompt for "${group.id}"`,
      });
      if (updated && updated !== group.fix.prompt) {
        group.fix.prompt = updated;
        changed = true;
      }
    } else if (action.kind === 'onExit') {
      const mode = await pickStageMode(
        group.onExit,
        'When the loop terminates (approved/commented)…',
      );
      if (mode && mode !== group.onExit) {
        group.onExit = mode;
        changed = true;
      }
    } else if (action.kind === 'runner') {
      if (await editStageRunner(group, cwd)) changed = true;
    }
  }
}

async function runStagesStep(
  cwd: string,
  current?: StageEntry[],
): Promise<StageEntry[] | undefined> {
  const stages = cloneStages(current ?? DEFAULT_STAGES);

  for (;;) {
    console.log();
    renderStagesTable(stages);
    console.log();

    type Action =
      | { kind: 'done' }
      | { kind: 'edit'; index: number }
      | { kind: 'add-normal' }
      | { kind: 'add-loop' }
      | { kind: 'remove' }
      | { kind: 'move' }
      | { kind: 'reset' }
      | { kind: 'cancel' };

    const items: SelectItem<Action>[] = [
      { label: 'Done — keep these stages', value: { kind: 'done' } },
    ];
    stages.forEach((s, i) => {
      const tag = s.kind === 'review-loop' ? 'loop' : 'stage';
      items.push({
        label: `Edit ${tag} ${i + 1}: ${s.id}`,
        value: { kind: 'edit', index: i },
        hint: `${s.label} · ${describeEntryMode(s)}`,
      });
    });
    items.push({
      label: 'Add a normal stage',
      value: { kind: 'add-normal' },
      hint: 'single prompt, one agent pass per run',
    });
    items.push({
      label: 'Add a review-loop group',
      value: { kind: 'add-loop' },
      hint: 'reviewer ↔ fixer cycle on a PR until approved or max iterations hit',
    });
    if (stages.length > 1) items.push({ label: 'Remove a stage', value: { kind: 'remove' } });
    if (stages.length > 1) items.push({ label: 'Reorder stages', value: { kind: 'move' } });
    items.push({ label: 'Reset to defaults', value: { kind: 'reset' } });
    items.push({ label: 'Cancel wizard', value: { kind: 'cancel' } });

    const action = await select(items, { title: 'Workflow stages' });
    if (!action || action.kind === 'cancel') return undefined;

    if (action.kind === 'done') {
      if (stages.length === 0) {
        console.log(chalk.red('  At least one stage is required.'));
        continue;
      }
      return stages;
    }

    if (action.kind === 'edit') {
      await editStage(stages, action.index, cwd);
    } else if (action.kind === 'add-normal') {
      const added = await addStage(stages, 'normal');
      if (added) stages.push(added);
    } else if (action.kind === 'add-loop') {
      const added = await addStage(stages, 'review-loop');
      if (added) stages.push(added);
    } else if (action.kind === 'remove') {
      const removed = await removeStage(stages);
      if (removed !== undefined) stages.splice(removed, 1);
    } else if (action.kind === 'move') {
      await reorderStages(stages);
    } else if (action.kind === 'reset') {
      if (await confirm('Replace current stages with the defaults?')) {
        stages.splice(0, stages.length, ...cloneStages(DEFAULT_STAGES));
      }
    }
  }
}

async function addStage(
  stages: StageEntry[],
  kind: 'normal' | 'review-loop',
): Promise<StageEntry | undefined> {
  const id = (await readLine(chalk.cyan('  new stage id: '))).trim();
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    console.log(chalk.red('  id must be lowercase a-z, 0-9, hyphens'));
    return undefined;
  }
  if (stages.some((s) => s.id === id)) {
    console.log(chalk.red(`  id "${id}" already exists`));
    return undefined;
  }
  const defaultLabel = kind === 'review-loop' ? `harnext:${id}-loop` : `harnext:${id}`;
  const label =
    (await readLine(chalk.cyan(`  label [${defaultLabel}]: `))).trim() || defaultLabel;
  const labelErr = validateStageLabel(label, stages);
  if (labelErr) {
    console.log(chalk.red(`  ${labelErr}`));
    return undefined;
  }

  if (kind === 'normal') {
    const mode = await pickStageMode('human-approval');
    if (!mode) return undefined;
    const prompt = await editPrompt('', {
      title: `Prompt for new stage "${id}"`,
      allowEmpty: false,
    });
    if (!prompt) {
      console.log(chalk.red('  prompt cannot be empty'));
      return undefined;
    }
    return { kind: 'normal', id, label, mode, prompt };
  }

  // review-loop
  const maxIterations = await pickIterations();
  if (maxIterations === undefined) return undefined;

  const reviewPrompt = await editPrompt('', {
    title: `Review prompt for "${id}" (reviewer agent — posts the PR review)`,
    allowEmpty: false,
  });
  if (!reviewPrompt) {
    console.log(chalk.red('  review prompt cannot be empty'));
    return undefined;
  }
  const fixPrompt = await editPrompt('', {
    title: `Fix prompt for "${id}" (fixer agent — addresses changes_requested)`,
    allowEmpty: false,
  });
  if (!fixPrompt) {
    console.log(chalk.red('  fix prompt cannot be empty'));
    return undefined;
  }
  const onExit = await pickStageMode(
    'human-approval',
    'When the loop terminates (approved/commented)…',
  );
  if (!onExit) return undefined;

  const group: ReviewLoopStage = {
    kind: 'review-loop',
    id,
    label,
    maxIterations,
    review: { prompt: reviewPrompt },
    fix: { prompt: fixPrompt },
    onExit,
  };
  return group;
}

/** Relative workflow path we suggest when generating a file for a stage. */
function defaultWorkflowPath(stageId: string): string {
  return `.github/workflows/harnext-${stageId}.yml`;
}

function isValidWorkflowPath(p: string): boolean {
  return (
    p.startsWith('.github/workflows/') &&
    (p.endsWith('.yml') || p.endsWith('.yaml')) &&
    !p.includes('..')
  );
}

/** List existing workflow files under `.github/workflows/` relative to cwd. */
function listExistingWorkflows(cwd: string): string[] {
  const dir = join(cwd, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
      .map((n) => `.github/workflows/${n}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Per-stage runner picker: run after stages are finalized. For each stage
 * the user can keep `local` (default), connect an existing workflow file,
 * or ask the coding agent to generate one. Mutates `stages` in place. The
 * generator, preview, and keep/discard are all wired up here — the caller
 * just consumes the updated stage entries.
 */
async function runRunnersStep(
  stages: StageEntry[],
  cfg: { repo: string; codingAgent: CodingAgentId; codingAgentModel?: string },
  cwd: string,
): Promise<void> {
  console.log();
  console.log(chalk.bold('  Step: per-stage runner (local vs github-actions)'));
  console.log(
    chalk.dim(
      '    Local stages are run by the cron poller on this machine. Stages marked',
    ),
  );
  console.log(
    chalk.dim(
      '    github-actions skip the poller entirely — a workflow file owns the',
    ),
  );
  console.log(chalk.dim('    agent invocation and the label transition.'));

  let wroteAnyFile = false;

  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    // The labeled cascade only chains to the next labeled stage. Stages
    // with non-labeled triggers (e.g. doc-gardening on pr-merged) live
    // outside the cascade — they fire on their own event and never
    // receive a label-add from the previous stage. Skip past them when
    // computing the "next" stage for transition specs.
    const nextLabeledStage = stages.slice(i + 1).find((s) => getStageTrigger(s) === 'labeled');
    const nextLabel = nextLabeledStage?.label;
    // Terminal mode for this stage: normal stages use `mode`, review-loop
    // stages use `onExit`. We only bake a dispatch hint into the generated
    // workflow for yolo transitions — human-approval hands off to a
    // human so no automatic next-stage firing is wanted.
    const exitMode = stage.kind === 'review-loop' ? stage.onExit : stage.mode;
    const nextWorkflowFilename =
      exitMode === 'yolo' && nextLabeledStage
        ? basename(defaultWorkflowPath(nextLabeledStage.id))
        : undefined;
    console.log();
    console.log(
      chalk.bold(`  Stage ${i + 1}: `) +
        chalk.cyan(stage.id) +
        chalk.dim(` (${stage.label})`),
    );

    const current = getStageRunner(stage);

    // First decision: where does this stage run?
    type WhereChoice = { kind: 'self-hosted' } | { kind: 'github-hosted' } | { kind: 'skip' };
    const whereItems: SelectItem<WhereChoice>[] = [
      {
        label: 'This PC (self-hosted)',
        value: { kind: 'self-hosted' },
        hint:
          current.runsOn === 'self-hosted'
            ? 'current — workflow targets a runner registered on your machine'
            : 'workflow targets a runner registered on your machine',
      },
      {
        label: 'GitHub-hosted runners',
        value: { kind: 'github-hosted' },
        hint:
          current.runsOn === 'github-hosted'
            ? 'current — workflow runs on ubuntu-latest'
            : 'workflow runs on ubuntu-latest (billed against the repo)',
      },
      { label: 'Skip (keep as-is)', value: { kind: 'skip' } },
    ];
    // `verify` runs on the user's PC by default (it tends to need their
    // local toolchain — node modules, browser binaries, etc.). Every
    // other stage defaults to GitHub-hosted so users don't need to
    // register a runner just to ship the pipeline.
    if (stage.id !== 'verify') {
      [whereItems[0], whereItems[1]] = [whereItems[1], whereItems[0]];
    }
    const where = await select(whereItems, { title: 'How should this stage run?' });
    if (!where || where.kind === 'skip') continue;
    const runsOn: RunsOn = where.kind === 'self-hosted' ? 'self-hosted' : 'github-hosted';

    // Second decision: connect to an existing workflow file, or generate one?
    type SourceChoice = { kind: 'connect' } | { kind: 'generate' };
    const generateItem: SelectItem<SourceChoice> = {
      label: 'Generate a fresh workflow',
      value: { kind: 'generate' },
      hint: `ask ${cfg.codingAgent} to write ${defaultWorkflowPath(stage.id)}`,
    };
    const connectItem: SelectItem<SourceChoice> = {
      label: 'Connect an existing workflow',
      value: { kind: 'connect' },
      hint: 'point at a workflow file you already authored',
    };
    const source = await select([generateItem, connectItem], {
      title: 'Where does the workflow file come from?',
    });
    if (!source) continue;

    if (source.kind === 'connect') {
      const reviewPath = await pickConnectedWorkflowPath(stage, cwd);
      if (!reviewPath) continue;
      (stage as { runner?: StageRunner }).runner = {
        workflowPath: reviewPath,
        origin: 'connected',
        runsOn,
      } satisfies StageRunner;
      if (stage.kind === 'review-loop') {
        const fixPath = deriveFixWorkflowPath(reviewPath);
        console.log(
          chalk.green(`  Connected → ${reviewPath} (review) + ${fixPath} (fix) [${runsOn}]`),
        );
      } else {
        console.log(chalk.green(`  Connected → ${reviewPath} (${runsOn})`));
      }
      continue;
    }

    // generate
    const relPath = defaultWorkflowPath(stage.id);
    if (stage.kind === 'review-loop') {
      const fixRel = deriveFixWorkflowPath(relPath);
      const wrote = await generateReviewLoopPair({
        cwd,
        stage,
        cfg,
        runsOn,
        reviewRelPath: relPath,
        fixRelPath: fixRel,
        nextLabel,
        nextWorkflowFilename,
      });
      if (wrote) wroteAnyFile = true;
      continue;
    }
    const absTarget = join(cwd, relPath);
    if (existsSync(absTarget)) {
      console.log(chalk.yellow(`  ${relPath} already exists.`));
      if (!(await confirm('Overwrite it with a freshly generated workflow?'))) {
        continue;
      }
    }
    (stage as { runner?: StageRunner }).runner = {
      workflowPath: relPath,
      origin: 'generated',
      runsOn,
    } satisfies StageRunner;
    const ok = await generateAndPreviewWorkflow({
      cwd,
      stage,
      cfg,
      relPath,
      nextLabel,
      nextWorkflowFilename,
    });
    if (ok) {
      wroteAnyFile = true;
      console.log(chalk.green(`  Connected → ${relPath} (${runsOn})`));
    }
  }

  if (stages.length > 0) {
    console.log();
    console.log(chalk.bold('  Reminder:'));
    if (wroteAnyFile) {
      console.log(
        chalk.dim('    • git add .github/workflows/ && commit && push the generated workflow(s)'),
      );
    }
    printAgentSecretsReminder(cfg.codingAgent, cfg.repo);
    console.log();
  }
}

/**
 * Pick (or type in) a workflow path for the "connect existing workflow"
 * branch. Returns the validated repo-relative path, or undefined if the
 * user cancelled.
 */
async function pickConnectedWorkflowPath(
  stage: StageEntry,
  cwd: string,
): Promise<string | undefined> {
  const existing = listExistingWorkflows(cwd);
  let workflowPath: string | undefined;
  if (existing.length > 0) {
    const pathItems: SelectItem<string>[] = existing.map((p) => ({
      label: p,
      value: p,
    }));
    pathItems.push({ label: 'Enter a path manually…', value: '__manual__' });
    const picked = await select(pathItems, {
      title: 'Which workflow file handles this stage?',
    });
    if (!picked) return undefined;
    workflowPath = picked === '__manual__' ? undefined : picked;
  }
  if (!workflowPath) {
    const answer = (
      await readLine(chalk.cyan(`  workflow path [${defaultWorkflowPath(stage.id)}]: `))
    ).trim() || defaultWorkflowPath(stage.id);
    if (!isValidWorkflowPath(answer)) {
      console.log(chalk.red('  must start with .github/workflows/ and end with .yml or .yaml'));
      return undefined;
    }
    workflowPath = answer;
  }
  return workflowPath;
}

/**
 * Generate, preview, and confirm a single workflow. Returns true iff the
 * user kept the file. Caller is responsible for setting `stage.runner`
 * before calling so the generator can read `runsOn` off the stage.
 */
async function generateAndPreviewWorkflow(args: {
  cwd: string;
  stage: StageEntry;
  cfg: { codingAgent: CodingAgentId; codingAgentModel?: string; repo: string };
  relPath: string;
  nextLabel: string | undefined;
  nextWorkflowFilename: string | undefined;
  phase?: 'review' | 'fix';
  companionWorkflowFilename?: string;
}): Promise<boolean> {
  const { cwd, stage, cfg, relPath, nextLabel, nextWorkflowFilename } = args;
  const phaseTag = args.phase ? ` [${args.phase}]` : '';
  console.log(
    chalk.dim(
      `  Spinning up ${cfg.codingAgent} to write ${relPath}${phaseTag} (this may take 1–2 minutes)…`,
    ),
  );
  try {
    const result = await generateStageWorkflow({
      cwd,
      stage,
      cfg: {
        repo: cfg.repo,
        pollIntervalMinutes: 15,
        filter: { kind: 'none' },
        intake: { enabled: true },
        stages: [],
        codingAgent: cfg.codingAgent,
        codingAgentModel: cfg.codingAgentModel,
        updatedAt: Date.now(),
      },
      relativeWorkflowPath: relPath,
      nextLabel,
      awaitingLabel: AWAITING_APPROVAL_LABEL,
      needsJudgmentLabel: NEEDS_JUDGMENT_LABEL,
      nextWorkflowFilename,
      // post-merge stages (e.g. doc-gardening) emit a `pull_request: [closed]`
      // trigger; everything else uses the default labeled cascade.
      triggerOn: getStageTrigger(stage) === 'pr-merged' ? 'pr-merged' : 'both',
      phase: args.phase,
      companionWorkflowFilename: args.companionWorkflowFilename,
    });
    if (!result.wroteFile || !result.workflowContent) {
      console.log(chalk.red('  Agent did not write the expected workflow file.'));
      if (result.error) console.log(chalk.dim(`    ${result.error}`));
      return false;
    }
    console.log();
    console.log(chalk.bold(`  Generated ${relPath}${phaseTag}:`));
    console.log(chalk.dim('  ' + '─'.repeat(70)));
    for (const line of result.workflowContent.split('\n')) {
      console.log('  ' + line);
    }
    console.log(chalk.dim('  ' + '─'.repeat(70)));
    console.log();
    const keep = await confirm(`Keep ${relPath}?`, true);
    if (!keep) {
      try {
        unlinkSync(result.workflowPath);
        console.log(chalk.dim(`  Discarded ${relPath}.`));
      } catch (err) {
        console.log(
          chalk.yellow(
            `  Could not remove ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return false;
    }
    return true;
  } catch (err) {
    console.log(
      chalk.red('  Generator failed: ') + (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}

/**
 * Generate the review + fix workflow pair for a review-loop stage. They
 * are kept/discarded as a unit — a half-applied pair would leave the loop
 * broken. Returns true iff at least one file was kept.
 */
async function generateReviewLoopPair(args: {
  cwd: string;
  stage: StageEntry;
  cfg: { codingAgent: CodingAgentId; codingAgentModel?: string; repo: string };
  runsOn: RunsOn;
  reviewRelPath: string;
  fixRelPath: string;
  nextLabel: string | undefined;
  nextWorkflowFilename: string | undefined;
}): Promise<boolean> {
  const { cwd, stage, cfg, runsOn, reviewRelPath, fixRelPath, nextLabel, nextWorkflowFilename } = args;
  for (const p of [reviewRelPath, fixRelPath]) {
    if (existsSync(join(cwd, p))) {
      console.log(chalk.yellow(`  ${p} already exists.`));
      if (!(await confirm(`Overwrite ${p}?`))) return false;
    }
  }
  // Set the runner on the stage so the generator emits the right `runs-on:`.
  // The wizard treats the review workflow path as the canonical one stored
  // in the config; the fix path is derived from it via `deriveFixWorkflowPath`.
  (stage as { runner?: StageRunner }).runner = {
    workflowPath: reviewRelPath,
    origin: 'generated',
    runsOn,
  } satisfies StageRunner;

  const reviewKept = await generateAndPreviewWorkflow({
    cwd,
    stage,
    cfg,
    relPath: reviewRelPath,
    nextLabel,
    nextWorkflowFilename,
    phase: 'review',
    companionWorkflowFilename: basename(fixRelPath),
  });
  const fixKept = await generateAndPreviewWorkflow({
    cwd,
    stage,
    cfg,
    relPath: fixRelPath,
    nextLabel,
    nextWorkflowFilename,
    phase: 'fix',
    companionWorkflowFilename: basename(reviewRelPath),
  });

  if (!reviewKept && !fixKept) return false;
  if (reviewKept && !fixKept) {
    console.log(
      chalk.yellow(
        `  Heads-up: kept ${reviewRelPath} but discarded ${fixRelPath} — the loop will`,
      ),
    );
    console.log(
      chalk.yellow(
        `  fail to dispatch the fix step until you author ${fixRelPath} yourself.`,
      ),
    );
  }
  if (!reviewKept && fixKept) {
    console.log(
      chalk.yellow(
        `  Heads-up: discarded ${reviewRelPath} but kept ${fixRelPath} — nothing will`,
      ),
    );
    console.log(
      chalk.yellow(
        `  trigger the fix workflow until you author the review entry yourself.`,
      ),
    );
  }
  console.log(
    chalk.green(
      `  Connected → ${reviewRelPath} (review) + ${fixRelPath} (fix) [${runsOn}]`,
    ),
  );
  return true;
}

/**
 * Agent-specific setup checklist printed after any stage gets wired to
 * GitHub Actions. Keeps the authoritative "what secret does the workflow
 * actually need" answer in one place so it cannot drift from the workflow
 * generator's auth choice.
 */
function printAgentSecretsReminder(agent: CodingAgentId, repo: string): void {
  if (agent === 'claude-code') {
    console.log(
      chalk.dim('    • Install the Claude Code GitHub App on ') + chalk.cyan(repo),
    );
    console.log(
      chalk.dim('      (https://github.com/apps/claude — the workflow authenticates via OAuth,'),
    );
    console.log(
      chalk.dim("       billed against the user's Claude subscription, not API usage)"),
    );
    console.log(
      chalk.dim(`    • gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${repo}`),
    );
    console.log(
      chalk.dim('    • Repo Settings → Actions → General → enable'),
    );
    console.log(
      chalk.dim('      "Allow GitHub Actions to create and approve pull requests"'),
    );
    return;
  }
  if (agent === 'codex') {
    console.log(
      chalk.dim(`    • gh secret set OPENAI_API_KEY --repo ${repo}`),
    );
    return;
  }
  // harnext — user picks the provider via /model, so any provider key could apply.
  console.log(
    chalk.dim(
      `    • gh secret set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_API_KEY` +
        ` as your provider needs) --repo ${repo}`,
    ),
  );
}

async function removeStage(stages: StageEntry[]): Promise<number | undefined> {
  const items: SelectItem<number>[] = stages.map((s, i) => ({
    label: `${i + 1}. ${s.id}`,
    value: i,
    hint: s.label,
  }));
  const idx = await select(items, { title: 'Remove which stage?' });
  if (idx === undefined) return undefined;
  if (!(await confirm(`Remove stage "${stages[idx].id}"?`))) return undefined;
  return idx;
}

async function reorderStages(stages: StageEntry[]): Promise<void> {
  console.log(chalk.dim('  Pick the stage to move, then pick its new position.'));
  const pickItems: SelectItem<number>[] = stages.map((s, i) => ({
    label: `${i + 1}. ${s.id}`,
    value: i,
    hint: s.label,
  }));
  const from = await select(pickItems, { title: 'Move which stage?' });
  if (from === undefined) return;
  const posItems: SelectItem<number>[] = stages.map((_, i) => ({
    label: `Position ${i + 1}`,
    value: i,
  }));
  const to = await select(posItems, { title: 'Move to which position?' });
  if (to === undefined) return;
  if (from === to) return;
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved);
}

/**
 * - `quick`: behaviour of the `/connect-github` slash command. Coding agent
 *   is fixed to `harnext`, model selection is deferred to the user's saved
 *   preferences. Used when the agent context is implicit (already inside
 *   harnext's REPL).
 * - `full`: behaviour of the top-level `harnext setup` command. Asks the
 *   user which coding agent should drive the pipeline and picks a model
 *   scoped to that agent. For `harnext`, reuses the provider+model picker
 *   and saves the choice as the user-level default so later pipeline runs
 *   pick it up via preferences.
 */
export type SetupMode = 'quick' | 'full';

export interface ConnectGithubOptions {
  cwd: string;
  /** Absolute path to the harnext CLI entrypoint (process.argv[1]). */
  cliPath: string;
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
  /** Defaults to `'quick'` for back-compat with `/connect-github`. */
  setupMode?: SetupMode;
}

/**
 * Top-level /connect-github entry point. Caller must have paused its sticky
 * input so readline/select own stdin.
 */
export async function runConnectGithubCommand(opts: ConnectGithubOptions): Promise<void> {
  const setupMode: SetupMode = opts.setupMode ?? 'quick';
  const existing = loadGithubConnection(opts.cwd);

  console.log();
  if (!existing) {
    if (setupMode === 'full') {
      console.log(chalk.bold('  harnext setup: no project configuration yet.'));
    } else {
      console.log(chalk.bold('  GitHub connection: not configured for this project.'));
    }
    console.log();
    await createFlow(opts, setupMode);
    return;
  }

  if (setupMode === 'full') {
    console.log(chalk.bold('  harnext setup: existing configuration for this project:'));
    console.log();
    printConfig(existing);
    console.log();
    console.log(chalk.bold('  Stages:'));
    renderStagesTable(existing.stages);
    console.log();

    type FullAction =
      | { kind: 'keep' }
      | { kind: 'stages' }
      | { kind: 'reconfigure' }
      | { kind: 'remove' };

    const items: SelectItem<FullAction>[] = [
      { label: 'Keep current configuration', value: { kind: 'keep' } },
      {
        label: 'Change stages only',
        value: { kind: 'stages' },
        hint: 'edit workflow stages without re-picking the coding agent or model',
      },
      {
        label: 'Reconfigure everything',
        value: { kind: 'reconfigure' },
        hint: 're-run full wizard from the coding-agent picker',
      },
      { label: 'Remove configuration', value: { kind: 'remove' } },
    ];

    const action = await select(items, { title: 'What do you want to do?' });
    if (!action || action.kind === 'keep') {
      console.log(chalk.dim('  Nothing changed.'));
      console.log();
      return;
    }

    switch (action.kind) {
      case 'stages':
        await stagesOnlyFlow(opts, existing);
        return;
      case 'reconfigure':
        await createFlow(opts, setupMode, existing);
        return;
      case 'remove':
        await removeFlow(opts);
        return;
    }
  }

  console.log(chalk.bold('  GitHub connection for this project:'));
  printConfig(existing);
  console.log();

  type TopAction =
    | { kind: 'view' }
    | { kind: 'edit' }
    | { kind: 'remove' }
    | { kind: 'cancel' };

  const items: SelectItem<TopAction>[] = [
    { label: 'View full config', value: { kind: 'view' }, hint: 'print the agent prompt and filter' },
    { label: 'Edit', value: { kind: 'edit' }, hint: 're-run the wizard with current values as defaults' },
    { label: 'Remove', value: { kind: 'remove' }, hint: 'delete this project\'s github.json' },
    { label: 'Cancel', value: { kind: 'cancel' } },
  ];

  const action = await select(items, { title: 'What do you want to do?' });
  if (!action || action.kind === 'cancel') {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  switch (action.kind) {
    case 'view':
      viewFlow(existing);
      return;
    case 'edit':
      await createFlow(opts, setupMode, existing);
      return;
    case 'remove':
      await removeFlow(opts);
      return;
  }
}

function formatIntake(intake: IntakeStage): string {
  return intake.enabled
    ? 'auto-tag new issues with the first stage label'
    : 'manual (humans label issues themselves)';
}

function printConfig(cfg: GithubConnectionConfig): void {
  const agentLine = cfg.codingAgentModel
    ? `${cfg.codingAgent} (${cfg.codingAgentModel})`
    : cfg.codingAgent;
  console.log(chalk.dim(`    agent:    `) + chalk.cyan(agentLine));
  console.log(chalk.dim(`    repo:     `) + chalk.cyan(cfg.repo));
  console.log(chalk.dim(`    filter:   `) + formatFilter(cfg.filter));
  console.log(chalk.dim(`    intake:   `) + formatIntake(cfg.intake));
  console.log(
    chalk.dim(`    stages:   `) +
      `${cfg.stages.length} (${cfg.stages.map((s) => s.id).join(' → ')})`,
  );
  const selfHostedCount = cfg.stages.filter(
    (s) => getStageRunner(s).runsOn === 'self-hosted',
  ).length;
  if (selfHostedCount > 0) {
    console.log(
      chalk.dim(`    runners:  `) +
        chalk.cyan(`${selfHostedCount}`) +
        chalk.dim(` stage${selfHostedCount === 1 ? '' : 's'} on this PC (self-hosted), `) +
        `${cfg.stages.length - selfHostedCount} on github-hosted`,
    );
  }
}

function viewFlow(cfg: GithubConnectionConfig): void {
  console.log();
  printConfig(cfg);
  console.log();
  console.log(chalk.bold('  Stages:'));
  renderStagesTable(cfg.stages);
  console.log();
  for (const stage of cfg.stages) {
    if (stage.kind === 'review-loop') {
      console.log(chalk.bold(`  Stage "${stage.id}" (review-loop):`));
      console.log(chalk.dim(`    iterations: ${stage.maxIterations}, onExit: ${stage.onExit}`));
      console.log(chalk.bold(`    review prompt:`));
      for (const line of stage.review.prompt.split('\n')) console.log(`      ${line}`);
      console.log(chalk.bold(`    fix prompt:`));
      for (const line of stage.fix.prompt.split('\n')) console.log(`      ${line}`);
      console.log();
      continue;
    }
    console.log(chalk.bold(`  Stage "${stage.id}" prompt:`));
    for (const line of stage.prompt.split('\n')) {
      console.log(`    ${line}`);
    }
    console.log();
  }
}

async function stagesOnlyFlow(
  opts: ConnectGithubOptions,
  existing: GithubConnectionConfig,
): Promise<void> {
  console.log();
  console.log(chalk.bold('  Edit workflow stages.'));
  console.log(
    chalk.dim('    coding agent, model, repo, interval, and filter stay as they are.'),
  );

  const newStages = await runStagesStep(opts.cwd, existing.stages);
  if (!newStages) {
    console.log(chalk.dim('  Cancelled — stages unchanged.'));
    console.log();
    return;
  }

  await runRunnersStep(
    newStages,
    {
      repo: existing.repo,
      codingAgent: existing.codingAgent,
      codingAgentModel: existing.codingAgentModel,
    },
    opts.cwd,
  );

  const updated: GithubConnectionConfig = {
    ...existing,
    stages: newStages,
    updatedAt: Date.now(),
  };

  console.log();
  console.log(chalk.bold('  Ready to save:'));
  printConfig(updated);
  console.log();

  if (!(await confirm('Save these stages?', true))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  try {
    saveGithubConnection(opts.cwd, updated);
    console.log(chalk.dim('  Ensuring pipeline labels exist on the repo…'));
    const labelResult = ensureRepoLabels(updated.repo, buildHarnextLabelSpecs(updated.stages));
    if (labelResult.created.length > 0) {
      console.log(chalk.green(`    created: ${labelResult.created.join(', ')}`));
    }
    if (labelResult.existed.length > 0) {
      console.log(chalk.dim(`    existed: ${labelResult.existed.join(', ')}`));
    }
    if (labelResult.failed.length > 0) {
      console.log(chalk.yellow('    failed:'));
      for (const f of labelResult.failed) {
        console.log(chalk.yellow(`      ${f.name}: ${f.message}`));
      }
    }
    console.log(chalk.green('  Stages updated.'));
    console.log();
  } catch (err) {
    console.log(
      chalk.red('  Failed to save: ') + (err instanceof Error ? err.message : String(err)),
    );
    console.log();
  }
}

async function removeFlow(opts: ConnectGithubOptions): Promise<void> {
  if (!(await confirm('Remove the GitHub connection for this project?'))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  const meta = tryLoadRunnerMetadata(opts.cwd);
  if (meta) {
    if (
      await confirm(
        `Also deregister the self-hosted runner (${meta.runnerName}) and uninstall its service?`,
        true,
      )
    ) {
      console.log(chalk.dim('  Deregistering runner…'));
      const result = await deregisterRunner(opts.cwd);
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.log(chalk.yellow(`    ${err}`));
        }
      } else {
        console.log(chalk.green('  Runner deregistered.'));
      }
    }
  }

  const removed = deleteGithubConnection(opts.cwd);
  if (removed) {
    console.log(chalk.green('  GitHub connection removed.'));
  } else {
    console.log(chalk.yellow('  No config file found to remove.'));
  }
  console.log();
}

/**
 * Analyze-codebase step: offers to (re-)run the codebase profiler, persist
 * the profile, install bundled skills into the agent's skills dir, generate
 * project-specific skills, and tailor the stage prompts off the profile.
 *
 * Returns the stage baseline to feed into `runStagesStep` — tailored when
 * the analysis succeeds, unchanged when the user skips or anything fails.
 * Any failure here is soft: we warn and fall back to the baseline so the
 * wizard never blocks the user on flaky agent runs.
 */
/**
 * Pretty-print a one-line summary of the tech stack so the user can see
 * what the agent inferred (or what it's about to reuse).
 */
function printTechStackSummary(stack: TechStack): void {
  const lang = stack.root.language;
  const fw = stack.root.framework ? `, framework: ${stack.root.framework}` : '';
  const gen = stack.generatedAt.slice(0, 10);
  const mono = stack.isMonorepo ? `, monorepo (${stack.packages.length} packages)` : '';
  console.log(chalk.dim(`      language: ${lang}${fw}${mono}, generated: ${gen}`));
  if (stack.root.testCommand) console.log(chalk.dim(`      test:     ${stack.root.testCommand}`));
  if (stack.root.lintCommand) console.log(chalk.dim(`      lint:     ${stack.root.lintCommand}`));
  if (stack.root.buildCommand) console.log(chalk.dim(`      build:    ${stack.root.buildCommand}`));
}

/**
 * Subscribe-style progress printer for the code-analysis pipeline.
 * The pipeline emits start/ok/warn/error per sub-stage; the CLI prints
 * a single line per event so the user sees progress without having to
 * peek at the session dir.
 */
function makeAnalysisProgressPrinter(): (e: AnalysisEvent) => void {
  const labels: Record<AnalysisEvent['stage'], string> = {
    'tech-stack': 'tech-stack detection',
    'risk-contract': 'risk contract',
    'check-scripts': 'check scripts',
    'project-skills': 'project skills',
    'stage-prompts': 'stage prompts',
  };
  // Trim activity lines to the terminal width so multi-line terminal
  // wrap doesn't wreck the layout. stdout.columns is unset in CI /
  // piped mode — fall back to 120.
  const terminalWidth = (): number => {
    const c = process.stdout.columns;
    return typeof c === 'number' && c > 40 ? c : 120;
  };
  return (e) => {
    const label = labels[e.stage];
    if (e.status === 'start') {
      console.log(chalk.dim(`    ${label}…`));
      return;
    }
    if (e.status === 'activity') {
      const prefix = '      · ';
      const detail = e.detail ?? '';
      // Reserve room for the prefix; if the line still overflows,
      // truncate with an ellipsis so the UI stays single-line.
      const budget = Math.max(20, terminalWidth() - prefix.length - 1);
      const shown = detail.length > budget ? detail.slice(0, budget - 1) + '…' : detail;
      console.log(chalk.dim(prefix + shown));
      return;
    }
    if (e.status === 'ok') {
      console.log(chalk.green(`      ✓ ${label}`));
      return;
    }
    if (e.status === 'warn') {
      console.log(chalk.yellow(`      warning (${label}): ${e.detail ?? 'unknown'}`));
      return;
    }
    console.log(chalk.red(`      error (${label}): ${e.detail ?? 'unknown'}`));
  };
}

/**
 * Pre-populate every stage's `runner` field with a generated-workflow
 * entry pointing at the conventional path so the stages table renders
 * with the intended default before the user hits the runner picker.
 * The `verify` stage defaults to self-hosted (CI-style validation tends
 * to need the user's local toolchain); every other stage defaults to
 * GitHub-hosted.
 *
 * Stages that already have an explicit `runner` (e.g. a saved config
 * being edited) are left alone — user intent wins over defaults.
 *
 * When the TechStack detected a non-GitHub CI provider (GitLab,
 * CircleCI, etc.) we bail entirely and leave every stage as-is, since
 * harnext doesn't yet author workflows for those providers.
 */
function applyDefaultRunners(
  stages: StageEntry[],
  techStack: TechStack,
): StageEntry[] {
  const ci = techStack.ciProvider;
  const supportsGHA = ci === 'github-actions' || ci === null;
  if (!supportsGHA) return stages;

  return stages.map((stage) => {
    if (stage.runner) return stage;
    const runsOn: RunsOn = stage.id === 'verify' ? 'self-hosted' : 'github-hosted';
    const next: StageRunner = {
      workflowPath: `.github/workflows/harnext-${stage.id}.yml`,
      origin: 'generated',
      runsOn,
    };
    if (stage.kind === 'review-loop') {
      return { ...stage, runner: next };
    }
    return { ...(stage as NormalStage), runner: next };
  });
}

async function runAnalysisStep(
  cwd: string,
  codingAgent: CodingAgentId,
  codingAgentModel: string | undefined,
  baselineStages: StageEntry[],
): Promise<StageEntry[]> {
  const existing = loadTechStack(cwd);
  let reusedStack: TechStack | undefined;

  if (existing) {
    console.log(chalk.dim(`    Existing analysis: ${getTechStackPath(cwd)}`));
    printTechStackSummary(existing);
    type Choice = 'reuse' | 'reanalyze' | 'skip';
    const picked = await select<Choice>(
      [
        { label: 'Reuse existing analysis', value: 'reuse', hint: 'fast — skips tech detection' },
        {
          label: 'Re-analyze the codebase',
          value: 'reanalyze',
          hint: 'ask the agent again (may take 30-120s)',
        },
        {
          label: 'Skip — use generic stage prompts',
          value: 'skip',
          hint: 'the prompts in DEFAULT_STAGES are generic across any repo',
        },
      ],
      { title: 'Analyze codebase?' },
    );
    if (picked === 'skip' || picked === undefined) {
      return baselineStages;
    }
    if (picked === 'reuse') {
      reusedStack = existing;
    }
    // picked === 'reanalyze' → fall through (reusedStack stays undefined)
  } else {
    const shouldAnalyze = await confirm(
      `Analyze this codebase with ${codingAgent} to tailor prompts and skills?`,
      true,
    );
    if (!shouldAnalyze) {
      return baselineStages;
    }
    console.log(
      chalk.dim(`    Spinning up ${codingAgent} to survey the codebase (~30-120s)…`),
    );
  }

  const result = await runCodeAnalysisPipeline({
    cwd,
    codingAgent,
    codingAgentModel,
    baselineStages,
    techStack: reusedStack,
    onProgress: makeAnalysisProgressPrinter(),
  });

  // Summary after the pipeline returns.
  if (!reusedStack) {
    printTechStackSummary(result.techStack);
    if (result.techStack.root.language !== 'unknown') {
      console.log(chalk.green(`    Analysis saved → ${getTechStackPath(cwd)}`));
    }
  }
  if (result.contract) {
    const tiers = Object.keys(result.contract.riskTierRules);
    const allChecks = Array.from(
      new Set(
        tiers.flatMap((t) => result.contract!.mergePolicy[t].requiredChecks),
      ),
    );
    console.log(
      chalk.dim(
        `      contract:  ${tiers.length} tier${tiers.length === 1 ? '' : 's'} (${tiers.join(', ')}) · ${allChecks.length} check${allChecks.length === 1 ? '' : 's'}`,
      ),
    );
  }
  if (result.scriptsGenerated.length > 0) {
    const names = result.scriptsGenerated.map((p) => p.split('/').pop());
    console.log(chalk.dim(`      scripts generated: ${names.join(', ')}`));
  }
  if (result.scriptsPreserved.length > 0) {
    const names = result.scriptsPreserved.map((p) => p.split('/').pop());
    console.log(chalk.dim(`      scripts preserved: ${names.join(', ')}`));
  }
  if (result.skillsInstalled.length > 0) {
    console.log(chalk.dim(`      bundled skills installed: ${result.skillsInstalled.join(', ')}`));
  }
  if (result.skillsGenerated.length > 0) {
    console.log(chalk.dim(`      project skills generated: ${result.skillsGenerated.join(', ')}`));
  }
  if (result.sessionDir) {
    console.log(
      chalk.dim(`      session retained for debugging: ${result.sessionDir}`),
    );
  }

  return applyDefaultRunners(result.stages, result.techStack);
}

const SETUP_BRANCH_NAME = 'feat/setup-harnext';

/**
 * Warn the user when the setup wizard (`harnext setup` or `/connect-github`)
 * is invoked on the default branch (main/master) and offer to switch to a
 * fresh feature branch. Returns `false` if the user explicitly aborts so
 * the caller can stop the wizard. Skipped silently outside of git repos
 * and on any non-default branch.
 */
async function runBranchSafetyStep(cwd: string): Promise<boolean> {
  const branch = getCurrentGitBranch(cwd);
  if (branch !== 'main' && branch !== 'master') return true;

  console.log(chalk.bold('  Step: working branch'));
  console.log(
    chalk.yellow(`  You are on the default branch (${branch}).`),
  );
  console.log(
    chalk.dim(
      '    Setup writes workflow files and configuration to this repo. We',
    ),
  );
  console.log(
    chalk.dim(
      '    recommend doing it on a feature branch so the changes can land via PR.',
    ),
  );
  console.log();

  const accept = await confirm(
    `Create branch "${SETUP_BRANCH_NAME}" and continue?`,
    true,
  );
  if (!accept) {
    console.log(
      chalk.dim('  Continuing on ') + chalk.cyan(branch) + chalk.dim('.'),
    );
    console.log();
    return true;
  }

  const result = createAndSwitchBranch(cwd, SETUP_BRANCH_NAME);
  if (!result.ok) {
    console.log(chalk.red(`  Could not create branch: ${result.message}`));
    const cont = await confirm(`Continue on ${branch} anyway?`, false);
    if (!cont) {
      console.log(chalk.dim('  Cancelled.'));
      console.log();
      return false;
    }
    console.log();
    return true;
  }

  console.log(
    chalk.green('  Switched to new branch ') + chalk.cyan(SETUP_BRANCH_NAME),
  );
  console.log();
  return true;
}

/**
 * Friendly closing message after a successful save. Tailors the suggested
 * next step to whether the user is on a feature branch (open a PR) or the
 * default branch (commit + push directly).
 */
function printSetupComplete(cwd: string, cfg: GithubConnectionConfig): void {
  const branch = getCurrentGitBranch(cwd);
  const onDefaultBranch = branch === 'main' || branch === 'master';

  console.log(chalk.green.bold('  Your harness is ready!'));
  console.log();
  console.log(chalk.bold('  Next steps:'));
  console.log(
    chalk.dim('    1. Review the generated files under ') +
      chalk.cyan('.github/workflows/'),
  );
  if (onDefaultBranch || !branch) {
    console.log(
      chalk.dim('    2. Commit and push them to ') + chalk.cyan(cfg.repo),
    );
  } else {
    console.log(
      chalk.dim('    2. Commit them on ') +
        chalk.cyan(branch) +
        chalk.dim(' and open a PR to merge into main'),
    );
  }
  console.log(
    chalk.dim('    3. Label an issue with ') +
      chalk.cyan(cfg.stages[0]?.label ?? 'the first stage label') +
      chalk.dim(' and watch the harness run.'),
  );
  console.log();
  console.log(chalk.green('  Happy harnessing!'));
  console.log();
}

/**
 * Create (or edit) flow. When `current` is passed, its values are used as
 * defaults so the user can keep fields unchanged by accepting the default.
 */
async function createFlow(
  opts: ConnectGithubOptions,
  setupMode: SetupMode,
  current?: GithubConnectionConfig,
): Promise<void> {
  // Step 0 (full mode only): pick the coding agent + model.
  //
  // In quick mode we keep the previously-selected agent or fall back to
  // harnext — this is the implicit agent context of `/connect-github`, so
  // we never ask. In full mode we always ask, because `harnext setup` is
  // the place where the user chooses how the pipeline runs.
  if (!(await runBranchSafetyStep(opts.cwd))) {
    return;
  }

  let codingAgent: CodingAgentId = current?.codingAgent ?? 'harnext';
  let codingAgentModel: string | undefined = current?.codingAgentModel;

  if (setupMode === 'full') {
    console.log(chalk.bold('  Step: coding agent'));
    const pickedAgent = await pickCodingAgent(codingAgent);
    if (!pickedAgent) {
      console.log(chalk.dim('  Cancelled.'));
      console.log();
      return;
    }
    codingAgent = pickedAgent;
    console.log();

    // Pre-flight for claude-code: surface the OAuth requirement *before*
    // the user generates any workflows, so they know they need the App
    // installed before their first issue arrives — otherwise the first
    // Actions run fails with a confusing "authentication required" error.
    if (codingAgent === 'claude-code') {
      console.log(chalk.bold('  Claude Code setup (one-time):'));
      console.log(
        chalk.dim(
          '    Generated workflows authenticate via OAuth against the Claude Code',
        ),
      );
      console.log(
        chalk.dim(
          "    GitHub App — usage counts against the user's Claude subscription",
        ),
      );
      console.log(
        chalk.dim(
          '    (Pro/Max), which is materially cheaper than a metered API key.',
        ),
      );
      console.log();
      console.log(
        chalk.dim('      1. Install the Claude Code GitHub App: https://github.com/apps/claude'),
      );
      console.log(
        chalk.dim('      2. Set CLAUDE_CODE_OAUTH_TOKEN as a repo secret'),
      );
      console.log(
        chalk.dim('      3. Repo Settings → Actions → General → enable'),
      );
      console.log(
        chalk.dim('         "Allow GitHub Actions to create and approve pull requests"'),
      );
      console.log(
        chalk.dim(
          '    You can complete these after the wizard — the checklist will repeat',
        ),
      );
      console.log(chalk.dim('    at the end.'));
      console.log();
    }

    if (codingAgent === 'harnext') {
      // Delegate to the existing provider+model picker so the behaviour is
      // identical to /model. Persist as the user-level default so later
      // pipeline runs resolve it via preferences.
      console.log(chalk.bold('  Step: provider & model'));
      const picked = await pickModel();
      if (!picked) {
        console.log(chalk.dim('  Cancelled.'));
        console.log();
        return;
      }
      setDefault(picked.provider, picked.model.id);
      console.log(
        chalk.green('  Saved default: ') +
          chalk.bold(`${picked.provider}/${picked.model.id}`),
      );
      codingAgentModel = undefined;
      console.log();
    } else {
      console.log(chalk.bold(`  Step: ${codingAgent} model`));
      const pickedModel = await pickAgentModel(codingAgent, codingAgentModel);
      if (!pickedModel) {
        console.log(chalk.dim('  Cancelled.'));
        console.log();
        return;
      }
      codingAgentModel = pickedModel;
      console.log();
    }
  }

  // Step 1: verify gh auth.
  console.log(chalk.bold('  Step 1: verify gh CLI'));
  const auth = verifyGhAuth();
  if (!auth.ok) {
    console.log(chalk.red('  gh is not ready: ') + auth.message);
    console.log(chalk.dim('  Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.'));
    console.log();
    return;
  }
  console.log(
    chalk.green('  gh authenticated as ') +
      chalk.cyan(auth.value.username) +
      chalk.dim(` on ${auth.value.host}`),
  );
  console.log();

  // Step 1b: resolve & confirm repo from cwd.
  const repoResult = getRepoFromCwd(opts.cwd);
  if (!repoResult.ok) {
    console.log(chalk.red('  Could not detect a GitHub repo in the current directory.'));
    console.log(chalk.dim(`    ${repoResult.message}`));
    console.log(chalk.dim('  Run /connect-github from inside a git repo with a GitHub remote.'));
    console.log();
    return;
  }
  const detectedRepo = repoResult.value;
  const repoLabel = current && current.repo !== detectedRepo
    ? `${detectedRepo} (previously: ${current.repo})`
    : detectedRepo;
  console.log(chalk.bold('  Detected repo: ') + chalk.cyan(repoLabel));
  if (!(await confirm(`Connect this project to ${detectedRepo}?`, true))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  console.log();

  // Step 2: workflow stages. We run the codebase analyzer first (as a
  // sub-step inside this step) so the stage picker shows prompts already
  // tailored to this repo, then let the user edit stages and choose where
  // each runs.
  console.log(chalk.bold('  Step 2: workflow stages'));
  console.log(
    chalk.dim(
      '    First we offer to analyze the codebase to tailor stage prompts, then you pick',
    ),
  );
  console.log(
    chalk.dim(
      '    the pipeline and where each stage runs (local poller or GitHub Actions).',
    ),
  );
  const baselineStages = current?.stages ?? DEFAULT_STAGES;
  const tailoredStages = await runAnalysisStep(
    opts.cwd,
    codingAgent,
    codingAgentModel,
    baselineStages,
  );
  console.log();
  console.log(
    chalk.dim('    Each stage has its own prompt and mode. Accept defaults or customize.'),
  );
  const stages = await runStagesStep(opts.cwd, tailoredStages);
  if (!stages) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  console.log();

  // Per-stage runner picker. Lets the user punch individual stages over to
  // GitHub Actions (connect existing, or generate via the chosen agent).
  // Runs inside Step 2 because its outcome (any local stage?) decides
  // whether we even need to ask about the cron poll interval below.
  await runRunnersStep(
    stages,
    { repo: detectedRepo, codingAgent, codingAgentModel },
    opts.cwd,
  );

  // Step 3: filter.
  console.log(chalk.bold('  Step 3: issue filter (optional)'));
  const filter = await pickFilter(detectedRepo, current?.filter);
  if (!filter) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  console.log();

  // Step 3b: Stage 0 / intake. Decides whether the harnext-tagger
  // workflow is written. When enabled, new issues that match the filter
  // get the first stage's label automatically, kicking off the pipeline.
  console.log(chalk.bold('  Step 3b: Stage 0 — intake (auto-tag new issues)'));
  const intake = await pickIntake(current?.intake ?? DEFAULT_INTAKE);
  if (!intake) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  console.log();

  const firstStage = stages[0];
  if (intake.enabled && firstStage) {
    const { path, existed } = writeTaggerWorkflow({
      cwd: opts.cwd,
      firstStage,
      filter,
    });
    console.log(
      chalk.dim(
        `  Tagger workflow ${existed ? 'refreshed' : 'written'} → ${TAGGER_WORKFLOW_PATH}`,
      ),
    );
    console.log(
      chalk.dim(
        `    (auto-tags new issues matching the filter with ${firstStage.label})`,
      ),
    );
    void path;
    console.log();
  }

  // Step 4: self-hosted runner check. If any stage runs on this PC, we
  // refuse setup until the public-repo approval gate is in good shape
  // and then install + register the actions/runner so workflows can
  // dispatch to it.
  const selfHostedStages = stages.filter(
    (s) => getStageRunner(s).runsOn === 'self-hosted',
  );
  if (selfHostedStages.length > 0) {
    console.log(chalk.bold('  Step 4: self-hosted runner safety check'));
    const gate = checkPublicRepoApprovalGate(detectedRepo);
    if (!gate.ok) {
      console.log(chalk.red(`  Could not query repo permissions: ${gate.message}`));
      return;
    }
    if (gate.value.isPublic && !gate.value.approvalGateEnabled) {
      console.log(
        chalk.red(
          '  This is a PUBLIC repository and the fork-PR approval gate is not enabled.',
        ),
      );
      console.log(
        chalk.dim(
          '  Without the approval gate, anyone can fork the repo, edit the workflow YAML,',
        ),
      );
      console.log(
        chalk.dim(
          '  and run arbitrary code on your PC by submitting a PR. Harnext refuses to set',
        ),
      );
      console.log(
        chalk.dim(
          '  up self-hosted runners on public repos in this state — flip Settings →',
        ),
      );
      console.log(
        chalk.dim(
          '  Actions → "Require approval for first-time/outside contributors" and re-run setup.',
        ),
      );
      return;
    }
    if (gate.value.isPublic) {
      console.log(
        chalk.yellow(
          '  Public repo with approval gate enabled — fork PRs will require maintainer',
        ),
      );
      console.log(
        chalk.yellow(
          '  approval before any workflow runs on your PC. Treat every approval as a',
        ),
      );
      console.log(
        chalk.yellow(
          '  code-review checkpoint: an approved PR can run any commands the workflow says.',
        ),
      );
      if (!(await confirm('Continue with self-hosted runner setup?', true))) {
        console.log(chalk.dim('  Cancelled.'));
        return;
      }
    } else {
      console.log(chalk.dim('  Private repo — fork-PR risk does not apply.'));
    }
    console.log();
  }

  const cfg: GithubConnectionConfig = {
    repo: detectedRepo,
    pollIntervalMinutes: current?.pollIntervalMinutes ?? 60,
    filter,
    intake,
    stages,
    codingAgent,
    codingAgentModel,
    updatedAt: Date.now(),
  };

  console.log(chalk.bold('  Ready to save:'));
  printConfig(cfg);
  console.log();

  const confirmPrompt =
    selfHostedStages.length > 0
      ? 'Save this connection and register a self-hosted runner on this PC?'
      : 'Save this connection?';
  if (!(await confirm(confirmPrompt, true))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  try {
    saveGithubConnection(opts.cwd, cfg);

    if (selfHostedStages.length > 0) {
      console.log(chalk.dim('  Installing the actions/runner on this PC…'));
      try {
        const installResult = await installRunner(opts.cwd);
        console.log(
          chalk.dim(
            `    runner ${installResult.alreadyInstalled ? 'already on disk' : 'downloaded'} (v${installResult.release.version})`,
          ),
        );
        console.log(chalk.dim('  Registering it against the repo…'));
        const meta = await registerRunner({ cwd: opts.cwd, repo: cfg.repo });
        console.log(chalk.green(`    registered as ${meta.runnerName}`));
        console.log(chalk.dim('  Installing the runner as a background service…'));
        await installRunnerService(opts.cwd);
        console.log(chalk.green('    runner service started — workflows can dispatch to it now'));
      } catch (err) {
        console.log(
          chalk.red(
            `  self-hosted runner setup failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        console.log(
          chalk.dim(
            '  Connection config was saved; re-run `harnext setup` after fixing to retry runner setup.',
          ),
        );
      }
    } else {
      // No self-hosted stages — if a runner was previously registered for
      // this project, leave it in place. The user can `harnext setup`
      // again or remove it manually; we don't want to silently uninstall
      // their daemon out from under them.
    }

    console.log(chalk.dim('  Ensuring pipeline labels exist on the repo…'));
    const labelResult = ensureRepoLabels(cfg.repo, buildHarnextLabelSpecs(cfg.stages));
    if (labelResult.created.length > 0) {
      console.log(chalk.green(`    created: ${labelResult.created.join(', ')}`));
    }
    if (labelResult.existed.length > 0) {
      console.log(chalk.dim(`    existed: ${labelResult.existed.join(', ')}`));
    }
    if (labelResult.failed.length > 0) {
      console.log(chalk.yellow('    failed:'));
      for (const f of labelResult.failed) {
        console.log(chalk.yellow(`      ${f.name}: ${f.message}`));
      }
      console.log(
        chalk.dim('    (labels that failed can be created manually later with `gh label create`)'),
      );
    }

    const savedMsg =
      selfHostedStages.length > 0
        ? '  GitHub connection saved; self-hosted runner registered for this PC.'
        : '  GitHub connection saved (every stage runs on GitHub-hosted runners).';
    console.log(chalk.green(savedMsg));
    console.log(chalk.dim(`    config: ${getGithubConfigPath(opts.cwd)}`));
    console.log();

    printSetupComplete(opts.cwd, cfg);
  } catch (err) {
    console.log(
      chalk.red('  Failed to save config: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    console.log();
  }
}

/**
 * Pick whether Stage 0 (intake) is enabled.
 *
 * "Intake" is the label-apply step that pulls fresh, unlabeled issues into
 * the pipeline. When enabled, harnext writes a deterministic tagger
 * workflow that listens for issue events and applies the first stage's
 * label on matching issues, then dispatches the first stage's workflow.
 * When disabled, humans label issues themselves.
 */
async function pickIntake(current: IntakeStage): Promise<IntakeStage | undefined> {
  const items: SelectItem<boolean>[] = [
    {
      label: 'Auto-tag new issues',
      value: true,
      hint:
        current.enabled
          ? `current — tagger workflow at ${TAGGER_WORKFLOW_PATH}`
          : `harnext writes ${TAGGER_WORKFLOW_PATH} that auto-labels matching issues`,
    },
    {
      label: 'Manual labeling',
      value: false,
      hint:
        current.enabled
          ? 'humans add the first stage label themselves'
          : 'current — humans add the first stage label themselves',
    },
  ];
  const picked = await select(items, { title: 'Should harnext auto-tag new issues?' });
  if (picked === undefined) return undefined;
  return { enabled: picked };
}

async function pickFilter(
  repo: string,
  current?: GithubIssueFilter,
): Promise<GithubIssueFilter | undefined> {
  type Action =
    | { kind: 'none' }
    | { kind: 'label' }
    | { kind: 'assignee' }
    | { kind: 'cancel' };

  const hintFor = (kind: GithubIssueFilter['kind']): string | undefined =>
    current?.kind === kind ? 'current' : undefined;

  const items: SelectItem<Action>[] = [
    { label: 'No filter', value: { kind: 'none' }, hint: hintFor('none') ?? 'pick up any open issue' },
    { label: 'By label', value: { kind: 'label' }, hint: hintFor('label') ?? 'only issues with a specific label' },
    { label: 'By assignee', value: { kind: 'assignee' }, hint: hintFor('assignee') ?? 'only issues assigned to a specific user' },
    { label: 'Cancel', value: { kind: 'cancel' } },
  ];
  const action = await select(items, { title: 'Filter issues' });
  if (!action || action.kind === 'cancel') return undefined;

  if (action.kind === 'none') return { kind: 'none' };

  if (action.kind === 'label') {
    const result = listRepoLabels(repo);
    if (!result.ok) {
      console.log(chalk.red('  Could not fetch labels: ') + result.message);
      return undefined;
    }
    if (result.value.length === 0) {
      console.log(chalk.yellow('  This repo has no labels defined.'));
      return undefined;
    }
    const currentLabel = current?.kind === 'label' ? current.label : undefined;
    const labelItems: SelectItem<string>[] = result.value.map((lbl) => ({
      label: lbl.name,
      value: lbl.name,
      hint: currentLabel === lbl.name ? 'current' : (lbl.description || undefined),
    }));
    const picked = await select(labelItems, { title: `Pick a label (${result.value.length} available)` });
    if (!picked) return undefined;
    return { kind: 'label', label: picked };
  }

  // assignee
  const users = listRepoAssignableUsers(repo);
  if (!users.ok) {
    console.log(chalk.yellow('  Could not fetch assignable users: ') + users.message);
    return fallbackAssigneeEntry(current);
  }
  if (users.value.length === 0) {
    console.log(chalk.yellow('  No assignable users returned — type a login manually.'));
    return fallbackAssigneeEntry(current);
  }
  const currentAssignee = current?.kind === 'assignee' ? current.assignee : undefined;
  const userItems: SelectItem<string>[] = users.value.map((login) => ({
    label: login,
    value: login,
    hint: currentAssignee === login ? 'current' : undefined,
  }));
  userItems.push({ label: 'Type a login manually…', value: '__manual__' });
  const picked = await select(userItems, { title: `Pick an assignee (${users.value.length} users)` });
  if (!picked) return undefined;
  if (picked === '__manual__') return fallbackAssigneeEntry(current);
  return { kind: 'assignee', assignee: picked };
}

async function fallbackAssigneeEntry(
  current?: GithubIssueFilter,
): Promise<GithubIssueFilter | undefined> {
  const def = current?.kind === 'assignee' ? current.assignee : '';
  const answer = (await readLine(chalk.cyan(`  assignee login${def ? ` [${def}]` : ''}: `))).trim();
  const login = answer || def;
  if (!login) return undefined;
  return { kind: 'assignee', assignee: login };
}

async function pickCodingAgent(current: CodingAgentId): Promise<CodingAgentId | undefined> {
  const items: SelectItem<CodingAgentId>[] = listCodingAgents().map((spec) => ({
    label: spec.label,
    value: spec.id,
    hint: current === spec.id ? `current — ${spec.hint}` : spec.hint,
  }));
  return select(items, { title: 'Which coding agent should run this pipeline?' });
}

async function pickAgentModel(
  agent: CodingAgentId,
  current?: string,
): Promise<string | undefined> {
  const spec = getCodingAgentSpec(agent);
  if (spec.supportedModels.length === 0) {
    // Defensive: harnext has no static list and should never land here.
    console.log(chalk.red(`  No model list registered for ${agent}.`));
    return undefined;
  }
  const items: SelectItem<string>[] = spec.supportedModels.map((id) => ({
    label: id,
    value: id,
    hint: current === id ? 'current' : undefined,
  }));
  return select(items, {
    title: `Pick a model for ${spec.label} (passed as \`${spec.modelFlag ?? '--model'} <id>\`)`,
    pageSize: 15,
  });
}

// re-exports for callers that only want the wizard entry point
export type { GhResult };
