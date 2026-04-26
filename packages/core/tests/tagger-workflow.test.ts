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
  it('always emits a dispatch step + actions:write (every stage is a workflow now)', () => {
    // Live observation that originally drove the dispatch step: on
    // flowhunt's urlslab-app setup, the tagger applied `harnext:triage`
    // via GITHUB_TOKEN, the triage workflow was supposed to fire on
    // `issues.labeled`, and it stayed silent because GitHub suppresses
    // the `labeled` event for that actor. Every stage runs in a
    // workflow now, so the dispatch is always required.
    const yaml = buildTaggerWorkflow({
      firstStage: firstStage(),
      filter: { kind: 'none' },
    });
    expect(yaml).toContain('Dispatch first-stage workflow');
    expect(yaml).toContain('gh workflow run "harnext-triage.yml"');
    expect(yaml).toContain('--field issue_number=');
    expect(yaml).toContain('actions: write');
  });

  it('passes --ref to the dispatch so gh does not need contents:read', () => {
    // Live observation from flowhunt-amicited install: without --ref, gh
    // CLI tries to resolve the default branch via GraphQL
    // (repository.defaultBranchRef), which fails with "Resource not
    // accessible by integration" because the tagger job only requests
    // issues:write + actions:write. Sourcing the branch from the event
    // payload keeps the token scope minimal.
    const yaml = buildTaggerWorkflow({
      firstStage: firstStage(),
      filter: { kind: 'none' },
    });
    expect(yaml).toContain('--ref "${{ github.event.repository.default_branch }}"');
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
          workflowPath: '.github/workflows/some-custom-file.yml',
          origin: 'connected',
          runsOn: 'github-hosted',
        },
      } as StageEntry,
      filter: { kind: 'none' },
    });
    expect(yaml).toContain('gh workflow run "harnext-custom-gate.yml"');
    expect(yaml).not.toContain('some-custom-file.yml');
  });
});
