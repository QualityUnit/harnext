import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  coerceRiskContract,
  defaultRiskContract,
  getContractPath,
  isRiskContract,
  loadRiskContract,
  saveRiskContract,
  unionRequiredChecks,
  type RiskContract,
} from '../src/code-analysis/schemas/risk-contract.js';
import { createSessionDir } from '../src/code-analysis/session-dir.js';
import { runRiskContractStage } from '../src/code-analysis/stages/risk-contract.js';
import { synthesizeMinimalTechStack } from '../src/code-analysis/schemas/tech-stack.js';

function validContract(): RiskContract {
  return {
    version: '1',
    riskTierRules: {
      high: ['app/api/**', 'db/schema.ts'],
      low: ['**'],
    },
    mergePolicy: {
      high: { requiredChecks: ['risk-policy-gate', 'Browser Evidence', 'CI Pipeline'] },
      low: { requiredChecks: ['risk-policy-gate', 'CI Pipeline'] },
    },
  };
}

describe('isRiskContract', () => {
  it('accepts a well-formed contract', () => {
    expect(isRiskContract(validContract())).toBe(true);
  });
  it('rejects when tier keys differ between the two maps', () => {
    const bad = {
      ...validContract(),
      mergePolicy: { high: { requiredChecks: ['CI'] }, medium: { requiredChecks: ['CI'] } },
    };
    expect(isRiskContract(bad)).toBe(false);
  });
  it('rejects when no tier includes "**"', () => {
    const bad: RiskContract = {
      version: '1',
      riskTierRules: { high: ['app/**'], low: ['lib/**'] },
      mergePolicy: {
        high: { requiredChecks: ['CI'] },
        low: { requiredChecks: ['CI'] },
      },
    };
    expect(isRiskContract(bad)).toBe(false);
  });
  it('rejects empty-string globs', () => {
    const bad: unknown = {
      ...validContract(),
      riskTierRules: { low: ['', '**'] },
    };
    expect(isRiskContract(bad)).toBe(false);
  });
  it('rejects empty-string required checks', () => {
    const bad: unknown = {
      ...validContract(),
      mergePolicy: {
        high: { requiredChecks: ['', 'Good'] },
        low: { requiredChecks: ['CI'] },
      },
    };
    expect(isRiskContract(bad)).toBe(false);
  });
  it('rejects unknown version', () => {
    expect(isRiskContract({ ...validContract(), version: '2' })).toBe(false);
  });
});

describe('coerceRiskContract', () => {
  it('passes a valid contract through unchanged', () => {
    const { contract, reason } = coerceRiskContract(validContract());
    expect(reason).toBeNull();
    expect(contract).toEqual(validContract());
  });
  it('dedupes requiredChecks within a tier', () => {
    const { contract } = coerceRiskContract({
      version: '1',
      riskTierRules: { low: ['**'] },
      mergePolicy: {
        low: { requiredChecks: ['CI', 'CI', 'Gate', 'Gate', 'CI'] },
      },
    });
    expect(contract!.mergePolicy.low.requiredChecks).toEqual(['CI', 'Gate']);
  });
  it('dedupes globs within a tier', () => {
    const { contract } = coerceRiskContract({
      version: '1',
      riskTierRules: { low: ['**', '**', 'app/**'] },
      mergePolicy: { low: { requiredChecks: ['CI'] } },
    });
    expect(contract!.riskTierRules.low).toEqual(['**', 'app/**']);
  });
  it('drops tiers with no valid globs', () => {
    const { contract } = coerceRiskContract({
      version: '1',
      riskTierRules: { dead: [''], low: ['**'] },
      mergePolicy: {
        dead: { requiredChecks: ['X'] },
        low: { requiredChecks: ['CI'] },
      },
    });
    expect(Object.keys(contract!.riskTierRules)).toEqual(['low']);
  });
  it('drops tiers present in only one map', () => {
    const { contract } = coerceRiskContract({
      version: '1',
      riskTierRules: { high: ['app/**'], low: ['**'] },
      mergePolicy: { low: { requiredChecks: ['CI'] } }, // high missing
    });
    expect(Object.keys(contract!.riskTierRules)).toEqual(['low']);
  });
  it('returns null + reason when no tier has "**"', () => {
    const { contract, reason } = coerceRiskContract({
      version: '1',
      riskTierRules: { high: ['app/**'] },
      mergePolicy: { high: { requiredChecks: ['CI'] } },
    });
    expect(contract).toBeNull();
    expect(reason).toMatch(/no tier includes "\*\*"/);
  });
  it('returns null + reason on unsupported version', () => {
    const { contract, reason } = coerceRiskContract({
      version: '2',
      riskTierRules: { low: ['**'] },
      mergePolicy: { low: { requiredChecks: ['CI'] } },
    });
    expect(contract).toBeNull();
    expect(reason).toMatch(/unsupported version/);
  });
  it('returns null + reason when input is not an object', () => {
    expect(coerceRiskContract(null).contract).toBeNull();
    expect(coerceRiskContract([]).contract).toBeNull();
  });
});

describe('defaultRiskContract', () => {
  it('is a valid RiskContract', () => {
    expect(isRiskContract(defaultRiskContract())).toBe(true);
  });
});

describe('unionRequiredChecks', () => {
  it('flattens, dedupes, and preserves first-seen order', () => {
    expect(unionRequiredChecks(validContract())).toEqual([
      'risk-policy-gate',
      'Browser Evidence',
      'CI Pipeline',
    ]);
  });
});

describe('save/load round-trip', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-contract-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('persists to .harnext/contract.json and loads back', () => {
    saveRiskContract(cwd, validContract());
    expect(existsSync(getContractPath(cwd))).toBe(true);
    expect(loadRiskContract(cwd)).toEqual(validContract());
  });
  it('loadRiskContract returns null when missing', () => {
    expect(loadRiskContract(cwd)).toBeNull();
  });
  it('loadRiskContract returns null on malformed JSON', () => {
    saveRiskContract(cwd, validContract());
    writeFileSync(getContractPath(cwd), '{ not json', 'utf-8');
    expect(loadRiskContract(cwd)).toBeNull();
  });
});

describe('runRiskContractStage', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-contract-stage-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('parses agent output and persists the contract', async () => {
    const session = createSessionDir(cwd);
    const result = await runRiskContractStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+contract\.json)/);
        writeFileSync(match![1], JSON.stringify(validContract()), 'utf-8');
        return 'wrote contract.json';
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.usedFallback).toBe(false);
    expect(result.contract).toEqual(validContract());
    expect(loadRiskContract(cwd)).toEqual(validContract());
    session.cleanup();
  });

  it('overwrites an existing contract on every run (clean, no merge)', async () => {
    saveRiskContract(cwd, validContract());
    const session = createSessionDir(cwd);
    const fresh: RiskContract = {
      version: '1',
      riskTierRules: { low: ['**'] },
      mergePolicy: { low: { requiredChecks: ['Only-CI'] } },
    };
    await runRiskContractStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+contract\.json)/);
        writeFileSync(match![1], JSON.stringify(fresh), 'utf-8');
        return '';
      },
    });
    const onDisk = JSON.parse(readFileSync(getContractPath(cwd), 'utf-8'));
    expect(onDisk).toEqual(fresh);
    session.cleanup();
  });

  it('falls back to default contract when agent produces nothing', async () => {
    const session = createSessionDir(cwd);
    const result = await runRiskContractStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      runHarnextAgent: async () => 'I did nothing',
    });
    expect(result.usedFallback).toBe(true);
    expect(result.contract).toEqual(defaultRiskContract());
    expect(loadRiskContract(cwd)).toEqual(defaultRiskContract());
    expect(result.error).toMatch(/did not write/);
    session.cleanup();
  });

  it('falls back when agent writes a contract missing the "**" fallback tier', async () => {
    const session = createSessionDir(cwd);
    const bad: unknown = {
      version: '1',
      riskTierRules: { high: ['app/**'] },
      mergePolicy: { high: { requiredChecks: ['CI'] } },
    };
    const result = await runRiskContractStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+contract\.json)/);
        writeFileSync(match![1], JSON.stringify(bad), 'utf-8');
        return '';
      },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.error).toMatch(/no tier includes "\*\*"/);
    session.cleanup();
  });

  it('falls back on malformed JSON', async () => {
    const session = createSessionDir(cwd);
    const result = await runRiskContractStage({
      cwd,
      codingAgent: 'harnext',
      session,
      techStack: synthesizeMinimalTechStack(cwd),
      runHarnextAgent: async (prompt) => {
        const match = prompt.match(/([^\s]+contract\.json)/);
        writeFileSync(match![1], '{ not json', 'utf-8');
        return '';
      },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.error).toMatch(/failed to parse/);
    session.cleanup();
  });
});
