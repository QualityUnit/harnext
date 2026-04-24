import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installBundledSkills,
  PROJECT_BUNDLED_SKILLS,
  resolveAgentSkillsDir,
} from '../src/code-analysis/stages/install-bundled-skills.js';

describe('installBundledSkills', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-bundled-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('copies only the allowlisted project skills, ignoring other bundled entries', () => {
    // The bundled skills dir on disk carries more than just the project
    // allowlist (it also holds user-level-only meta-skills like `init`
    // and `review`). The project install step must filter those out so
    // `.claude/skills` stays lean and doesn't drop generic copy-pasted
    // playbooks next to the project-tailored generated ones.
    const result = installBundledSkills(cwd, 'claude-code');
    expect(result.error).toBeUndefined();

    const target = resolveAgentSkillsDir(cwd, 'claude-code');
    expect(result.target).toBe(target);

    const targetEntries = existsSync(target)
      ? readdirSync(target, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];
    expect(targetEntries).toEqual([...PROJECT_BUNDLED_SKILLS].sort());

    // Every allowlisted skill landed on disk with its SKILL.md.
    for (const slug of PROJECT_BUNDLED_SKILLS) {
      expect(existsSync(join(target, slug, 'SKILL.md'))).toBe(true);
    }

    // And the meta-skills that exist in bundled form for the user-level
    // seed are NOT present in the project target.
    expect(existsSync(join(target, 'init'))).toBe(false);
    expect(existsSync(join(target, 'review'))).toBe(false);

    expect(result.installed.sort()).toEqual([...PROJECT_BUNDLED_SKILLS].sort());
    expect(result.skipped).toEqual([]);
  });

  it('does not clobber a pre-existing project skill on re-run', () => {
    // Policy from the doc comment on installBundledSkills: if the target
    // slug directory already exists, leave it alone so user edits survive.
    // We verify by seeding, then re-running and confirming a "skipped"
    // report for the already-present allowlisted slug.
    const first = installBundledSkills(cwd, 'claude-code');
    expect(first.error).toBeUndefined();
    expect(first.installed).toEqual([...PROJECT_BUNDLED_SKILLS]);

    const second = installBundledSkills(cwd, 'claude-code');
    expect(second.error).toBeUndefined();
    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual([...PROJECT_BUNDLED_SKILLS].sort());
  });

  it('routes claude-code installs to .claude/skills and harnext installs to .harnext/skills', () => {
    const claudeTarget = resolveAgentSkillsDir(cwd, 'claude-code');
    const harnextTarget = resolveAgentSkillsDir(cwd, 'harnext');
    expect(claudeTarget).toBe(join(cwd, '.claude', 'skills'));
    expect(harnextTarget).toBe(join(cwd, '.harnext', 'skills'));
  });
});
