import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatSkillsForPrompt, loadSkills, type Skill } from '../src/skills.js';

function writeSkill(dir: string, name: string, description: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const file = join(skillDir, 'SKILL.md');
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${name}\n`,
  );
  return file;
}

describe('loadSkills (project + user)', () => {
  let projectCwd: string;
  let userDir: string;
  const originalEnv = process.env.HARNEXT_USER_SKILLS_DIR;

  beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'harnext-proj-'));
    userDir = mkdtempSync(join(tmpdir(), 'harnext-user-'));
    process.env.HARNEXT_USER_SKILLS_DIR = userDir;
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.HARNEXT_USER_SKILLS_DIR;
    else process.env.HARNEXT_USER_SKILLS_DIR = originalEnv;
  });

  it('loads project-only skill', () => {
    const projectSkillsDir = join(projectCwd, '.harnext', 'skills');
    writeSkill(projectSkillsDir, 'alpha', 'project alpha');

    const { skills, diagnostics } = loadSkills({ cwd: projectCwd });
    expect(skills.map((s) => s.name)).toEqual(['alpha']);
    expect(skills[0].description).toBe('project alpha');
    expect(diagnostics).toEqual([]);
  });

  it('loads user-only skill', () => {
    writeSkill(userDir, 'beta', 'user beta');

    const { skills, diagnostics } = loadSkills({ cwd: projectCwd });
    expect(skills.map((s) => s.name)).toEqual(['beta']);
    expect(skills[0].description).toBe('user beta');
    expect(diagnostics).toEqual([]);
  });

  it('merges project and user skills', () => {
    const projectSkillsDir = join(projectCwd, '.harnext', 'skills');
    writeSkill(projectSkillsDir, 'alpha', 'project alpha');
    writeSkill(userDir, 'beta', 'user beta');

    const { skills } = loadSkills({ cwd: projectCwd });
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('formatSkillsForPrompt directs the model at the skill tool, not a tool-named-after-the-skill', () => {
    const skill: Skill = {
      name: 'meeting-transcribe',
      description: 'Transcribe a meeting recording.',
      filePath: '/tmp/skills/meeting-transcribe/SKILL.md',
      baseDir: '/tmp/skills/meeting-transcribe',
      disableModelInvocation: false,
    };
    const prompt = formatSkillsForPrompt([skill]);

    expect(prompt).toContain('Skills are NOT tools');
    expect(prompt).toContain('`skill` tool');
    expect(prompt).toContain('"name": "<skill-name>"');
    expect(prompt).toContain('<name>meeting-transcribe</name>');
  });

  it('formatSkillsForPrompt returns empty when only hidden skills are present', () => {
    const hidden: Skill = {
      name: 'private',
      description: 'd',
      filePath: '/tmp/skills/private/SKILL.md',
      baseDir: '/tmp/skills/private',
      disableModelInvocation: true,
    };
    expect(formatSkillsForPrompt([hidden])).toBe('');
  });

  it('project wins on name collision and emits a collision diagnostic', () => {
    const projectSkillsDir = join(projectCwd, '.harnext', 'skills');
    writeSkill(projectSkillsDir, 'shared', 'from project');
    const userPath = writeSkill(userDir, 'shared', 'from user');

    const { skills, diagnostics } = loadSkills({ cwd: projectCwd });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('from project');

    const collision = diagnostics.find((d) => d.type === 'collision');
    expect(collision).toBeDefined();
    expect(collision?.path).toBe(userPath);
  });
});
