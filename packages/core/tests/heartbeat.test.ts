import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appendHeartbeatTick,
  buildCronLine,
  buildCronSchedule,
  deleteHeartbeatConfig,
  findCronLine,
  getHeartbeatPaths,
  getHeartbeatTag,
  getHeartbeatsDir,
  installCronLine,
  listHeartbeats,
  loadHeartbeatConfig,
  removeCronLine,
  saveHeartbeatConfig,
  validateHeartbeatName,
  type CrontabIO,
  type HeartbeatConfig,
} from '../src/heartbeat.js';

function makeFakeCrontab(initial = ''): CrontabIO & { get: () => string } {
  let contents = initial;
  return {
    read: () => contents,
    write: (c: string) => {
      contents = c;
    },
    get: () => contents,
  };
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'harnext-heartbeat-'));
}

let harnextHome: string;
const originalHarnextHome = process.env.HARNEXT_HOME;

beforeAll(() => {
  harnextHome = mkdtempSync(join(tmpdir(), 'harnext-home-heartbeat-'));
  process.env.HARNEXT_HOME = harnextHome;
});

afterAll(() => {
  if (originalHarnextHome === undefined) delete process.env.HARNEXT_HOME;
  else process.env.HARNEXT_HOME = originalHarnextHome;
  rmSync(harnextHome, { recursive: true, force: true });
});

describe('validateHeartbeatName', () => {
  it('accepts lowercase kebab-case names', () => {
    expect(validateHeartbeatName('ci-watch')).toBeNull();
    expect(validateHeartbeatName('daily')).toBeNull();
    expect(validateHeartbeatName('a1')).toBeNull();
  });

  it('rejects invalid names', () => {
    expect(validateHeartbeatName('')).not.toBeNull();
    expect(validateHeartbeatName('Foo')).not.toBeNull();
    expect(validateHeartbeatName('-leading')).not.toBeNull();
    expect(validateHeartbeatName('trailing-')).not.toBeNull();
    expect(validateHeartbeatName('double--hyphen')).not.toBeNull();
    expect(validateHeartbeatName('has space')).not.toBeNull();
    expect(validateHeartbeatName('a'.repeat(33))).not.toBeNull();
  });
});

describe('buildCronSchedule', () => {
  it('produces */N for sub-hour intervals that divide 60', () => {
    expect(buildCronSchedule(15)).toBe('*/15 * * * *');
    expect(buildCronSchedule(30)).toBe('*/30 * * * *');
  });

  it('produces `0 */h * * *` for hour-multiple intervals', () => {
    expect(buildCronSchedule(60)).toBe('0 */1 * * *');
    expect(buildCronSchedule(120)).toBe('0 */2 * * *');
    expect(buildCronSchedule(360)).toBe('0 */6 * * *');
  });

  it('maps 1440 min to daily @ midnight', () => {
    expect(buildCronSchedule(1440)).toBe('0 0 * * *');
  });

  it('rejects intervals that do not tile cleanly', () => {
    expect(() => buildCronSchedule(7)).toThrow();
    expect(() => buildCronSchedule(90)).toThrow();
    expect(() => buildCronSchedule(300)).toThrow();
  });
});

describe('getHeartbeatTag', () => {
  it('is stable for the same cwd + name', () => {
    expect(getHeartbeatTag('/a/b', 'ci')).toBe(getHeartbeatTag('/a/b', 'ci'));
  });

  it('differs by cwd', () => {
    expect(getHeartbeatTag('/a/b', 'ci')).not.toBe(getHeartbeatTag('/a/c', 'ci'));
  });

  it('differs by name within the same cwd', () => {
    expect(getHeartbeatTag('/a/b', 'ci')).not.toBe(getHeartbeatTag('/a/b', 'daily'));
  });

  it('uses the harnext:heartbeat:<hash>:<name> shape', () => {
    expect(getHeartbeatTag('/x', 'ci-watch')).toMatch(/^harnext:heartbeat:[0-9a-f]+:ci-watch$/);
  });
});

describe('buildCronLine', () => {
  it('embeds schedule, node, cli --heartbeat <name>, cwd, log path, and tag', () => {
    const line = buildCronLine({
      schedule: '*/15 * * * *',
      cliPath: '/opt/harnext/cli.js',
      cwd: '/home/u/proj',
      name: 'ci',
      tag: 'harnext:heartbeat:abc:ci',
      nodePath: '/usr/bin/node',
    });
    expect(line).toContain('*/15 * * * *');
    expect(line).toContain('/usr/bin/node');
    expect(line).toContain('/opt/harnext/cli.js --heartbeat ci');
    expect(line).toContain('cd /home/u/proj');
    expect(line).toContain(getHeartbeatPaths('/home/u/proj', 'ci').log);
    expect(line).toContain('# harnext:heartbeat:abc:ci');
  });

  it('shell-quotes paths containing spaces', () => {
    const line = buildCronLine({
      schedule: '*/15 * * * *',
      cliPath: '/opt/with space/cli.js',
      cwd: '/home/u/my proj',
      name: 'ci',
      tag: 'harnext:heartbeat:xyz:ci',
    });
    expect(line).toContain(`'/opt/with space/cli.js'`);
    expect(line).toContain(`'/home/u/my proj'`);
  });

  it('injects PATH when provided', () => {
    const line = buildCronLine({
      schedule: '*/15 * * * *',
      cliPath: '/opt/cli.js',
      cwd: '/home/u/proj',
      name: 'ci',
      tag: 'harnext:heartbeat:abc:ci',
      nodePath: '/usr/bin/node',
      path: '/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin',
    });
    expect(line).toContain('PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin');
    expect(line).toMatch(/cd \/home\/u\/proj && PATH=\S+ \/usr\/bin\/node /);
  });
});

describe('config load/save/delete/list', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const base: Omit<HeartbeatConfig, 'cwd'> = {
    name: 'ci',
    intervalMinutes: 15,
    prompt: 'Check CI status',
    updatedAt: 123,
  };

  it('round-trips a config through disk', () => {
    const cfg = { ...base, cwd };
    saveHeartbeatConfig(cfg);
    expect(existsSync(getHeartbeatPaths(cwd, 'ci').config)).toBe(true);
    expect(loadHeartbeatConfig(cwd, 'ci')).toEqual(cfg);
  });

  it('returns null when no config exists', () => {
    expect(loadHeartbeatConfig(cwd, 'missing')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    saveHeartbeatConfig({ ...base, cwd });
    writeFileSync(getHeartbeatPaths(cwd, 'ci').config, 'not json', 'utf-8');
    expect(loadHeartbeatConfig(cwd, 'ci')).toBeNull();
  });

  it('deleteHeartbeatConfig removes one entry without touching others', () => {
    saveHeartbeatConfig({ ...base, name: 'ci', cwd });
    saveHeartbeatConfig({ ...base, name: 'daily', cwd, intervalMinutes: 1440 });

    expect(deleteHeartbeatConfig(cwd, 'ci')).toBe(true);
    expect(loadHeartbeatConfig(cwd, 'ci')).toBeNull();
    expect(loadHeartbeatConfig(cwd, 'daily')).not.toBeNull();
  });

  it('deleteHeartbeatConfig returns false when nothing to delete', () => {
    expect(deleteHeartbeatConfig(cwd, 'never-was')).toBe(false);
  });

  it('saveHeartbeatConfig rejects invalid names', () => {
    expect(() => saveHeartbeatConfig({ ...base, name: 'Bad Name', cwd })).toThrow();
  });

  it('listHeartbeats returns all configs sorted by name', () => {
    expect(listHeartbeats(cwd)).toEqual([]);
    saveHeartbeatConfig({ ...base, name: 'daily', cwd, intervalMinutes: 1440 });
    saveHeartbeatConfig({ ...base, name: 'ci', cwd });
    saveHeartbeatConfig({ ...base, name: 'a-task', cwd });

    const names = listHeartbeats(cwd).map((c) => c.name);
    expect(names).toEqual(['a-task', 'ci', 'daily']);
  });

  it('listHeartbeats skips malformed entries', () => {
    saveHeartbeatConfig({ ...base, name: 'good', cwd });
    writeFileSync(join(getHeartbeatsDir(cwd), 'broken.json'), '{ not json', 'utf-8');
    const names = listHeartbeats(cwd).map((c) => c.name);
    expect(names).toEqual(['good']);
  });
});

describe('crontab install/remove/find', () => {
  const tag = 'harnext:heartbeat:aaa:ci';
  const line = `*/15 * * * * /usr/bin/node /x/cli.js --heartbeat ci # ${tag}`;

  it('installs a fresh line into an empty crontab', () => {
    const io = makeFakeCrontab('');
    expect(installCronLine(line, tag, io)).toBe(true);
    expect(io.get()).toBe(`${line}\n`);
  });

  it('replaces an existing line with the same tag, leaves others alone', () => {
    const oldLine = `*/30 * * * * /other/cli.js --heartbeat ci # ${tag}`;
    const otherTag = 'harnext:heartbeat:aaa:daily';
    const otherLine = `0 0 * * * /x/cli.js --heartbeat daily # ${otherTag}`;
    const unrelated = '0 * * * * /some/other/job.sh';
    const io = makeFakeCrontab(`${unrelated}\n${oldLine}\n${otherLine}\n`);

    expect(installCronLine(line, tag, io)).toBe(true);
    const out = io.get();
    expect(out).toContain(unrelated);
    expect(out).toContain(line);
    expect(out).toContain(otherLine);
    expect(out).not.toContain('/other/cli.js');
  });

  it('removes only the tagged line', () => {
    const unrelated = '0 * * * * /some/other/job.sh';
    const io = makeFakeCrontab(`${unrelated}\n${line}\n`);
    expect(removeCronLine(tag, io)).toBe(true);
    expect(io.get()).toBe(`${unrelated}\n`);
  });

  it('removeCronLine returns false when tag not present', () => {
    const io = makeFakeCrontab('0 * * * * /some/other/job.sh\n');
    expect(removeCronLine(tag, io)).toBe(false);
  });

  it('findCronLine returns the matching line or null', () => {
    expect(findCronLine(tag, makeFakeCrontab(`${line}\n`))).toContain(tag);
    expect(findCronLine(tag, makeFakeCrontab(''))).toBeNull();
  });
});

describe('appendHeartbeatTick', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmpCwd();
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('appends JSONL records per-heartbeat, creating the dir as needed', () => {
    appendHeartbeatTick(cwd, 'ci', {
      ts: '2026-04-18T00:00:00.000Z',
      exit: 0,
      durationMs: 42,
      prompt: 'ping',
      output: 'pong',
    });
    appendHeartbeatTick(cwd, 'ci', {
      ts: '2026-04-18T00:15:00.000Z',
      exit: 1,
      durationMs: 99,
      prompt: 'ping',
      output: '',
      error: 'boom',
    });
    appendHeartbeatTick(cwd, 'daily', {
      ts: '2026-04-18T12:00:00.000Z',
      exit: 0,
      durationMs: 10,
      prompt: 'x',
      output: 'y',
    });

    const ciLog = getHeartbeatPaths(cwd, 'ci').log;
    const dailyLog = getHeartbeatPaths(cwd, 'daily').log;

    const ciLines = readFileSync(ciLog, 'utf-8').trim().split('\n');
    expect(ciLines).toHaveLength(2);
    expect(JSON.parse(ciLines[1]).error).toBe('boom');

    const dailyLines = readFileSync(dailyLog, 'utf-8').trim().split('\n');
    expect(dailyLines).toHaveLength(1);
    expect(JSON.parse(dailyLines[0]).output).toBe('y');
  });
});
