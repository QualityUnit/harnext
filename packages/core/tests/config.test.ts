import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getUserSkillsDir, VERSION } from '../src/config.js';

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

describe('VERSION', () => {
  it('matches the version in @harnext/core package.json', () => {
    // Regression: prior to 1.0.2, VERSION was a hardcoded string ('0.1.0')
    // that drifted from package.json on every release. The runtime resolver
    // must keep them in sync so `harnext --version` reports the actual
    // installed version.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
