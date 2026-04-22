import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getUserSkillsDir } from '../src/config.js';

describe('getUserSkillsDir', () => {
  const originalEnv = process.env.HARNEXT_USER_SKILLS_DIR;

  beforeEach(() => {
    delete process.env.HARNEXT_USER_SKILLS_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HARNEXT_USER_SKILLS_DIR;
    else process.env.HARNEXT_USER_SKILLS_DIR = originalEnv;
  });

  it('defaults to ~/.harnext/skills', () => {
    expect(getUserSkillsDir()).toBe(join(homedir(), '.harnext', 'skills'));
  });

  it('respects HARNEXT_USER_SKILLS_DIR override', () => {
    process.env.HARNEXT_USER_SKILLS_DIR = '/tmp/custom-skills';
    expect(getUserSkillsDir()).toBe('/tmp/custom-skills');
  });
});
