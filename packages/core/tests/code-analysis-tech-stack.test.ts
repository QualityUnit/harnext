import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  coerceTechStack,
  getTechStackPath,
  isTechStack,
  loadTechStack,
  saveTechStack,
  synthesizeMinimalTechStack,
} from '../src/code-analysis/schemas/tech-stack.js';
import { createSessionDir } from '../src/code-analysis/session-dir.js';
import { runTechStackStage } from '../src/code-analysis/stages/tech-stack.js';
import type { TechStack } from '../src/code-analysis/types.js';

function validStack(): TechStack {
  return {
    version: '1',
    generatedAt: '2026-04-22T10:00:00.000Z',
    isMonorepo: false,
    root: {
      path: '',
      name: 'demo',
      language: 'TypeScript',
      framework: null,
      packageManager: 'npm',
      testCommand: 'npm test',
      lintCommand: null,
      buildCommand: 'npm run build',
      typecheckCommand: null,
      hasUI: false,
      notes: '',
    },
    packages: [],
    ciProvider: null,
    conventions: [],
  };
}

describe('isTechStack / coerceTechStack', () => {
  it('accepts a well-formed stack', () => {
    expect(isTechStack(validStack())).toBe(true);
  });

  it('rejects missing version', () => {
    const bad = { ...validStack(), version: '2' } as unknown;
    expect(isTechStack(bad)).toBe(false);
  });

  it('rejects non-boolean isMonorepo', () => {
    const bad = { ...validStack(), isMonorepo: 'yes' } as unknown;
    expect(isTechStack(bad)).toBe(false);
  });

  it('coerce fills defaults for partial agent output', () => {
    const coerced = coerceTechStack({
      root: { path: '', language: 'Python' },
      packages: [],
    });
    expect(coerced).not.toBeNull();
    expect(coerced!.version).toBe('1');
    expect(coerced!.isMonorepo).toBe(false);
    expect(coerced!.root.testCommand).toBeNull();
    expect(coerced!.ciProvider).toBeNull();
  });

  it('coerce returns null when root.language is missing', () => {
    expect(coerceTechStack({ root: { path: '' }, packages: [] })).toBeNull();
  });

  it('coerce drops malformed entries from packages[] silently', () => {
    const coerced = coerceTechStack({
      root: { path: '', language: 'Go' },
      packages: [
        { path: 'a', language: 'Go' },
        { path: 'b' }, // missing language — dropped
      ],
    });
    expect(coerced!.packages).toHaveLength(1);
    expect(coerced!.packages[0].path).toBe('a');
  });
});

describe('synthesizeMinimalTechStack', () => {
  it('returns a language-unknown stack with a populated root.name', () => {
    const s = synthesizeMinimalTechStack('/home/alice/myrepo');
    expect(s.root.language).toBe('unknown');
    expect(s.root.name).toBe('myrepo');
    expect(s.isMonorepo).toBe(false);
    expect(s.packages).toEqual([]);
  });
});

describe('saveTechStack / loadTechStack', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-tech-stack-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('round-trips through .harnext/tech-stack.json', () => {
    saveTechStack(cwd, validStack());
    expect(existsSync(getTechStackPath(cwd))).toBe(true);
    const loaded = loadTechStack(cwd);
    expect(loaded).not.toBeNull();
    expect(loaded!.root.language).toBe('TypeScript');
  });

  it('loadTechStack returns null when the file is absent', () => {
    expect(loadTechStack(cwd)).toBeNull();
  });

  it('loadTechStack returns null on malformed JSON', () => {
    // Use saveTechStack first so the .harnext directory exists, then
    // corrupt the file on disk to simulate a malformed state.
    saveTechStack(cwd, validStack());
    writeFileSync(getTechStackPath(cwd), '{ not json', 'utf-8');
    expect(loadTechStack(cwd)).toBeNull();
  });
});

describe('runTechStackStage', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-tech-stage-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('parses JSON the stub agent writes and persists .harnext/tech-stack.json', async () => {
    const session = createSessionDir(cwd);
    const result = await runTechStackStage({
      cwd,
      codingAgent: 'harnext',
      session,
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+tech-stack\.json)/);
        writeFileSync(
          match![1],
          JSON.stringify({
            version: '1',
            generatedAt: '2026-04-22T10:00:00.000Z',
            isMonorepo: true,
            root: {
              path: '',
              name: 'root',
              language: 'TypeScript',
              framework: null,
              packageManager: 'npm',
              testCommand: 'npm test',
              lintCommand: null,
              buildCommand: null,
              typecheckCommand: null,
              hasUI: false,
              notes: '',
            },
            packages: [
              {
                path: 'packages/api',
                name: 'api',
                language: 'TypeScript',
                framework: null,
                packageManager: 'npm',
                testCommand: 'npm test -w api',
                lintCommand: null,
                buildCommand: null,
                typecheckCommand: null,
                hasUI: false,
                notes: '',
              },
            ],
            ciProvider: 'github-actions',
            conventions: [],
          }),
          'utf-8',
        );
        return 'wrote tech-stack.json';
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.techStack).not.toBeNull();
    expect(result.techStack!.isMonorepo).toBe(true);
    expect(result.techStack!.packages).toHaveLength(1);
    expect(existsSync(getTechStackPath(cwd))).toBe(true);
    const manifest = JSON.parse(readFileSync(session.manifestPath, 'utf-8'));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].stage).toBe('tech-stack');
    session.cleanup();
  });

  it('returns error when agent does not write the file', async () => {
    const session = createSessionDir(cwd);
    const result = await runTechStackStage({
      cwd,
      codingAgent: 'harnext',
      session,
      runHarnextAgent: async () => 'I did nothing',
    });
    expect(result.techStack).toBeNull();
    expect(result.error).toMatch(/did not write/);
    session.cleanup();
  });

  it('returns error on malformed JSON', async () => {
    const session = createSessionDir(cwd);
    const result = await runTechStackStage({
      cwd,
      codingAgent: 'harnext',
      session,
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+tech-stack\.json)/);
        writeFileSync(match![1], '{ not json', 'utf-8');
        return '';
      },
    });
    expect(result.techStack).toBeNull();
    expect(result.error).toMatch(/failed to parse/);
    session.cleanup();
  });

  it('returns error when validation fails (missing language)', async () => {
    const session = createSessionDir(cwd);
    const result = await runTechStackStage({
      cwd,
      codingAgent: 'harnext',
      session,
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+tech-stack\.json)/);
        writeFileSync(match![1], JSON.stringify({ root: { path: '' } }), 'utf-8');
        return '';
      },
    });
    expect(result.techStack).toBeNull();
    expect(result.error).toMatch(/missing required fields/);
    session.cleanup();
  });

  it('propagates agent exceptions into result.error', async () => {
    const session = createSessionDir(cwd);
    const result = await runTechStackStage({
      cwd,
      codingAgent: 'harnext',
      session,
      runHarnextAgent: async () => {
        throw new Error('agent blew up');
      },
    });
    expect(result.techStack).toBeNull();
    expect(result.error).toBe('agent blew up');
    session.cleanup();
  });
});
