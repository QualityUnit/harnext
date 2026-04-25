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
  getStageTrigger,
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
      intake: { enabled: true },
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

  it('migrates legacy stages without a runner to a self-hosted default workflow path', () => {
    const cfg = baseConfig();
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    for (const stage of loaded!.stages) {
      const r = getStageRunner(stage);
      expect(r.runsOn).toBe('self-hosted');
      expect(r.workflowPath).toBe(`.github/workflows/harnext-${stage.id}.yml`);
      expect(r.origin).toBe('generated');
    }
  });

  it('migrates legacy `kind: github-actions` runners to runsOn: github-hosted', () => {
    const stage: NormalStage = {
      ...(DEFAULT_STAGES[0] as NormalStage),
      runner: {
        // Legacy shape with `kind` discriminator. Loader rewrites it.
        kind: 'github-actions',
        workflowPath: '.github/workflows/harnext-triage.yml',
        origin: 'generated',
      } as unknown as NormalStage['runner'],
    };
    const cfg = baseConfig({ stages: [stage, ...DEFAULT_STAGES.slice(1)] });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.stages[0].runner).toEqual({
      workflowPath: '.github/workflows/harnext-triage.yml',
      origin: 'generated',
      runsOn: 'github-hosted',
    });
  });

  it('round-trips a self-hosted runner on a normal stage', () => {
    const stage: NormalStage = {
      ...(DEFAULT_STAGES[0] as NormalStage),
      runner: {
        workflowPath: '.github/workflows/harnext-triage.yml',
        origin: 'generated',
        runsOn: 'self-hosted',
      },
    };
    const cfg = baseConfig({ stages: [stage, ...DEFAULT_STAGES.slice(1)] });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded!.stages[0].runner).toEqual({
      workflowPath: '.github/workflows/harnext-triage.yml',
      origin: 'generated',
      runsOn: 'self-hosted',
    });
    expect(getStageRunner(loaded!.stages[0]).runsOn).toBe('self-hosted');
  });

  it('round-trips a runner on a review-loop stage', () => {
    const loopStage = DEFAULT_STAGES.find((s) => s.kind === 'review-loop') as ReviewLoopStage;
    const stage: ReviewLoopStage = {
      ...loopStage,
      runner: {
        workflowPath: '.github/workflows/harnext-review.yaml',
        origin: 'connected',
        runsOn: 'github-hosted',
      },
    };
    const stages = DEFAULT_STAGES.map((s) => (s.kind === 'review-loop' ? stage : s));
    const cfg = baseConfig({ stages });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    const reloaded = loaded!.stages.find((s) => s.kind === 'review-loop');
    expect(reloaded?.runner).toEqual({
      workflowPath: '.github/workflows/harnext-review.yaml',
      origin: 'connected',
      runsOn: 'github-hosted',
    });
  });

  it('rejects stages with a bad runner origin (falls back to DEFAULT_STAGES)', () => {
    const bogus = {
      ...baseConfig(),
      stages: [
        {
          ...(DEFAULT_STAGES[0] as NormalStage),
          runner: {
            workflowPath: '.github/workflows/x.yml',
            origin: 'handwritten',
            runsOn: 'github-hosted',
          },
        },
      ],
    };
    saveGithubConnection(projectCwd, bogus as unknown as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded!.stages).toEqual(DEFAULT_STAGES);
  });

  it('migrates legacy intake `{ runner: { kind: local } }` to enabled=true', () => {
    const bogus = {
      ...baseConfig(),
      intake: { runner: { kind: 'local' } },
    };
    saveGithubConnection(projectCwd, bogus as unknown as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded!.intake).toEqual({ enabled: true });
  });

  it('round-trips intake.enabled', () => {
    const cfg = baseConfig({ intake: { enabled: false } });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded!.intake).toEqual({ enabled: false });
  });

  it('backfills intake to DEFAULT_INTAKE when the field is missing (legacy configs)', () => {
    const cfg = baseConfig();
    const withoutIntake = { ...cfg } as Partial<GithubConnectionConfig>;
    delete (withoutIntake as Record<string, unknown>).intake;
    saveGithubConnection(projectCwd, withoutIntake as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.intake).toEqual(DEFAULT_INTAKE);
  });

  it('round-trips a stage with trigger="pr-merged"', () => {
    const stage: NormalStage = {
      kind: 'normal',
      id: 'doc-gardening',
      label: 'harnext:doc-gardening',
      mode: 'yolo',
      trigger: 'pr-merged',
      prompt: 'do the thing',
    };
    const cfg = baseConfig({ stages: [stage] });
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    const reloaded = loaded!.stages[0] as NormalStage;
    expect(reloaded.trigger).toBe('pr-merged');
    expect(getStageTrigger(reloaded)).toBe('pr-merged');
  });

  it('defaults trigger to "labeled" when the field is absent (back-compat)', () => {
    const cfg = baseConfig();
    saveGithubConnection(projectCwd, cfg);
    const loaded = loadGithubConnection(projectCwd);
    // DEFAULT_STAGES has triage/plan/implement/verify on the labeled
    // cascade plus doc-gardening on pr-merged. Spot-check both shapes.
    const triage = loaded!.stages.find((s) => s.id === 'triage')!;
    expect(getStageTrigger(triage)).toBe('labeled');
    const docGardening = loaded!.stages.find((s) => s.id === 'doc-gardening');
    expect(docGardening).toBeDefined();
    expect(getStageTrigger(docGardening!)).toBe('pr-merged');
  });

  it('rejects stages with a bogus trigger value', () => {
    const bogus = {
      ...baseConfig(),
      stages: [
        {
          kind: 'normal',
          id: 'weird',
          label: 'harnext:weird',
          mode: 'yolo',
          trigger: 'pre-rebase',
          prompt: 'x',
        },
      ],
    };
    saveGithubConnection(projectCwd, bogus as unknown as GithubConnectionConfig);
    const loaded = loadGithubConnection(projectCwd);
    // Bad trigger → whole stages array rejected → falls back to DEFAULT_STAGES.
    expect(loaded!.stages).toEqual(DEFAULT_STAGES);
  });

  it('DEFAULT_STAGES includes doc-gardening as the terminal pr-merged stage', () => {
    const docGardening = DEFAULT_STAGES.find((s) => s.id === 'doc-gardening');
    expect(docGardening).toBeDefined();
    expect(docGardening!.kind).toBe('normal');
    expect((docGardening as NormalStage).trigger).toBe('pr-merged');
    // Doc-gardening must be the LAST entry so the labeled-cascade
    // calculation in the wizard naturally treats verify as terminal.
    expect(DEFAULT_STAGES[DEFAULT_STAGES.length - 1].id).toBe('doc-gardening');
  });
});
