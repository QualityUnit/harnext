import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBundledSkills, getBundledSkillsDir, seedBuiltinSkills } from '../src/seed.js';

describe('seedBuiltinSkills', () => {
  let userDir: string;
  let parentDir: string;
  const originalSkillsEnv = process.env.HARNEXT_USER_SKILLS_DIR;
  const originalNoSeedEnv = process.env.HARNEXT_NO_SEED_SKILLS;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'harnext-seed-'));
    userDir = join(parentDir, 'skills');
    process.env.HARNEXT_USER_SKILLS_DIR = userDir;
    delete process.env.HARNEXT_NO_SEED_SKILLS;
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
    if (originalSkillsEnv === undefined) delete process.env.HARNEXT_USER_SKILLS_DIR;
    else process.env.HARNEXT_USER_SKILLS_DIR = originalSkillsEnv;
    if (originalNoSeedEnv === undefined) delete process.env.HARNEXT_NO_SEED_SKILLS;
    else process.env.HARNEXT_NO_SEED_SKILLS = originalNoSeedEnv;
  });

  it('seeds bundled skills when the target dir does not exist', () => {
    expect(existsSync(userDir)).toBe(false);

    const result = seedBuiltinSkills();

    expect(result.seeded).toBe(true);
    expect(result.target).toBe(userDir);
    expect(result.diagnostics).toEqual([]);

    expect(existsSync(join(userDir, 'init', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'browser-verify', 'SKILL.md'))).toBe(true);

    const initBody = readFileSync(join(userDir, 'init', 'SKILL.md'), 'utf-8');
    expect(initBody).toContain('name: init');
  });

  it('no-ops when target dir already exists (even empty)', () => {
    mkdirSync(userDir, { recursive: true });

    const result = seedBuiltinSkills();

    expect(result.seeded).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(existsSync(join(userDir, 'init'))).toBe(false);
  });

  it('does not overwrite user-modified skills on subsequent runs', () => {
    seedBuiltinSkills();

    const initFile = join(userDir, 'init', 'SKILL.md');
    const past = new Date(Date.now() - 60_000);
    utimesSync(initFile, past, past);
    const mtimeBefore = readFileSync(initFile, 'utf-8');

    const second = seedBuiltinSkills();

    expect(second.seeded).toBe(false);
    expect(readFileSync(initFile, 'utf-8')).toBe(mtimeBefore);
  });

  it('honors HARNEXT_NO_SEED_SKILLS=1', () => {
    process.env.HARNEXT_NO_SEED_SKILLS = '1';

    const result = seedBuiltinSkills();

    expect(result.seeded).toBe(false);
    expect(existsSync(userDir)).toBe(false);
  });

  it('exposes the bundled skills dir containing init, review, and browser-verify', () => {
    const bundled = getBundledSkillsDir();
    expect(existsSync(join(bundled, 'init', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(bundled, 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(bundled, 'browser-verify', 'SKILL.md'))).toBe(true);
  });
});

describe('ensureBundledSkills', () => {
  let userDir: string;
  let parentDir: string;
  const originalSkillsEnv = process.env.HARNEXT_USER_SKILLS_DIR;
  const originalNoSeedEnv = process.env.HARNEXT_NO_SEED_SKILLS;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), 'harnext-ensure-'));
    userDir = join(parentDir, 'skills');
    process.env.HARNEXT_USER_SKILLS_DIR = userDir;
    delete process.env.HARNEXT_NO_SEED_SKILLS;
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
    if (originalSkillsEnv === undefined) delete process.env.HARNEXT_USER_SKILLS_DIR;
    else process.env.HARNEXT_USER_SKILLS_DIR = originalSkillsEnv;
    if (originalNoSeedEnv === undefined) delete process.env.HARNEXT_NO_SEED_SKILLS;
    else process.env.HARNEXT_NO_SEED_SKILLS = originalNoSeedEnv;
  });

  it('copies all bundled skills into an empty dir and reports them as added', () => {
    const r = ensureBundledSkills();

    expect(r.target).toBe(userDir);
    expect(r.added.sort()).toEqual(['browser-verify', 'init', 'report-harnext-issue', 'review']);
    expect(r.present).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(existsSync(join(userDir, 'init', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'browser-verify', 'SKILL.md'))).toBe(true);
  });

  it('skips existing entries and only tops up missing ones', () => {
    mkdirSync(join(userDir, 'init'), { recursive: true });
    writeFileSync(join(userDir, 'init', 'SKILL.md'), '---\nname: init\ndescription: custom\n---\n');
    const customMtime = new Date(Date.now() - 60_000);
    utimesSync(join(userDir, 'init', 'SKILL.md'), customMtime, customMtime);
    const customContent = readFileSync(join(userDir, 'init', 'SKILL.md'), 'utf-8');

    const r = ensureBundledSkills();

    expect(r.added.sort()).toEqual(['browser-verify', 'report-harnext-issue', 'review']);
    expect(r.present).toEqual(['init']);
    expect(readFileSync(join(userDir, 'init', 'SKILL.md'), 'utf-8')).toBe(customContent);
    expect(existsSync(join(userDir, 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'browser-verify', 'SKILL.md'))).toBe(true);
  });

  it('ignores HARNEXT_NO_SEED_SKILLS (explicit invocation)', () => {
    process.env.HARNEXT_NO_SEED_SKILLS = '1';

    const r = ensureBundledSkills();

    expect(r.added.sort()).toEqual(['browser-verify', 'init', 'report-harnext-issue', 'review']);
  });
});
