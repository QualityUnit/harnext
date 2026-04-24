import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AWAITING_APPROVAL_LABEL,
  DEFAULT_INTAKE,
  DEFAULT_STAGES,
  NEEDS_JUDGMENT_LABEL,
  buildHarnextLabelSpecs,
  getStageRunner,
  loadGithubConnection,
  saveGithubConnection,
  type GithubConnectionConfig,
  type NormalStage,
  type ReviewLoopStage,
} from '../src/github-connection.js';

describe('buildHarnextLabelSpecs', () => {
  it('emits one label per stage plus the two control labels', () => {
    const specs = buildHarnextLabelSpecs(DEFAULT_STAGES);
    const names = specs.map((s) => s.name);

    for (const stage of DEFAULT_STAGES) {
      expect(names).toContain(stage.label);
    }
    expect(names).toContain(AWAITING_APPROVAL_LABEL);
    expect(names).toContain(NEEDS_JUDGMENT_LABEL);
    expect(specs).toHaveLength(DEFAULT_STAGES.length + 2);
  });

  it('assigns every label a six-char hex color (no leading #)', () => {
    const specs = buildHarnextLabelSpecs(DEFAULT_STAGES);
    for (const spec of specs) {
      expect(spec.color).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it('uses a harnext-branded description on every label', () => {
    const specs = buildHarnextLabelSpecs(DEFAULT_STAGES);
    for (const spec of specs) {
      expect(spec.description).toMatch(/harnext/i);
    }
  });

  it('keeps stage order first, control labels last', () => {
    const specs = buildHarnextLabelSpecs(DEFAULT_STAGES);
    const stageCount = DEFAULT_STAGES.length;
    expect(specs.slice(0, stageCount).map((s) => s.name)).toEqual(
      DEFAULT_STAGES.map((s) => s.label),
    );
    expect(specs[stageCount].name).toBe(AWAITING_APPROVAL_LABEL);
    expect(specs[stageCount + 1].name).toBe(NEEDS_JUDGMENT_LABEL);
  });
});

describe('GithubConnectionConfig save/load round-trip', () => {
  let tempHome: string;
  let prevHome: string | undefined;
  const projectCwd = '/tmp/test-project-unique';

  beforeEach(() => {
    prevHome = process.env.HARNEXT_HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'harnext-test-'));
    process.env.HARNEXT_HOME = tempHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = prevHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function baseConfig(overrides: Partial<GithubConnectionConfig> = {}): GithubConnectionConfig {
    return {
      repo: 'example/repo',
      pollIntervalMinutes: 15,
      filter: { kind: 'none' },
      intake: { runner: { kind: 'local' } },
      stages: DEFAULT_STAGES.map((s) => ({ ...s })),
      codingAgent: 'harnext',
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('persists codingAgent and codingAgentModel for external agents', () => {
    const cfg = baseConfig({ codingAgent: 'claude-code', codingAgentModel: 'claude-sonnet-4-6' });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.codingAgent).toBe('claude-code');
    expect(loaded!.codingAgentModel).toBe('claude-sonnet-4-6');
  });

  it('defaults codingAgent to harnext when the field is missing (legacy configs)', () => {
    const cfg = baseConfig();
    // Strip the new field to simulate a pre-issue-49 on-disk config.
    const withoutAgent = { ...cfg } as Partial<GithubConnectionConfig>;
    delete (withoutAgent as Record<string, unknown>).codingAgent;
    saveGithubConnection(projectCwd, withoutAgent as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.codingAgent).toBe('harnext');
    expect(loaded!.codingAgentModel).toBeUndefined();
  });

  it('drops codingAgentModel for harnext (harnext reads from preferences)', () => {
    // Simulate a hand-edited config with a stray model id set on harnext.
    const cfg = baseConfig({ codingAgent: 'harnext' });
    const withStrayModel = { ...cfg, codingAgentModel: 'should-be-ignored' };
    saveGithubConnection(projectCwd, withStrayModel as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.codingAgent).toBe('harnext');
    expect(loaded!.codingAgentModel).toBeUndefined();
  });

  it('treats stages without a runner field as local (back-compat)', () => {
    const cfg = baseConfig();
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    for (const stage of loaded!.stages) {
      expect(stage.runner).toBeUndefined();
      expect(getStageRunner(stage)).toEqual({ kind: 'local' });
    }
  });

  it('round-trips a valid github-actions runner on a normal stage', () => {
    const stage: NormalStage = {
      ...(DEFAULT_STAGES[0] as NormalStage),
      runner: {
        kind: 'github-actions',
        workflowPath: '.github/workflows/harnext-triage.yml',
        origin: 'generated',
      },
    };
    const cfg = baseConfig({ stages: [stage, ...DEFAULT_STAGES.slice(1)] });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.stages[0].runner).toEqual({
      kind: 'github-actions',
      workflowPath: '.github/workflows/harnext-triage.yml',
      origin: 'generated',
    });
    expect(getStageRunner(loaded!.stages[0]).kind).toBe('github-actions');
  });

  it('round-trips a valid github-actions runner on a review-loop stage', () => {
    const loopStage = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    const stage: ReviewLoopStage = {
      ...loopStage,
      runner: {
        kind: 'github-actions',
        workflowPath: '.github/workflows/harnext-review.yaml',
        origin: 'connected',
      },
    };
    const stages = DEFAULT_STAGES.map((s) => (s.kind === 'review-loop' ? stage : s));
    const cfg = baseConfig({ stages });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    const reloaded = loaded!.stages.find((s) => s.kind === 'review-loop');
    expect(reloaded?.runner).toEqual({
      kind: 'github-actions',
      workflowPath: '.github/workflows/harnext-review.yaml',
      origin: 'connected',
    });
  });

  it('rejects stages with an invalid runner shape (falls back to DEFAULT_STAGES)', () => {
    // A runner missing workflowPath is not a valid github-actions runner.
    // The loader treats the whole stages array as invalid and falls back to
    // DEFAULT_STAGES rather than silently resolving the bad runner to local.
    const bogus = {
      ...baseConfig(),
      stages: [
        {
          ...(DEFAULT_STAGES[0] as NormalStage),
          runner: { kind: 'github-actions', origin: 'generated' },
        },
      ],
    };
    saveGithubConnection(projectCwd, bogus as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.stages).toEqual(DEFAULT_STAGES);
  });

  it('rejects stages with a bad runner origin', () => {
    const bogus = {
      ...baseConfig(),
      stages: [
        {
          ...(DEFAULT_STAGES[0] as NormalStage),
          runner: {
            kind: 'github-actions',
            workflowPath: '.github/workflows/x.yml',
            origin: 'handwritten',
          },
        },
      ],
    };
    saveGithubConnection(projectCwd, bogus as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded!.stages).toEqual(DEFAULT_STAGES);
  });

  it('round-trips a local intake runner', () => {
    const cfg = baseConfig({ intake: { runner: { kind: 'local' } } });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.intake).toEqual({ runner: { kind: 'local' } });
  });

  it('round-trips a github-actions intake runner', () => {
    const cfg = baseConfig({
      intake: {
        runner: {
          kind: 'github-actions',
          workflowPath: '.github/workflows/harnext-tagger.yml',
          origin: 'generated',
        },
      },
    });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.intake.runner).toEqual({
      kind: 'github-actions',
      workflowPath: '.github/workflows/harnext-tagger.yml',
      origin: 'generated',
    });
  });

  it('backfills intake to DEFAULT_INTAKE when the field is missing (legacy configs)', () => {
    // Simulate a pre-issue-65 on-disk config that has no intake field.
    const cfg = baseConfig();
    const withoutIntake = { ...cfg } as Partial<GithubConnectionConfig>;
    delete (withoutIntake as Record<string, unknown>).intake;
    saveGithubConnection(projectCwd, withoutIntake as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.intake).toEqual(DEFAULT_INTAKE);
    expect(loaded!.intake.runner.kind).toBe('local');
  });

  it('rejects configs with a malformed intake runner', () => {
    // intake.runner with kind="github-actions" but missing workflowPath is
    // invalid and must fail to load — otherwise the poller would silently
    // treat it as "not local" and the tagger path wouldn't fire either.
    const bogus = {
      ...baseConfig(),
      intake: { runner: { kind: 'github-actions', origin: 'generated' } },
    };
    saveGithubConnection(projectCwd, bogus as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).toBeNull();
  });
});
