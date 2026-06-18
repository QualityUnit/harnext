import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendHeartbeatTick,
  createHeartbeatTool,
  loadHeartbeatConfig,
  type CrontabIO,
} from '../src/index.js';

/** In-memory crontab so the tool never touches the real user crontab. */
function fakeCrontab(): CrontabIO & { dump: () => string } {
  let store = '';
  return {
    read: () => store,
    write: (c: string) => {
      store = c;
    },
    dump: () => store,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTool(cwd: string, crontabIO: CrontabIO): any {
  return createHeartbeatTool(cwd, {
    cliPath: '/opt/harnext/index.js',
    nodePath: '/usr/bin/node',
    crontabIO,
  });
}

describe('heartbeat tool', () => {
  let home: string;
  const cwd = '/proj/example';
  const originalHome = process.env.HARNEXT_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-hb-tool-'));
    process.env.HARNEXT_HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('creates a heartbeat: saves config and installs a tagged cron line', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    const res = await tool.execute('id', {
      command: 'create',
      name: 'ci',
      interval_minutes: 5,
      prompt: 'check CI and report failures',
    });
    expect(res.details.ok).toBe(true);
    const cfg = loadHeartbeatConfig(cwd, 'ci');
    expect(cfg?.prompt).toBe('check CI and report failures');
    expect(cfg?.intervalMinutes).toBe(5);
    // The cron line is present, references the heartbeat, and carries its tag.
    expect(cron.dump()).toContain('--heartbeat ci');
    expect(cron.dump()).toContain('harnext:heartbeat:');
    expect(cron.dump()).toContain('*/5 * * * *');
  });

  it('rejects a duplicate name, a bad interval, and a missing prompt', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    await tool.execute('id', { command: 'create', name: 'ci', interval_minutes: 5, prompt: 'x' });

    const dup = await tool.execute('id', {
      command: 'create',
      name: 'ci',
      interval_minutes: 5,
      prompt: 'y',
    });
    expect(dup.details.ok).toBe(false);
    expect(dup.content[0].text).toContain('already exists');

    const badInterval = await tool.execute('id', {
      command: 'create',
      name: 'two',
      interval_minutes: 7,
      prompt: 'y',
    });
    expect(badInterval.details.ok).toBe(false);
    expect(badInterval.content[0].text).toContain('must be one of');

    const noPrompt = await tool.execute('id', {
      command: 'create',
      name: 'three',
      interval_minutes: 5,
    });
    expect(noPrompt.details.ok).toBe(false);
  });

  it('lists heartbeats with their cron status', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    await tool.execute('id', { command: 'create', name: 'ci', interval_minutes: 15, prompt: 'p' });

    const list = await tool.execute('id', { command: 'list' });
    expect(list.details.ok).toBe(true);
    expect(list.content[0].text).toContain('ci');
    expect(list.content[0].text).toContain('cron installed');
  });

  it('updates interval and prompt, reinstalling the cron line', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    await tool.execute('id', { command: 'create', name: 'ci', interval_minutes: 5, prompt: 'old' });

    const upd = await tool.execute('id', {
      command: 'update',
      name: 'ci',
      interval_minutes: 30,
      prompt: 'new prompt',
    });
    expect(upd.details.ok).toBe(true);
    const cfg = loadHeartbeatConfig(cwd, 'ci');
    expect(cfg?.intervalMinutes).toBe(30);
    expect(cfg?.prompt).toBe('new prompt');
    expect(cron.dump()).toContain('*/30 * * * *');
    // Exactly one cron line for this heartbeat (no stale duplicate).
    expect(cron.dump().split('\n').filter((l) => l.includes('--heartbeat ci')).length).toBe(1);
  });

  it('view_log reports empty, then surfaces tick records', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    await tool.execute('id', { command: 'create', name: 'ci', interval_minutes: 5, prompt: 'p' });

    const empty = await tool.execute('id', { command: 'view_log', name: 'ci' });
    expect(empty.content[0].text).toContain('No ticks logged yet');

    appendHeartbeatTick(cwd, 'ci', {
      ts: '2026-06-18T10:00:00.000Z',
      exit: 0,
      durationMs: 1234,
      prompt: 'p',
      output: 'all green',
    });
    const log = await tool.execute('id', { command: 'view_log', name: 'ci' });
    expect(log.content[0].text).toContain('all green');
    expect(log.content[0].text).toContain('ok');
  });

  it('deletes a heartbeat and removes its cron line', async () => {
    const cron = fakeCrontab();
    const tool = makeTool(cwd, cron);
    await tool.execute('id', { command: 'create', name: 'ci', interval_minutes: 5, prompt: 'p' });
    expect(cron.dump()).toContain('--heartbeat ci');

    const del = await tool.execute('id', { command: 'delete', name: 'ci' });
    expect(del.details.ok).toBe(true);
    expect(loadHeartbeatConfig(cwd, 'ci')).toBeNull();
    expect(cron.dump()).not.toContain('--heartbeat ci');

    const missing = await tool.execute('id', { command: 'delete', name: 'ci' });
    expect(missing.details.ok).toBe(false);
  });
});
