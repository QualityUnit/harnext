import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Skill } from '../src/skills.js';
import { createSkillTool } from '../src/tools/skill.js';

function makeSkill(baseDir: string, name: string, body: string, opts?: { hidden?: boolean }): Skill {
  const skillDir = join(baseDir, name);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, 'SKILL.md');
  writeFileSync(filePath, body);
  return {
    name,
    description: `desc for ${name}`,
    filePath,
    baseDir: skillDir,
    disableModelInvocation: opts?.hidden === true,
  };
}

describe('skill tool', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'harnext-skill-tool-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns the SKILL.md wrapped with name and location metadata', async () => {
    const body = '---\nname: alpha\ndescription: alpha desc\n---\n\nrun the alpha steps\n';
    const alpha = makeSkill(workDir, 'alpha', body);
    const tool = createSkillTool(() => [alpha]);

    const result = await tool.execute('id', { name: 'alpha' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain(`<skill name="alpha" location="${alpha.filePath}">`);
    expect(text).toContain(`References are relative to ${alpha.baseDir}.`);
    expect(text).toContain('run the alpha steps');
    expect(text.trimEnd().endsWith('</skill>')).toBe(true);
    expect(result.details).toEqual({ name: 'alpha', found: true });
  });

  it('returns an error message and lists available skills when name is unknown', async () => {
    const alpha = makeSkill(workDir, 'alpha', '---\ndescription: a\n---\nbody\n');
    const beta = makeSkill(workDir, 'beta', '---\ndescription: b\n---\nbody\n');
    const tool = createSkillTool(() => [alpha, beta]);

    const result = await tool.execute('id', { name: 'gamma' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('Unknown skill "gamma"');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(result.details).toEqual({ name: 'gamma', found: false });
  });

  it('treats disableModelInvocation skills as not invocable by the model', async () => {
    const hidden = makeSkill(workDir, 'private', '---\ndescription: x\n---\nbody\n', { hidden: true });
    const tool = createSkillTool(() => [hidden]);

    const result = await tool.execute('id', { name: 'private' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('Unknown skill "private"');
    expect(text).toContain('No skills are loaded.');
    expect(result.details.found).toBe(false);
  });

  it('reports a read error when the SKILL.md file is missing', async () => {
    const ghost: Skill = {
      name: 'ghost',
      description: 'd',
      filePath: join(workDir, 'ghost', 'SKILL.md'),
      baseDir: join(workDir, 'ghost'),
      disableModelInvocation: false,
    };
    const tool = createSkillTool(() => [ghost]);

    const result = await tool.execute('id', { name: 'ghost' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('Error reading skill "ghost"');
    expect(result.details).toEqual({ name: 'ghost', found: true });
  });
});
