import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionDir } from '../src/code-analysis/session-dir.js';

describe('createSessionDir', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-session-test-'));
    // Tests must never be at the mercy of an ambient env var.
    delete process.env.HARNEXT_KEEP_ANALYSIS_DIR;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates a per-run dir under .harnext/analysis-runs/ with a manifest', () => {
    const session = createSessionDir(cwd);
    expect(session.root.startsWith(join(cwd, '.harnext', 'analysis-runs'))).toBe(true);
    expect(existsSync(session.root)).toBe(true);
    expect(existsSync(session.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(session.manifestPath, 'utf-8'));
    expect(manifest.entries).toEqual([]);
  });

  it('pathFor allocates <root>/<stage>/<file> lazily', () => {
    const session = createSessionDir(cwd);
    const p = session.pathFor('tech-stack', 'out.json');
    expect(p).toBe(join(session.root, 'tech-stack', 'out.json'));
    // Writing to the returned path should succeed — parent is ensured.
    writeFileSync(p, 'x', 'utf-8');
    expect(readFileSync(p, 'utf-8')).toBe('x');
  });

  it('appendManifest accumulates entries in order', () => {
    const session = createSessionDir(cwd);
    session.appendManifest({ stage: 'tech-stack', outputs: ['/a'] });
    session.appendManifest({ stage: 'risk-contract', outputs: ['/b', '/c'] });
    const manifest = JSON.parse(readFileSync(session.manifestPath, 'utf-8'));
    expect(manifest.entries).toEqual([
      { stage: 'tech-stack', outputs: ['/a'] },
      { stage: 'risk-contract', outputs: ['/b', '/c'] },
    ]);
  });

  it('cleanup removes the session root', () => {
    const session = createSessionDir(cwd);
    const p = session.pathFor('x', 'y.json');
    writeFileSync(p, '{}', 'utf-8');
    session.cleanup();
    expect(existsSync(session.root)).toBe(false);
  });

  it('retain suppresses cleanup and stamps the manifest', () => {
    const session = createSessionDir(cwd);
    session.retain('pipeline soft-failed');
    session.cleanup();
    expect(existsSync(session.root)).toBe(true);
    const manifest = JSON.parse(readFileSync(session.manifestPath, 'utf-8'));
    expect(manifest.retain).toBe('pipeline soft-failed');
  });

  it('HARNEXT_KEEP_ANALYSIS_DIR=1 forces retain at construction', () => {
    process.env.HARNEXT_KEEP_ANALYSIS_DIR = '1';
    try {
      const session = createSessionDir(cwd);
      session.cleanup();
      expect(existsSync(session.root)).toBe(true);
    } finally {
      delete process.env.HARNEXT_KEEP_ANALYSIS_DIR;
    }
  });

  it('ensures .harnext/.gitignore contains analysis-runs/ and tech-stack.json (append-if-missing)', () => {
    // tech-stack.json is a local cache of the code-analysis pipeline's
    // output — only the wizard's "reuse existing analysis" branch reads
    // it, and it drifts from reality the moment someone reshuffles the
    // repo. It belongs next to analysis-runs/ in the ignore list.
    createSessionDir(cwd);
    const contents = readFileSync(join(cwd, '.harnext', '.gitignore'), 'utf-8');
    expect(contents).toContain('analysis-runs/');
    expect(contents).toContain('tech-stack.json');
  });

  it('does not duplicate gitignore entries on re-run', () => {
    createSessionDir(cwd);
    createSessionDir(cwd);
    const contents = readFileSync(join(cwd, '.harnext', '.gitignore'), 'utf-8');
    expect((contents.match(/analysis-runs\//g) ?? []).length).toBe(1);
    expect((contents.match(/tech-stack\.json/g) ?? []).length).toBe(1);
  });

  it('treats a non-trailing-slash twin as already-present (no duplicate lines)', () => {
    // A user who hand-wrote `analysis-runs` (without the trailing
    // slash) should not end up with both `analysis-runs` and
    // `analysis-runs/` in their gitignore.
    const gitignorePath = join(cwd, '.harnext', '.gitignore');
    mkdirSync(join(cwd, '.harnext'), { recursive: true });
    writeFileSync(gitignorePath, 'analysis-runs\n', 'utf-8');
    createSessionDir(cwd);
    const contents = readFileSync(gitignorePath, 'utf-8');
    expect((contents.match(/analysis-runs/g) ?? []).length).toBe(1);
    // tech-stack.json still gets appended — it was not previously listed.
    expect(contents).toContain('tech-stack.json');
  });

  it('preserves pre-existing gitignore lines when appending managed entries', () => {
    // Seed .harnext/.gitignore with an existing line, then run the session
    // and verify the session dir appended without touching the first line.
    createSessionDir(cwd); // seeds the .harnext dir + gitignore
    const gitignorePath = join(cwd, '.harnext', '.gitignore');
    writeFileSync(gitignorePath, 'custom-line\n', 'utf-8');
    createSessionDir(cwd);
    const contents = readFileSync(gitignorePath, 'utf-8');
    expect(contents).toContain('custom-line');
    expect(contents).toContain('analysis-runs/');
    expect(contents).toContain('tech-stack.json');
  });

  it('only appends entries that are actually missing', () => {
    // When tech-stack.json is already listed by hand but analysis-runs/
    // is not, ensureGitignore appends only analysis-runs/.
    const gitignorePath = join(cwd, '.harnext', '.gitignore');
    mkdirSync(join(cwd, '.harnext'), { recursive: true });
    writeFileSync(gitignorePath, 'tech-stack.json\n', 'utf-8');
    createSessionDir(cwd);
    const contents = readFileSync(gitignorePath, 'utf-8');
    expect((contents.match(/tech-stack\.json/g) ?? []).length).toBe(1);
    expect(contents).toContain('analysis-runs/');
  });
});
