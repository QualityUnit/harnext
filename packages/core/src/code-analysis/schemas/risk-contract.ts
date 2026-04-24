/**
 * Risk-tier contract — the machine-readable policy that binds file
 * globs to risk tiers and tiers to required checks. Written to
 * `<cwd>/.harnext/contract.json` and consumed by downstream tooling
 * (the risk-policy gate, merge checks, stage prompts that reference
 * which checks are mandatory for which files).
 *
 * Example:
 *   {
 *     "version": "1",
 *     "riskTierRules": {
 *       "high": ["app/api/legal-chat/**", "lib/tools/**", "db/schema.ts"],
 *       "low":  ["**"]
 *     },
 *     "mergePolicy": {
 *       "high": { "requiredChecks": ["risk-policy-gate", "Browser Evidence"] },
 *       "low":  { "requiredChecks": ["risk-policy-gate", "CI Pipeline"] }
 *     }
 *   }
 *
 * Invariants enforced by the validator:
 *   - `version` is exactly `"1"` (schema bump requires a new accepted literal)
 *   - tier keys in `riskTierRules` match the keys in `mergePolicy` exactly
 *   - every glob / requiredCheck is a non-empty string
 *   - at least one tier's glob list contains `"**"` so no file escapes policy
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_DIR_NAME } from '../../config.js';

export const RISK_CONTRACT_FILE = 'contract.json';

export interface MergePolicyEntry {
  requiredChecks: string[];
}

export interface RiskContract {
  version: '1';
  riskTierRules: Record<string, string[]>;
  mergePolicy: Record<string, MergePolicyEntry>;
}

export function getContractPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, RISK_CONTRACT_FILE);
}

/**
 * Default fallback. Used when the agent can't produce a valid contract —
 * guarantees every file is covered (the `**` glob) and that CI still runs.
 */
export function defaultRiskContract(): RiskContract {
  return {
    version: '1',
    riskTierRules: { low: ['**'] },
    mergePolicy: { low: { requiredChecks: ['CI Pipeline'] } },
  };
}

export function loadRiskContract(cwd: string): RiskContract | null {
  const path = getContractPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRiskContract(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveRiskContract(cwd: string, contract: RiskContract): void {
  const path = getContractPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(contract, null, 2) + '\n', { mode: 0o644 });
}

export function isMergePolicyEntry(value: unknown): value is MergePolicyEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.requiredChecks)) return false;
  return v.requiredChecks.every(
    (c) => typeof c === 'string' && c.length > 0,
  );
}

export function isRiskContract(value: unknown): value is RiskContract {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== '1') return false;

  const rules = v.riskTierRules;
  const policy = v.mergePolicy;
  if (!rules || typeof rules !== 'object') return false;
  if (!policy || typeof policy !== 'object') return false;

  const ruleKeys = Object.keys(rules as object).sort();
  const policyKeys = Object.keys(policy as object).sort();
  if (ruleKeys.length === 0) return false;
  if (ruleKeys.length !== policyKeys.length) return false;
  for (let i = 0; i < ruleKeys.length; i++) {
    if (ruleKeys[i] !== policyKeys[i]) return false;
  }

  let hasFallback = false;
  for (const tier of ruleKeys) {
    const globs = (rules as Record<string, unknown>)[tier];
    if (!Array.isArray(globs)) return false;
    if (!globs.every((g) => typeof g === 'string' && g.length > 0)) return false;
    if (globs.includes('**')) hasFallback = true;

    const entry = (policy as Record<string, unknown>)[tier];
    if (!isMergePolicyEntry(entry)) return false;
  }
  return hasFallback;
}

export interface CoerceRiskContractResult {
  contract: RiskContract | null;
  /** Human-readable reason the input was rejected (or coerced). null on clean success. */
  reason: string | null;
}

/**
 * Lenient parser for the agent's JSON. Dedupes required-check lists,
 * drops empty globs, and rejects the input when invariants can't be
 * recovered. Returns both the resulting contract (or null) and a reason
 * string so the orchestrator can log what went wrong.
 */
export function coerceRiskContract(value: unknown): CoerceRiskContractResult {
  if (!value || typeof value !== 'object') {
    return { contract: null, reason: 'not a JSON object' };
  }
  const v = value as Record<string, unknown>;

  if (v.version !== '1') {
    return {
      contract: null,
      reason: `unsupported version "${String(v.version)}" — expected "1"`,
    };
  }

  const rules = v.riskTierRules;
  const policy = v.mergePolicy;
  if (!rules || typeof rules !== 'object') {
    return { contract: null, reason: 'missing riskTierRules' };
  }
  if (!policy || typeof policy !== 'object') {
    return { contract: null, reason: 'missing mergePolicy' };
  }

  const ruleKeys = Object.keys(rules as object);
  const policyKeys = Object.keys(policy as object);
  if (ruleKeys.length === 0) {
    return { contract: null, reason: 'riskTierRules is empty' };
  }

  // Only keep tiers present in BOTH maps — the invariant says keys match,
  // and we'd rather drop a half-specified tier than invent one.
  const tiers = ruleKeys.filter((k) => policyKeys.includes(k));
  if (tiers.length === 0) {
    return {
      contract: null,
      reason: 'no tier appears in both riskTierRules and mergePolicy',
    };
  }

  const riskTierRules: Record<string, string[]> = {};
  const mergePolicy: Record<string, MergePolicyEntry> = {};
  let hasFallback = false;

  for (const tier of tiers) {
    const globsRaw = (rules as Record<string, unknown>)[tier];
    const entryRaw = (policy as Record<string, unknown>)[tier];
    if (!Array.isArray(globsRaw)) continue;
    if (!entryRaw || typeof entryRaw !== 'object') continue;

    const globs = globsRaw
      .filter((g): g is string => typeof g === 'string' && g.length > 0)
      .filter((g, i, a) => a.indexOf(g) === i);
    if (globs.length === 0) continue;
    if (globs.includes('**')) hasFallback = true;

    const entryChecks = (entryRaw as Record<string, unknown>).requiredChecks;
    const checks = Array.isArray(entryChecks)
      ? entryChecks
          .filter((c): c is string => typeof c === 'string' && c.length > 0)
          .filter((c, i, a) => a.indexOf(c) === i)
      : [];

    riskTierRules[tier] = globs;
    mergePolicy[tier] = { requiredChecks: checks };
  }

  const tierCount = Object.keys(riskTierRules).length;
  if (tierCount === 0) {
    return { contract: null, reason: 'no valid tiers after coercion' };
  }
  if (!hasFallback) {
    return {
      contract: null,
      reason: 'no tier includes "**" — every contract must declare a fallback tier',
    };
  }

  return {
    contract: { version: '1', riskTierRules, mergePolicy },
    reason: null,
  };
}

/**
 * Union of requiredChecks across every tier of the contract, preserving
 * first-seen order. Used by the check-scripts stage to figure out which
 * scripts need to exist under `.harnext/scripts/`.
 */
export function unionRequiredChecks(contract: RiskContract): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tier of Object.keys(contract.mergePolicy)) {
    for (const check of contract.mergePolicy[tier].requiredChecks) {
      if (!seen.has(check)) {
        seen.add(check);
        out.push(check);
      }
    }
  }
  return out;
}
