import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkScriptEntry,
  getScriptsDir,
  listExistingScriptFiles,
  partitionChecks,
  slugifyCheckId,
} from '../src/code-analysis/schemas/check-scripts.js';
import {
  defaultRiskContract,
  type RiskContract,
} from '../src/code-analysis/schemas/risk-contract.js';
import { synthesizeMinimalTechStack } from '../src/code-analysis/schemas/tech-stack.js';
import { createSessionDir } from '../src/code-analysis/session-dir.js';
import { runCheckScriptsStage } from '../src/code-analysis/stages/check-scripts.js';

describe('slugifyCheckId', () => {
  it('lowercases and collapses non-alnum runs', () => {
    expect(slugifyCheckId('Browser Evidence')).toBe('browser-evidence');
    expect(slugifyCheckId('CI Pipeline')).toBe('ci-pipeline');
    expect(slugifyCheckId('risk-policy-gate')).toBe('risk-policy-gate');
  });
  it('trims leading/trailing separators', () => {
    expect(slugifyCheckId('  !Foo_Bar!  ')).toBe('foo-bar');
    expect(slugifyCheckId('--hello--')).toBe('hello');
  });
  it('handles unicode-ish junk by stripping to alnum', () => {
    expect(slugifyCheckId('build: release!')).toBe('build-release');
  });
});

describe('checkScriptEntry', () => {
  it('produces slug, fileName, and absolute filePath', () => {
    const e = checkScriptEntry('/tmp/repo', 'Browser Evidence');
    expect(e.slug).toBe('browser-evidence');
    expect(e.fileName).toBe('browser-evidence.sh');
    expect(e.filePath).toBe('/tmp/repo/.harnext/scripts/browser-evidence.sh');
  });
});

describe('listExistingScriptFiles / partitionChecks', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-scripts-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns [] when the scripts dir is missing', () => {
    expect(listExistingScriptFiles(cwd)).toEqual([]);
  });

  it('lists .sh files only, ignores subdirs and non-.sh files', () => {
    const dir = getScriptsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.sh'), '#!/usr/bin/env bash\n', 'utf-8');
    writeFileSync(join(dir, 'b.sh'), '#!/usr/bin/env bash\n', 'utf-8');
    writeFileSync(join(dir, 'readme.md'), '# notes', 'utf-8');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.sh'), '', 'utf-8');
    expect(listExistingScriptFiles(cwd).sort()).toEqual(['a.sh', 'b.sh']);
  });

  it('partitionChecks splits by presence on disk', () => {
    const dir = getScriptsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ci-pipeline.sh'), '#!/usr/bin/env bash\n', 'utf-8');

    const { existing, missing } = partitionChecks(cwd, [
      'CI Pipeline',
      'Browser Evidence',
      'risk-policy-gate',
    ]);
    expect(existing.map((e) => e.fileName)).toEqual(['ci-pipeline.sh']);
    expect(missing.map((e) => e.fileName).sort()).toEqual([
      'browser-evidence.sh',
      'risk-policy-gate.sh',
    ]);
  });
});

function makeContractWith(requiredByTier: Record<string, string[]>): RiskContract {
  const tiers = Object.keys(requiredByTier);
  const riskTierRules: Record<string, string[]> = {};
  const mergePolicy: Record<string, { requiredChecks: string[] }> = {};
  for (const tier of tiers) {
    riskTierRules[tier] = tier === 'low' ? ['**'] : ['app/**'];
    mergePolicy[tier] = { requiredChecks: requiredByTier[tier] };
  }
  if (!('low' in riskTierRules)) {
    riskTierRules.low = ['**'];
    mergePolicy.low = { requiredChecks: ['CI Pipeline'] };
  }
  return { version: '1', riskTierRules, mergePolicy };
}

describe('runCheckScriptsStage', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-check-scripts-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('short-circuits when every required check already has a script on disk', async () => {
    const dir = getScriptsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ci-pipeline.sh'), '#!/usr/bin/env bash\necho hi\n', 'utf-8');

    let agentInvoked = false;
    const session = createSessionDir(cwd);
    const result = await runCheckScriptsStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      contract: defaultRiskContract(),
      runHarnextAgent: async () => {
        agentInvoked = true;
        return '';
      },
    });
    expect(agentInvoked).toBe(false);
    expect(result.generated).toEqual([]);
    expect(result.preserved).toHaveLength(1);
    // chmod 0o755 was applied to the existing script.
    const mode = statSync(join(dir, 'ci-pipeline.sh')).mode & 0o777;
    expect(mode).toBe(0o755);
    session.cleanup();
  });

  it('invokes agent for missing scripts, chmods them, leaves existing ones alone', async () => {
    const dir = getScriptsDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ci-pipeline.sh'), '#!/usr/bin/env bash\necho original\n', 'utf-8');
    chmodSync(join(dir, 'ci-pipeline.sh'), 0o644);

    const contract = makeContractWith({
      high: ['risk-policy-gate', 'Browser Evidence', 'CI Pipeline'],
      low: ['CI Pipeline', 'risk-policy-gate'],
    });

    const session = createSessionDir(cwd);
    const result = await runCheckScriptsStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      contract,
      runHarnextAgent: async (prompt) => {
        const missing = JSON.parse(
          prompt.match(/\[\s*\{[\s\S]*?\}\s*\]/)![0],
        ) as { id: string; filePath: string }[];
        for (const entry of missing) {
          writeFileSync(
            entry.filePath,
            `#!/usr/bin/env bash\nset -euo pipefail\necho "${entry.id}"\n`,
            'utf-8',
          );
        }
        return 'wrote scripts';
      },
    });

    expect(result.generated.map((p) => p.split('/').pop()).sort()).toEqual([
      'browser-evidence.sh',
      'risk-policy-gate.sh',
    ]);
    expect(result.preserved).toEqual([join(dir, 'ci-pipeline.sh')]);
    expect(result.failed).toEqual([]);

    // New files chmod'd.
    expect(statSync(join(dir, 'browser-evidence.sh')).mode & 0o777).toBe(0o755);
    // Pre-existing file chmod'd up too (was 0o644, now 0o755).
    expect(statSync(join(dir, 'ci-pipeline.sh')).mode & 0o777).toBe(0o755);
    // Pre-existing content preserved.
    expect(readFileSync(join(dir, 'ci-pipeline.sh'), 'utf-8')).toContain('original');
    session.cleanup();
  });

  it('reports checks as failed when the agent did not write their files', async () => {
    const contract = makeContractWith({ low: ['Alpha', 'Beta'] });
    const session = createSessionDir(cwd);
    const result = await runCheckScriptsStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      contract,
      runHarnextAgent: async (prompt) => {
        // Write only the first missing script.
        const missing = JSON.parse(
          prompt.match(/\[\s*\{[\s\S]*?\}\s*\]/)![0],
        ) as { id: string; filePath: string }[];
        writeFileSync(missing[0].filePath, '#!/usr/bin/env bash\necho ok\n', 'utf-8');
        return '';
      },
    });
    expect(result.generated).toHaveLength(1);
    expect(result.failed.map((f) => f.slug)).toEqual(['beta']);
    session.cleanup();
  });

  it('empty files count as failed (agent must write non-empty content)', async () => {
    const contract = makeContractWith({ low: ['Empty One'] });
    const session = createSessionDir(cwd);
    const result = await runCheckScriptsStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      contract,
      runHarnextAgent: async (prompt) => {
        const missing = JSON.parse(
          prompt.match(/\[\s*\{[\s\S]*?\}\s*\]/)![0],
        ) as { id: string; filePath: string }[];
        writeFileSync(missing[0].filePath, '', 'utf-8');
        return '';
      },
    });
    expect(result.generated).toEqual([]);
    expect(result.failed.map((f) => f.slug)).toEqual(['empty-one']);
    expect(existsSync(contract.mergePolicy.low.requiredChecks[0])).toBe(false);
    session.cleanup();
  });

  it('propagates agent error into result.error and flags every missing script', async () => {
    const contract = makeContractWith({ low: ['Alpha', 'Beta'] });
    const session = createSessionDir(cwd);
    const result = await runCheckScriptsStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      contract,
      runHarnextAgent: async () => {
        throw new Error('agent blew up');
      },
    });
    expect(result.error).toBe('agent blew up');
    expect(result.generated).toEqual([]);
    expect(result.failed.map((f) => f.slug).sort()).toEqual(['alpha', 'beta']);
    session.cleanup();
  });
});
