import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGES, type StageEntry } from '../src/github-connection.js';
import { buildTaggerWorkflow } from '../src/tagger-workflow.js';

/**
 * All stages in DEFAULT_STAGES carry a `harnext:<id>` label; we use
 * `triage` throughout as the canonical first stage. The non-runner
 * fields don't matter for these tests — only the runner on `firstStage`
 * and the filter shape affect the emitted YAML.
 */
function firstStage(overrides: Partial<StageEntry> = {}): StageEntry {
  const triage = DEFAULT_STAGES.find((s) => s.id === 'triage');
  if (!triage) throw new Error('triage not found in DEFAULT_STAGES');
  return { ...triage, ...overrides } as StageEntry;
}

describe('buildTaggerWorkflow', () => {
  it('emits a dispatch step + actions:write when the first stage runs on github-actions', () => {
    // Live observation: on flowhunt's urlslab-app setup, the tagger
    // applied `harnext:triage` via GITHUB_TOKEN, the triage workflow
    // was supposed to fire on `issues.labeled`, and it stayed silent
    // because GitHub suppresses the `labeled` event for that actor.
    // The fix is an explicit `gh workflow run` on the first stage.
    const yaml = buildTaggerWorkflow({
      firstStage: firstStage({
        runner: {
          kind: 'github-actions',
          workflowPath: '.github/workflows/harnext-triage.yml',
          origin: 'generated',
        },
      }),
      filter: { kind: 'none' },
    });
    expect(yaml).toContain('Dispatch first-stage workflow');
    expect(yaml).toContain('gh workflow run "harnext-triage.yml"');
    expect(yaml).toContain('--field issue_number=');
    // `actions: write` is required for cross-workflow dispatch; we
    // only grant it in the GHA-first-stage case to keep the token
    // footprint minimal when it's not needed.
    expect(yaml).toContain('actions: write');
  });

  it('omits the dispatch step (and actions:write) when the first stage runs locally', () => {
    // Local first stage = cron poller handles the label-to-run
    // transition; the tagger just applies the label and stops. No
    // cross-workflow dispatch needed, so we keep the permissions
    // narrow (no `actions: write`).
    const yaml = buildTaggerWorkflow({
      firstStage: firstStage(), // no runner → getStageRunner → local
      filter: { kind: 'none' },
    });
    expect(yaml).not.toContain('Dispatch first-stage workflow');
    expect(yaml).not.toContain('gh workflow run');
    expect(yaml).not.toContain('actions: write');
  });

  it('computes the dispatch target filename from the stage id (not the runner workflowPath)', () => {
    // Sanity: the tagger uses the convention `harnext-<id>.yml`,
    // which is also what the setup wizard writes to. This keeps the
    // tagger decoupled from whatever custom `workflowPath` the user
    // may have typed in the `connect` flow — if they pointed at a
    // non-conventional filename, the dispatch will simply miss and
    // the user can rename or switch to `generate`.
    const yaml = buildTaggerWorkflow({
      firstStage: {
        ...firstStage(),
        id: 'custom-gate',
        label: 'harnext:custom-gate',
        runner: {
          kind: 'github-actions',
          workflowPath: '.github/workflows/some-custom-file.yml',
          origin: 'connected',
        },
      } as StageEntry,
      filter: { kind: 'none' },
    });
    expect(yaml).toContain('gh workflow run "harnext-custom-gate.yml"');
    expect(yaml).not.toContain('some-custom-file.yml');
  });
});
