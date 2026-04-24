import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

import chalk from 'chalk';
import {
  AWAITING_APPROVAL_LABEL,
  DEFAULT_INTAKE,
  DEFAULT_STAGES,
  GITHUB_POLL_INTERVAL_PRESETS,
  NEEDS_JUDGMENT_LABEL,
  buildCronSchedule,
  buildGithubPollCronLine,
  buildHarnextLabelSpecs,
  deleteGithubConnection,
  ensureRepoLabels,
  findCronLine,
  generateStageWorkflow,
  getCodingAgentSpec,
  getGithubConfigPath,
  getGithubPollCronTag,
  getRepoFromCwd,
  getStageRunner,
  getTechStackPath,
  installCronLine,
  listCodingAgents,
  listRepoAssignableUsers,
  listRepoLabels,
  loadGithubConnection,
  loadTechStack,
  removeCronLine,
  runCodeAnalysisPipeline,
  saveGithubConnection,
  writeTaggerWorkflow,
  TAGGER_WORKFLOW_PATH,
  setDefault,
  verifyGhAuth,
  type AnalysisEvent,
  type CodingAgentId,
  type GhResult,
  type GithubActionsRunner,
  type GithubConnectionConfig,
  type GithubIssueFilter,
  type GithubPollIntervalMinutes,
  type IntakeStage,
  type NormalStage,
  type ReviewLoopStage,
  type StageEntry,
  type StageMode,
  type StageRunner,
  type TechStack,
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

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await readLine(chalk.cyan(`  ${question} ${suffix}: `))).trim();
  if (answer.length === 0) return defaultYes;
  if (defaultYes) return !/^n(o)?$/i.test(answer);
  return /^y(es)?$/i.test(answer);
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes === 60) return 'hourly';
  if (minutes < 1440) return `every ${minutes / 60}h`;
  return 'daily';
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
  if (r.kind === 'local') return 'local';
  return `gha:${basename(r.workflowPath)}`;
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
    const runnerColored = r.kind === 'local' ? chalk.dim(runnerRaw) : chalk.yellow(runnerRaw);
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
 * Simple runner toggle used inside the stage editors. Switches between
 * `local` and `github-actions`; for GHA the user picks (or types) a
 * workflow file path. Deeper "generate via agent" lives in `runRunnersStep`.
 */
async function editStageRunner(stage: StageEntry, cwd: string): Promise<boolean> {
  const current = getStageRunner(stage);
  type Choice = { kind: 'local' } | { kind: 'gha' };
  const items: SelectItem<Choice>[] = [
    {
      label: 'Local',
      value: { kind: 'local' },
      hint: current.kind === 'local' ? 'current — poller runs this stage' : 'poller runs this stage',
    },
    {
      label: 'GitHub Actions',
      value: { kind: 'gha' },
      hint:
        current.kind === 'github-actions'
          ? `current — ${current.workflowPath}`
          : 'workflow file owns agent invocation + label transition',
    },
  ];
  const picked = await select(items, { title: 'Where should this stage run?' });
  if (!picked) return false;
  if (picked.kind === 'local') {
    if (current.kind === 'local') return false;
    delete (stage as { runner?: StageRunner }).runner;
    return true;
  }
  const existing = listExistingWorkflows(cwd);
  let workflowPath =
    current.kind === 'github-actions' ? current.workflowPath : defaultWorkflowPath(stage.id);
  if (existing.length > 0) {
    const pathItems: SelectItem<string>[] = existing.map((p) => ({ label: p, value: p }));
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
  const prevOrigin =
    current.kind === 'github-actions' ? current.origin : 'connected';
  (stage as { runner?: StageRunner }).runner = {
    kind: 'github-actions',
    workflowPath,
    origin: prevOrigin,
  } satisfies GithubActionsRunner;
  return true;
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

    type Action =
      | { kind: 'label' }
      | { kind: 'prompt' }
      | { kind: 'mode' }
      | { kind: 'id' }
      | { kind: 'runner' }
      | { kind: 'done' };
    const items: SelectItem<Action>[] = [
      { label: 'Edit label', value: { kind: 'label' } },
      { label: 'Edit prompt', value: { kind: 'prompt' } },
      { label: 'Edit mode', value: { kind: 'mode' } },
      { label: 'Edit id', value: { kind: 'id' }, hint: 'internal identifier — used in logs' },
      {
        label: 'Edit runner',
        value: { kind: 'runner' },
        hint: 'local (poller runs it) or github-actions (workflow runs it)',
      },
      { label: 'Done', value: { kind: 'done' } },
    ];
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
        hint: 'local (poller runs the loop) or github-actions (workflow runs it)',
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
    const nextStage = stages[i + 1];
    const nextLabel = nextStage?.label;
    // Terminal mode for this stage: normal stages use `mode`, review-loop
    // stages use `onExit`. We only bake a dispatch hint into the generated
    // workflow for yolo transitions — human-approval hands off to a
    // human so no automatic next-stage firing is wanted.
    const exitMode = stage.kind === 'review-loop' ? stage.onExit : stage.mode;
    const nextWorkflowFilename =
      exitMode === 'yolo' && nextStage
        ? basename(defaultWorkflowPath(nextStage.id))
        : undefined;
    console.log();
    console.log(
      chalk.bold(`  Stage ${i + 1}: `) +
        chalk.cyan(stage.id) +
        chalk.dim(` (${stage.label})`),
    );

    type Choice =
      | { kind: 'local' }
      | { kind: 'connect' }
      | { kind: 'generate' }
      | { kind: 'skip' };
    const current = getStageRunner(stage);
    const localItem: SelectItem<Choice> = {
      label: 'Keep local',
      value: { kind: 'local' },
      hint: current.kind === 'local' ? 'current — poller runs this stage' : 'poller runs this stage',
    };
    const generateItem: SelectItem<Choice> = {
      label: 'Generate a new GitHub Actions workflow',
      value: { kind: 'generate' },
      hint: `ask ${cfg.codingAgent} to write .github/workflows/harnext-${stage.id}.yml`,
    };
    const connectItem: SelectItem<Choice> = {
      label: 'Connect existing GitHub Actions workflow',
      value: { kind: 'connect' },
      hint: 'point at a workflow file you already authored',
    };
    const skipItem: SelectItem<Choice> = { label: 'Skip (keep as-is)', value: { kind: 'skip' } };

    // Default preference per stage: `verify` runs local by default (it's
    // the CI-style validation stage and tends to need the user's node
    // env, browser, etc.). Every other stage defaults to GitHub Actions
    // so the pipeline ships to the remote workflow without the user
    // having to flip each one. The picker still offers all four — we
    // just reorder so the first item (the `select` widget's initial
    // highlight) matches the preferred default.
    const items: SelectItem<Choice>[] =
      stage.id === 'verify'
        ? [localItem, generateItem, connectItem, skipItem]
        : [generateItem, connectItem, localItem, skipItem];
    const choice = await select(items, { title: 'How should this stage run?' });
    if (!choice || choice.kind === 'skip') continue;

    if (choice.kind === 'local') {
      delete (stage as { runner?: StageRunner }).runner;
      continue;
    }

    if (choice.kind === 'connect') {
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
        if (!picked) continue;
        workflowPath = picked === '__manual__' ? undefined : picked;
      }
      if (!workflowPath) {
        const answer = (
          await readLine(
            chalk.cyan(`  workflow path [${defaultWorkflowPath(stage.id)}]: `),
          )
        ).trim() || defaultWorkflowPath(stage.id);
        if (!isValidWorkflowPath(answer)) {
          console.log(
            chalk.red(
              '  must start with .github/workflows/ and end with .yml or .yaml',
            ),
          );
          continue;
        }
        workflowPath = answer;
      }
      (stage as { runner?: StageRunner }).runner = {
        kind: 'github-actions',
        workflowPath,
        origin: 'connected',
      } satisfies GithubActionsRunner;
      console.log(chalk.green(`  Connected → ${workflowPath}`));
      continue;
    }

    // generate
    const relPath = defaultWorkflowPath(stage.id);
    const absTarget = join(cwd, relPath);
    if (existsSync(absTarget)) {
      console.log(chalk.yellow(`  ${relPath} already exists.`));
      if (!(await confirm('Overwrite it with a freshly generated workflow?'))) {
        continue;
      }
    }
    console.log(
      chalk.dim(
        `  Spinning up ${cfg.codingAgent} to write ${relPath} (this may take 1–2 minutes)…`,
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
          intake: { runner: { kind: 'local' } },
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
        triggerOn: 'both',
      });
      if (!result.wroteFile || !result.workflowContent) {
        console.log(chalk.red('  Agent did not write the expected workflow file.'));
        if (result.error) console.log(chalk.dim(`    ${result.error}`));
        continue;
      }
      console.log();
      console.log(chalk.bold(`  Generated ${relPath}:`));
      console.log(chalk.dim('  ' + '─'.repeat(70)));
      for (const line of result.workflowContent.split('\n')) {
        console.log('  ' + line);
      }
      console.log(chalk.dim('  ' + '─'.repeat(70)));
      console.log();
      const keep = await confirm('Keep this workflow?', true);
      if (!keep) {
        try {
          unlinkSync(result.workflowPath);
          console.log(chalk.dim('  Discarded.'));
        } catch (err) {
          console.log(
            chalk.yellow(
              `  Could not remove ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        continue;
      }
      (stage as { runner?: StageRunner }).runner = {
        kind: 'github-actions',
        workflowPath: relPath,
        origin: 'generated',
      } satisfies GithubActionsRunner;
      wroteAnyFile = true;
      console.log(chalk.green(`  Connected → ${relPath}`));
    } catch (err) {
      console.log(
        chalk.red('  Generator failed: ') +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const anyGha = stages.some((s) => getStageRunner(s).kind === 'github-actions');
  if (anyGha) {
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
  return intake.runner.kind === 'local'
    ? 'local (poller auto-labels)'
    : `github-actions (${intake.runner.workflowPath})`;
}

function printConfig(cfg: GithubConnectionConfig): void {
  const agentLine = cfg.codingAgentModel
    ? `${cfg.codingAgent} (${cfg.codingAgentModel})`
    : cfg.codingAgent;
  console.log(chalk.dim(`    agent:    `) + chalk.cyan(agentLine));
  console.log(chalk.dim(`    repo:     `) + chalk.cyan(cfg.repo));
  console.log(chalk.dim(`    interval: `) + formatInterval(cfg.pollIntervalMinutes));
  console.log(chalk.dim(`    filter:   `) + formatFilter(cfg.filter));
  console.log(chalk.dim(`    intake:   `) + formatIntake(cfg.intake));
  console.log(
    chalk.dim(`    stages:   `) +
      `${cfg.stages.length} (${cfg.stages.map((s) => s.id).join(' → ')})`,
  );
  const ghaCount = cfg.stages.filter((s) => getStageRunner(s).kind === 'github-actions').length;
  if (ghaCount > 0) {
    console.log(
      chalk.dim(`    runners:  `) +
        chalk.yellow(`${ghaCount}`) +
        chalk.dim(` stage${ghaCount === 1 ? '' : 's'} on github-actions, `) +
        `${cfg.stages.length - ghaCount} local`,
    );
  }
  if (cfg.lastSeenUpdatedAt) {
    console.log(chalk.dim(`    pointer:  `) + cfg.lastSeenUpdatedAt);
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
  const tag = getGithubPollCronTag(opts.cwd);
  try {
    removeCronLine(tag);
  } catch (err) {
    console.log(
      chalk.red('  Failed to update crontab: ') +
        (err instanceof Error ? err.message : String(err)),
    );
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
 * Pre-populate every non-verify stage's `runner` field with a
 * github-actions entry pointing at the conventional workflow path, so
 * the stages table renders with the intended default before the user
 * hits the runner picker. The `verify` stage stays local (by leaving
 * its `runner` field undefined — `getStageRunner` resolves to local).
 *
 * Stages that already have an explicit `runner` (e.g. a saved config
 * being edited) are left alone — user intent wins over defaults.
 *
 * When the TechStack detected a non-GitHub CI provider (GitLab,
 * CircleCI, etc.) we bail entirely and leave every stage local, since
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
    if (stage.id === 'verify') return stage;
    if (stage.runner) return stage;
    return {
      ...stage,
      runner: {
        kind: 'github-actions',
        workflowPath: `.github/workflows/harnext-${stage.id}.yml`,
        origin: 'generated',
      },
    } as StageEntry;
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

  // Step 3b: Stage 0 / intake runner. Explicit because it decides whether
  // the local poller is still needed at all. Previously we inferred this
  // from the first stage's runner — that tangled the "who applies the
  // first label" question with "where does stage 1 run," and made it
  // impossible to run a fully-GHA pipeline when the first stage happened
  // to be local.
  console.log(chalk.bold('  Step 3b: Stage 0 — intake runner'));
  console.log(
    chalk.dim('    Who applies the first stage label to new issues?'),
  );
  const intake = await pickIntake(current?.intake ?? DEFAULT_INTAKE);
  if (!intake) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }
  console.log();

  // Bootstrap tagger workflow. Only written when intake runs on
  // github-actions — otherwise the poller handles auto-labeling on its
  // next tick, and emitting a tagger workflow would create a second
  // writer on the same label boundary.
  const firstStage = stages[0];
  if (intake.runner.kind === 'github-actions' && firstStage) {
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
        `    (intake runs on github-actions — this workflow tags new issues`,
      ),
    );
    console.log(
      chalk.dim(
        `     matching the filter with ${firstStage.label}.)`,
      ),
    );
    // Reference `path` just to prove we held onto the absolute location
    // for any future pre-save validation. `TAGGER_WORKFLOW_PATH` is what
    // we surface to the user since it's git-relative.
    void path;
    console.log();
  }

  // Step 4: polling interval — needed when the poller has any job to do.
  // The poller has two jobs: apply the first-stage label to unlabeled
  // issues (when intake is local) and execute local stages (when any
  // stage runs locally). Skip the prompt and cron install only when
  // intake is GHA *and* every stage is GHA — in that case the
  // label-triggered workflows handle everything and polling is pointless.
  const needsPolling =
    intake.runner.kind === 'local' ||
    stages.some((s) => getStageRunner(s).kind === 'local');
  let interval: GithubPollIntervalMinutes;
  if (needsPolling) {
    console.log(chalk.bold('  Step 4: polling interval'));
    const picked = await pickInterval(current?.pollIntervalMinutes);
    if (!picked) {
      console.log(chalk.dim('  Cancelled.'));
      console.log();
      return;
    }
    interval = picked;
    console.log();
  } else {
    // Keep the config field populated with a sensible default so the
    // stored shape is unchanged — nothing reads it when there's no cron.
    interval = current?.pollIntervalMinutes ?? 60;
    console.log(
      chalk.dim(
        '  All stages run on GitHub Actions — skipping poll interval and cron install.',
      ),
    );
    console.log();
  }

  const cfg: GithubConnectionConfig = {
    repo: detectedRepo,
    pollIntervalMinutes: interval,
    filter,
    intake,
    stages,
    lastSeenUpdatedAt: current?.lastSeenUpdatedAt,
    codingAgent,
    codingAgentModel,
    updatedAt: Date.now(),
  };

  const tag = getGithubPollCronTag(opts.cwd);
  let cronLine: string | null = null;
  let existingCron: string | null = null;
  if (needsPolling) {
    const schedule = buildCronSchedule(cfg.pollIntervalMinutes);
    cronLine = buildGithubPollCronLine({
      schedule,
      cliPath: opts.cliPath,
      cwd: opts.cwd,
      tag,
      nodePath: opts.nodePath,
      path: process.env.PATH,
      sshAuthSock: process.env.SSH_AUTH_SOCK,
    });
    existingCron = findCronLine(tag);
  }

  console.log(chalk.bold('  Ready to save:'));
  printConfig(cfg);
  console.log();
  if (cronLine) {
    console.log(chalk.dim(`    cron ${existingCron ? '(replace)' : '(install)'}:`));
    console.log(chalk.dim(`      ${cronLine}`));
    console.log();
  }

  const confirmPrompt = cronLine
    ? 'Save this connection and install the cron line?'
    : 'Save this connection?';
  if (!(await confirm(confirmPrompt, true))) {
    console.log(chalk.dim('  Cancelled.'));
    console.log();
    return;
  }

  try {
    saveGithubConnection(opts.cwd, cfg);
    if (cronLine) {
      installCronLine(cronLine, tag);
    } else {
      // Previous setup may have written a cron line that's now stale
      // (e.g. the user moved every stage to GitHub Actions). Drop it so we
      // don't keep polling for work that's dispatched elsewhere.
      removeCronLine(tag);
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

    const savedMsg = cronLine
      ? '  GitHub connection saved and poller scheduled.'
      : '  GitHub connection saved (no poller — all stages on GitHub Actions).';
    console.log(chalk.green(savedMsg));
    console.log(chalk.dim(`    config: ${getGithubConfigPath(opts.cwd)}`));
    if (cronLine) {
      console.log(chalk.dim(`    cron tag: ${tag}`));
    }
    console.log();
  } catch (err) {
    console.log(
      chalk.red('  Failed to save config: ') +
        (err instanceof Error ? err.message : String(err)),
    );
    console.log(chalk.dim('  If this machine has no `crontab`, install cron first.'));
    console.log();
  }
}

/**
 * Pick where Stage 0 (intake) runs.
 *
 * "Intake" is the label-apply step that pulls fresh, unlabeled issues into
 * the pipeline. We don't ask for a prompt or mode here — intake runs no
 * agent. The only choice is *who* applies the first-stage label:
 *   - `local`: the cron poller, on its next tick. Matches the historical
 *     default before intake became an explicit field.
 *   - `github-actions`: a deterministic tagger workflow we generate from
 *     `tagger-workflow.ts`. When this is picked the poller MUST stay out
 *     of the auto-label codepath; the poller code enforces that via
 *     `cfg.intake.runner.kind === 'local'`.
 */
async function pickIntake(current: IntakeStage): Promise<IntakeStage | undefined> {
  type Choice = { kind: 'local' } | { kind: 'gha' };
  const currentKind = current.runner.kind;
  const items: SelectItem<Choice>[] = [
    {
      label: 'Local',
      value: { kind: 'local' },
      hint:
        currentKind === 'local'
          ? 'current — poller auto-labels new issues on its next tick'
          : 'poller auto-labels new issues on its next tick',
    },
    {
      label: 'GitHub Actions',
      value: { kind: 'gha' },
      hint:
        currentKind === 'github-actions'
          ? `current — ${TAGGER_WORKFLOW_PATH}`
          : 'generated tagger workflow applies the first-stage label on issue events',
    },
  ];
  const picked = await select(items, {
    title: 'Stage 0 — where should intake (apply first-stage label) run?',
  });
  if (!picked) return undefined;
  if (picked.kind === 'local') {
    return { runner: { kind: 'local' } };
  }
  return {
    runner: {
      kind: 'github-actions',
      workflowPath: TAGGER_WORKFLOW_PATH,
      origin: 'generated',
    },
  };
}

async function pickInterval(
  current?: GithubPollIntervalMinutes,
): Promise<GithubPollIntervalMinutes | undefined> {
  const items: SelectItem<GithubPollIntervalMinutes>[] = GITHUB_POLL_INTERVAL_PRESETS.map((m) => ({
    label: formatInterval(m),
    value: m,
    hint: current === m ? 'current' : `${m} min`,
  }));
  return select(items, { title: 'Pick how often to poll for new tasks (esc to cancel)' });
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
