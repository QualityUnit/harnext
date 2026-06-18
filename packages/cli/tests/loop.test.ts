import { describe, expect, it } from 'vitest';

import {
  LoopController,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  buildLoopTickPrompt,
  createLoopManagementTool,
  createLoopTools,
  formatLoopDelay,
  parseDuration,
  parseLoopArgs,
  type LoopSpec,
  type LoopToolHost,
} from '../src/cli/loop.js';

describe('parseDuration', () => {
  it('parses each unit', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('is case-insensitive', () => {
    expect(parseDuration('5M')).toBe(300_000);
  });

  it('rejects junk and zero', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('5')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
  });
});

describe('parseLoopArgs', () => {
  it('treats empty input as help', () => {
    expect(parseLoopArgs('')).toEqual({ kind: 'help' });
    expect(parseLoopArgs('   ')).toEqual({ kind: 'help' });
  });

  it('recognizes control commands', () => {
    expect(parseLoopArgs('stop')).toEqual({ kind: 'command', command: 'stop' });
    expect(parseLoopArgs('STATUS')).toEqual({ kind: 'command', command: 'status' });
  });

  it('parses a fixed-interval spec', () => {
    expect(parseLoopArgs('5m check the build')).toEqual({
      kind: 'spec',
      spec: { mode: 'fixed', prompt: 'check the build', intervalMs: 300_000 },
    });
  });

  it('parses a self-paced spec when no leading interval', () => {
    expect(parseLoopArgs('watch CI until it is green')).toEqual({
      kind: 'spec',
      spec: { mode: 'dynamic', prompt: 'watch CI until it is green' },
    });
  });

  it('errors when an interval has no prompt', () => {
    const r = parseLoopArgs('5m');
    expect(r.kind).toBe('error');
  });

  it('errors when the interval is below the floor', () => {
    const r = parseLoopArgs('1s do thing');
    expect(r.kind).toBe('error');
  });

  it('errors when the interval is above the ceiling', () => {
    const r = parseLoopArgs('2d do thing');
    expect(r.kind).toBe('error');
  });
});

describe('LoopController — fixed mode', () => {
  it('fires immediately then reschedules by the interval', () => {
    const c = new LoopController();
    c.start({ mode: 'fixed', prompt: 'p', intervalMs: 60_000 }, 1_000);
    expect(c.active).toBe(true);
    expect(c.due(1_000)).toBe(true);

    expect(c.beginTick()).toBe(1);
    expect(c.due(1_000)).toBe(false); // running, not due

    const out = c.endTick(2_000);
    expect(out).toEqual({ kind: 'scheduled', delayMs: 60_000, iterations: 1 });
    expect(c.due(2_000)).toBe(false);
    expect(c.due(62_000)).toBe(true); // next.fireAt = 2_000 + 60_000

    c.beginTick();
    const out2 = c.endTick(62_000);
    expect(out2).toMatchObject({ kind: 'scheduled', iterations: 2 });
  });

  it('ignores dynamic directives and keeps the fixed schedule', () => {
    const c = new LoopController();
    c.start({ mode: 'fixed', prompt: 'p', intervalMs: 30_000 }, 0);
    c.beginTick();
    c.requestDone('done'); // a stray tool call must not stop a fixed loop
    const out = c.endTick(0);
    expect(out.kind).toBe('scheduled');
    expect(c.active).toBe(true);
  });
});

describe('LoopController — dynamic mode', () => {
  it('reschedules from schedule_wakeup with a floored delay', () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    c.beginTick();
    c.requestNextWake(480, 'CI still running');
    const out = c.endTick(1_000);
    expect(out).toMatchObject({ kind: 'scheduled', delayMs: 480_000, reason: 'CI still running', iterations: 1 });
    expect(c.snapshot?.lastReason).toBe('CI still running');
    expect(c.due(1_000 + 480_000)).toBe(true);
  });

  it('floors and caps the requested delay', () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    c.beginTick();
    c.requestNextWake(1); // below floor
    let out = c.endTick(0);
    expect(out).toMatchObject({ kind: 'scheduled', delayMs: MIN_INTERVAL_MS });

    c.beginTick();
    c.requestNextWake(10 * 24 * 3600); // above ceiling
    out = c.endTick(0);
    expect(out).toMatchObject({ kind: 'scheduled', delayMs: MAX_INTERVAL_MS });
  });

  it('finishes on end_loop', () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    c.beginTick();
    c.requestDone('all green');
    const out = c.endTick(0);
    expect(out).toEqual({ kind: 'finished', reason: 'all green', iterations: 1, implicit: false });
    expect(c.active).toBe(false);
  });

  it('finishes implicitly when the model schedules nothing', () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    c.beginTick();
    const out = c.endTick(0);
    expect(out).toEqual({ kind: 'finished', reason: undefined, iterations: 1, implicit: true });
    expect(c.active).toBe(false);
  });

  it('clears a stale directive at the start of the next tick', () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    c.beginTick();
    c.requestNextWake(60);
    c.endTick(0);
    // Next tick: model calls nothing → should finish implicitly, not reuse the old wake.
    c.beginTick();
    const out = c.endTick(0);
    expect(out).toMatchObject({ kind: 'finished', implicit: true });
  });
});

describe('stop()', () => {
  it('clears the loop and returns the final state', () => {
    const c = new LoopController();
    c.start({ mode: 'fixed', prompt: 'p', intervalMs: 60_000 }, 0);
    const s = c.stop();
    expect(s?.prompt).toBe('p');
    expect(c.active).toBe(false);
    expect(c.stop()).toBeNull();
  });
});

describe('buildLoopTickPrompt', () => {
  it('includes the iteration number and the original prompt', () => {
    const out = buildLoopTickPrompt({ mode: 'fixed', prompt: 'do X', tickNumber: 3 });
    expect(out).toContain('iteration #3');
    expect(out).toContain('do X');
    expect(out).toContain('fixed schedule');
  });

  it('instructs dynamic loops to call the scheduling tools', () => {
    const out = buildLoopTickPrompt({ mode: 'dynamic', prompt: 'watch', tickNumber: 1 });
    expect(out).toContain('schedule_wakeup');
    expect(out).toContain('end_loop');
  });
});

describe('formatLoopDelay', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatLoopDelay(45_000)).toBe('45s');
    expect(formatLoopDelay(8 * 60_000)).toBe('8m');
    expect(formatLoopDelay(2 * 3_600_000)).toBe('2h');
    expect(formatLoopDelay(90 * 60_000)).toBe('1h30m');
  });
});

describe('createLoopTools', () => {
  it('routes schedule_wakeup and end_loop into the controller', async () => {
    const c = new LoopController();
    c.start({ mode: 'dynamic', prompt: 'p' }, 0);
    const [schedule, end] = createLoopTools(c);
    expect(schedule.name).toBe('schedule_wakeup');
    expect(end.name).toBe('end_loop');

    c.beginTick();
    await schedule.execute('id', { delaySeconds: 120, reason: 'pending' });
    const out = c.endTick(0);
    expect(out).toMatchObject({ kind: 'scheduled', delayMs: 120_000, reason: 'pending' });
  });

  it('is inert when called with no active loop', async () => {
    const c = new LoopController();
    const [schedule] = createLoopTools(c);
    const res = await schedule.execute('id', { delaySeconds: 60 });
    expect((res.details as { scheduled: boolean }).scheduled).toBe(false);
  });
});

describe('createLoopManagementTool', () => {
  function fakeHost() {
    const starts: LoopSpec[] = [];
    let stopped = 0;
    const host: LoopToolHost = {
      start: (spec) => {
        starts.push(spec);
        return { ok: true, message: 'started' };
      },
      stop: () => {
        stopped++;
        return { ok: true, message: 'stopped' };
      },
      status: () => 'status text',
    };
    return { host, starts, stopped: () => stopped };
  }

  it('routes status/stop to the host', async () => {
    const { host } = fakeHost();
    const tool = createLoopManagementTool(host);
    expect(tool.name).toBe('loop');
    const st = await tool.execute('id', { command: 'status' });
    expect(st.content[0].text).toBe('status text');
    const sp = await tool.execute('id', { command: 'stop' });
    expect(sp.content[0].text).toBe('stopped');
  });

  it('parses a fixed-interval start into a spec', async () => {
    const { host, starts } = fakeHost();
    const tool = createLoopManagementTool(host);
    const res = await tool.execute('id', {
      command: 'start',
      interval: '5m',
      prompt: 'check the build',
    });
    expect(res.details.ok).toBe(true);
    expect(starts[0]).toEqual({ mode: 'fixed', prompt: 'check the build', intervalMs: 300_000 });
  });

  it('parses a self-paced start (no interval) into a dynamic spec', async () => {
    const { host, starts } = fakeHost();
    const tool = createLoopManagementTool(host);
    await tool.execute('id', { command: 'start', prompt: 'watch CI' });
    expect(starts[0]).toEqual({ mode: 'dynamic', prompt: 'watch CI' });
  });

  it('errors on start without a prompt, and on a bad interval', async () => {
    const { host, starts } = fakeHost();
    const tool = createLoopManagementTool(host);
    const noPrompt = await tool.execute('id', { command: 'start' });
    expect(noPrompt.details.ok).toBe(false);
    const badInterval = await tool.execute('id', {
      command: 'start',
      interval: '1s',
      prompt: 'x',
    });
    expect(badInterval.details.ok).toBe(false);
    expect(starts.length).toBe(0);
  });
});
