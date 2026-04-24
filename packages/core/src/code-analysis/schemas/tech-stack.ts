/**
 * Structural validation for `TechStack` and its per-package entries. Used
 * both when loading `.harnext/tech-stack.json` from disk and when parsing
 * the JSON the coding agent writes to the session scratch dir — both are
 * untrusted input so the same guard runs in both spots.
 *
 * `coerce*` variants are lenient: they fill in sane defaults for missing
 * optional fields so a partially-completed agent output still produces a
 * usable value. They return `null` only when the input is too malformed
 * to recover (missing `version` / `root.language`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CONFIG_DIR_NAME } from '../../config.js';
import type { PackageTech, TechStack } from '../types.js';

export const TECH_STACK_FILE = 'tech-stack.json';

export function getTechStackPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, TECH_STACK_FILE);
}

export function loadTechStack(cwd: string): TechStack | null {
  const path = getTechStackPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isTechStack(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTechStack(cwd: string, stack: TechStack): void {
  const path = getTechStackPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stack, null, 2) + '\n', { mode: 0o644 });
}

export function isPackageTech(value: unknown): value is PackageTech {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const stringOrNull = (key: string): boolean =>
    v[key] === null || typeof v[key] === 'string';
  return (
    typeof v.path === 'string' &&
    stringOrNull('name') &&
    typeof v.language === 'string' &&
    v.language.length > 0 &&
    stringOrNull('framework') &&
    stringOrNull('packageManager') &&
    stringOrNull('testCommand') &&
    stringOrNull('lintCommand') &&
    stringOrNull('buildCommand') &&
    stringOrNull('typecheckCommand') &&
    typeof v.hasUI === 'boolean' &&
    typeof v.notes === 'string'
  );
}

export function isTechStack(value: unknown): value is TechStack {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== '1') return false;
  if (typeof v.generatedAt !== 'string') return false;
  if (typeof v.isMonorepo !== 'boolean') return false;
  if (!isPackageTech(v.root)) return false;
  if (!Array.isArray(v.packages)) return false;
  if (!v.packages.every((p) => isPackageTech(p))) return false;
  if (v.ciProvider !== null && typeof v.ciProvider !== 'string') return false;
  if (!Array.isArray(v.conventions)) return false;
  if (!v.conventions.every((c) => typeof c === 'string')) return false;
  return true;
}

/**
 * Coerce a loosely-typed object (agent JSON) into a PackageTech, returning
 * null only when `language` is unrecoverable. All optional fields default
 * to null / empty.
 */
export function coercePackageTech(value: unknown): PackageTech | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.language !== 'string' || v.language.length === 0) return null;
  const strOrNull = (key: string): string | null => {
    const x = v[key];
    return typeof x === 'string' && x.length > 0 ? x : null;
  };
  return {
    path: typeof v.path === 'string' ? v.path : '',
    name: strOrNull('name'),
    language: v.language,
    framework: strOrNull('framework'),
    packageManager: strOrNull('packageManager'),
    testCommand: strOrNull('testCommand'),
    lintCommand: strOrNull('lintCommand'),
    buildCommand: strOrNull('buildCommand'),
    typecheckCommand: strOrNull('typecheckCommand'),
    hasUI: typeof v.hasUI === 'boolean' ? v.hasUI : false,
    notes: typeof v.notes === 'string' ? v.notes : '',
  };
}

/**
 * Coerce agent JSON into a TechStack. Returns null only when the root
 * package's `language` is missing — everything else is salvageable.
 */
export function coerceTechStack(value: unknown): TechStack | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  const root = coercePackageTech(v.root);
  if (!root) return null;

  const packagesRaw = Array.isArray(v.packages) ? v.packages : [];
  const packages: PackageTech[] = [];
  for (const entry of packagesRaw) {
    const p = coercePackageTech(entry);
    if (p) packages.push(p);
  }

  const conventions = Array.isArray(v.conventions)
    ? v.conventions.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];

  return {
    version: '1',
    generatedAt:
      typeof v.generatedAt === 'string' ? v.generatedAt : new Date().toISOString(),
    isMonorepo: typeof v.isMonorepo === 'boolean' ? v.isMonorepo : packages.length > 0,
    root,
    packages,
    ciProvider:
      typeof v.ciProvider === 'string' && v.ciProvider.length > 0 ? v.ciProvider : null,
    conventions,
  };
}

/**
 * Minimal placeholder used when the agent fails outright. Keeps downstream
 * consumers (stage-prompts, project-skills) from hitting null — they'll
 * emit generic output off the baseline instead of tailoring.
 */
export function synthesizeMinimalTechStack(cwd: string): TechStack {
  const rootName = cwd.split('/').filter(Boolean).pop() ?? null;
  return {
    version: '1',
    generatedAt: new Date().toISOString(),
    isMonorepo: false,
    root: {
      path: '',
      name: rootName,
      language: 'unknown',
      framework: null,
      packageManager: null,
      testCommand: null,
      lintCommand: null,
      buildCommand: null,
      typecheckCommand: null,
      hasUI: false,
      notes: 'synthesized fallback — agent detection failed',
    },
    packages: [],
    ciProvider: null,
    conventions: [],
  };
}
