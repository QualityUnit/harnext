import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  DEFAULT_STAGES,
  type GithubConnectionConfig,
  type NormalStage,
  type ReviewLoopStage,
} from '../src/github-connection.js';
import {
  WORKFLOW_PROMPT_BUNDLES,
  toStageWorkflowStage,
} from '../src/workflow-prompts.js';
import { generateStageWorkflow } from '../src/workflow-generator.js';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'harnext-wfgen-'));
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function baseCfg(
  overrides: Partial<GithubConnectionConfig> = {},
): GithubConnectionConfig {
  return {
    repo: 'example/repo',
    pollIntervalMinutes: 15,
    filter: { kind: 'none' },
    stages: DEFAULT_STAGES,
    codingAgent: 'claude-code',
    codingAgentModel: 'claude-opus-4-7',
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Fake child process that writes a YAML file to the target path and exits 0.
 * Mirrors the enough-of-a-ChildProcess surface that `runExternalCodingAgent`
 * attaches listeners to.
 */
function fakeSpawner(opts: {
  writeFileAt?: string;
  fileContent?: string;
  exitCode?: number;
}): (binary: string, args: string[]) => ChildProcessWithoutNullStreams {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (sig?: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => undefined;
    setImmediate(() => {
      if (opts.writeFileAt) {
        mkdirSync(join(opts.writeFileAt, '..'), { recursive: true });
        writeFileSync(opts.writeFileAt, opts.fileContent ?? '# generated yaml\n');
      }
      child.stdout.emit('data', Buffer.from('done\n'));
      child.emit('close', opts.exitCode ?? 0);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

describe('generateStageWorkflow', () => {
  it('reports wroteFile=true and includes file contents when the agent writes the file', async () => {
    const relPath = '.github/workflows/harnext-triage.yml';
    const absPath = join(cwd, relPath);
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: relPath,
      nextLabel: 'harnext:plan',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({
        writeFileAt: absPath,
        fileContent: '# a workflow\nname: triage\n',
      }),
    });
    expect(result.wroteFile).toBe(true);
    expect(existsSync(result.workflowPath)).toBe(true);
    expect(result.workflowContent).toContain('name: triage');
    expect(result.error).toBeUndefined();
    // Prompt mentions the stage label and the workflow target.
    expect(result.promptSent).toContain('harnext:triage');
    expect(result.promptSent).toContain(relPath);
  });

  it('reports wroteFile=false and surfaces the error when the agent exits non-zero', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({ exitCode: 1 }),
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('reports wroteFile=false when the agent exits cleanly but writes nothing', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg(),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      spawner: fakeSpawner({ exitCode: 0 }),
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('uses the harnext runner hook when codingAgent is harnext', async () => {
    const relPath = '.github/workflows/harnext-plan.yml';
    const absPath = join(cwd, relPath);
    let prompted = '';
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[1] as NormalStage,
      cfg: baseCfg({ codingAgent: 'harnext', codingAgentModel: undefined }),
      relativeWorkflowPath: relPath,
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
      runHarnextAgent: async (prompt, runCwd) => {
        prompted = prompt;
        expect(runCwd).toBe(cwd);
        writeFileSync(absPath, '# by harnext\n');
        return 'wrote it';
      },
    });
    expect(result.wroteFile).toBe(true);
    expect(result.agentOutput).toBe('wrote it');
    expect(prompted).toContain('harnext:plan');
  });

  it('surfaces a missing codingAgentModel error for external agents', async () => {
    const result = await generateStageWorkflow({
      cwd,
      stage: DEFAULT_STAGES[0] as NormalStage,
      cfg: baseCfg({ codingAgentModel: undefined }),
      relativeWorkflowPath: '.github/workflows/harnext-triage.yml',
      awaitingLabel: 'harnext:awaiting-approval',
      needsJudgmentLabel: 'harnext:needs-judgment',
      triggerOn: 'issues',
    });
    expect(result.wroteFile).toBe(false);
    expect(result.error).toMatch(/codingAgentModel/);
  });
});

describe('WORKFLOW_PROMPT_BUNDLES', () => {
  const baseInput = {
    repo: 'example/repo',
    nextLabel: 'harnext:plan',
    awaitingLabel: 'harnext:awaiting-approval',
    needsJudgmentLabel: 'harnext:needs-judgment',
    triggerOn: 'issues' as const,
    codingAgent: 'claude-code' as const,
    codingAgentModel: 'claude-opus-4-7',
    workflowPath: '/abs/.github/workflows/harnext-triage.yml',
  };

  it('claude-code prompt names the reference action and the workflow path', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('anthropics/claude-code-action@v1');
    expect(prompt).toContain(baseInput.workflowPath);
    expect(prompt).toContain('harnext:triage');
    expect(prompt).toContain('harnext:plan');
    expect(prompt).toContain('harnext:needs-judgment');
  });

  it('codex prompt cites the docs URL', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES.codex;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      codingAgent: 'codex',
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('developers.openai.com/codex/github-action');
  });

  it('harnext prompt describes the CLI install + secret', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES.harnext;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      codingAgent: 'harnext',
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toContain('npm i -g harnext');
    expect(prompt).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  it('review-loop stage prompt includes both reviewer and fixer prompts', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const loop = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      stage: toStageWorkflowStage(loop),
    });
    expect(prompt).toContain('BEGIN REVIEWER PROMPT');
    expect(prompt).toContain('BEGIN FIXER PROMPT');
    expect(prompt).toContain(`up to ${loop.maxIterations} times`);
  });

  it('terminal stage (no nextLabel) tells the agent no follow-up label to add', () => {
    const bundle = WORKFLOW_PROMPT_BUNDLES['claude-code'];
    const prompt = bundle.buildGeneratorPrompt({
      ...baseInput,
      nextLabel: undefined,
      stage: toStageWorkflowStage(DEFAULT_STAGES[0] as NormalStage),
    });
    expect(prompt).toMatch(/terminal stage/i);
  });
});
