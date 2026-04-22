import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUserSkillsDir } from './config.js';
import type { SkillDiagnostic } from './skills.js';

export function getBundledSkillsDir(): string {
  // tsup splitting:false → import.meta.url resolves to <pkg>/dist/index.js
  // bundled skills live at <pkg>/skills/, one level up from dist/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'skills');
}

export interface SeedResult {
  seeded: boolean;
  target: string;
  diagnostics: SkillDiagnostic[];
}

/**
 * Copy bundled built-in skills into the user skills dir iff it doesn't exist.
 * Idempotent: once the dir exists (even empty), the user owns it — no-op.
 * Honors HARNEXT_NO_SEED_SKILLS=1 for CI/tests.
 */
export function seedBuiltinSkills(): SeedResult {
  const target = getUserSkillsDir();
  const diagnostics: SkillDiagnostic[] = [];

  if (process.env.HARNEXT_NO_SEED_SKILLS === '1') {
    return { seeded: false, target, diagnostics };
  }
  if (existsSync(target)) {
    return { seeded: false, target, diagnostics };
  }

  const source = getBundledSkillsDir();
  if (!existsSync(source)) {
    diagnostics.push({
      type: 'warning',
      message: 'bundled skills directory missing; seed skipped',
      path: source,
    });
    return { seeded: false, target, diagnostics };
  }

  try {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      cpSync(join(source, entry.name), join(target, entry.name), { recursive: true });
    }
    return { seeded: true, target, diagnostics };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to seed user skills';
    diagnostics.push({ type: 'warning', message, path: target });
    return { seeded: false, target, diagnostics };
  }
}

export interface EnsureResult {
  target: string;
  added: string[];
  present: string[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Top-up copy of bundled skills into the user skills dir. Per bundled entry:
 * copy if the target path doesn't exist; leave alone if it does. Never
 * overwrites user edits. Unlike `seedBuiltinSkills`, this runs unconditionally
 * (intended for explicit invocations like `/init`) and ignores
 * `HARNEXT_NO_SEED_SKILLS`.
 */
export function ensureBundledSkills(): EnsureResult {
  const target = getUserSkillsDir();
  const added: string[] = [];
  const present: string[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  const source = getBundledSkillsDir();
  if (!existsSync(source)) {
    diagnostics.push({
      type: 'warning',
      message: 'bundled skills directory missing',
      path: source,
    });
    return { target, added, present, diagnostics };
  }

  try {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const dest = join(target, entry.name);
      if (existsSync(dest)) {
        present.push(entry.name);
        continue;
      }
      cpSync(join(source, entry.name), dest, { recursive: true });
      added.push(entry.name);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to ensure bundled skills';
    diagnostics.push({ type: 'warning', message, path: target });
  }

  return { target, added, present, diagnostics };
}
