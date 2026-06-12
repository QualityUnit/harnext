import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CLOUD_SYNC_SETTINGS,
  loadSettings,
  setCloudSyncSettings,
} from '../src/settings.js';

let tmpHome: string;
let tmpProject: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'harnext-cloud-home-'));
  tmpProject = mkdtempSync(join(tmpdir(), 'harnext-cloud-proj-'));
  originalHome = process.env.HARNEXT_HOME;
  process.env.HARNEXT_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProject, { recursive: true, force: true });
});

describe('cloudSync settings', () => {
  it('defaults to disabled with the harnext harness', () => {
    expect(loadSettings(tmpProject).cloudSync).toEqual(DEFAULT_CLOUD_SYNC_SETTINGS);
  });

  it('merges user-wide cloudSync over defaults', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ cloudSync: { enabled: true, endpoint: 'http://engine' } }),
    );
    expect(loadSettings(tmpProject).cloudSync).toEqual({
      enabled: true,
      endpoint: 'http://engine',
      harness: 'harnext',
    });
  });

  it('setCloudSyncSettings persists a patch without clobbering other settings', () => {
    const agentDir = join(tmpHome, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { reserveTokens: 32000 } }),
    );

    setCloudSyncSettings({ enabled: true, endpoint: 'http://engine' });

    const onDisk = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'));
    expect(onDisk.compaction.reserveTokens).toBe(32000); // untouched
    expect(onDisk.cloudSync).toEqual({ enabled: true, endpoint: 'http://engine' });

    const loaded = loadSettings(tmpProject);
    expect(loaded.cloudSync.enabled).toBe(true);
    expect(loaded.compaction.reserveTokens).toBe(32000);
  });
});
