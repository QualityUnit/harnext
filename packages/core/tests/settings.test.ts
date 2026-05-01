import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_COMPACTION_SETTINGS, loadSettings } from '../src/settings.js';

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'harnext-settings-home-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'harnext-settings-proj-'));
  originalHome = process.env.HARNEXT_HOME;
  process.env.HARNEXT_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('returns defaults when no settings files exist', () => {
    const s = loadSettings(tmpProject);
    expect(s.compaction).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it('reads user-wide settings under the agent dir', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { reserveTokens: 32000, keepRecentTokens: 40000 } }),
    );
    const s = loadSettings(tmpProject);
    expect(s.compaction.reserveTokens).toBe(32000);
    expect(s.compaction.keepRecentTokens).toBe(40000);
    expect(s.compaction.enabled).toBe(true); // default preserved
  });

  it('project settings override user settings', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { reserveTokens: 32000 } }),
    );
    const projConfigDir = join(tmpProject, '.harnext');
    mkdirSync(projConfigDir, { recursive: true });
    writeFileSync(
      join(projConfigDir, 'settings.json'),
      JSON.stringify({ compaction: { reserveTokens: 8000, enabled: false } }),
    );
    const s = loadSettings(tmpProject);
    expect(s.compaction.reserveTokens).toBe(8000);
    expect(s.compaction.enabled).toBe(false);
  });

  it('ignores malformed settings files and falls back to defaults', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), '{ not valid json');
    const s = loadSettings(tmpProject);
    expect(s.compaction).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });

  it('rejects non-positive token values', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { reserveTokens: 0, keepRecentTokens: -5 } }),
    );
    const s = loadSettings(tmpProject);
    expect(s.compaction.reserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    expect(s.compaction.keepRecentTokens).toBe(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  });
});
