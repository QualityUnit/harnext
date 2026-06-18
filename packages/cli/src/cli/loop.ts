import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@sinclair/typebox';

/**
 * Session-bound `/loop`. Unlike `/heartbeat` (durable, headless, crontab-backed),
 * a loop lives entirely inside one interactive session: a timer re-injects the
 * loop's prompt as a visible turn into the live conversation, and the loop dies
 * when the session ends. Two modes:
 *
 *   fixed   — `/loop 5m <prompt>`  fires every N on a clock the user set.
 *   dynamic — `/loop <prompt>`     each tick the model schedules its own next
 *             wake via the `schedule_wakeup` tool (or stops via `end_loop`).
 *
 * This module is pure state + parsing + tool definitions; all terminal I/O and
 * the actual agent run live in interactive-mode, which drives the controller.
 */

/** Floor for any interval/delay — guards against a runaway tight loop. */
export const MIN_INTERVAL_MS = 5_000;
/** Ceiling for a fixed interval — a session-bound loop longer than this is a
 * heartbeat in disguise; steer the user there instead. */
export const MAX_INTERVAL_MS = 24 * 60 * 60_000;

export type LoopMode = 'fixed' | 'dynamic';

export interface LoopSpec {
  mode: LoopMode;
  prompt: string;
  /** Fixed mode only: ms between ticks. */
  intervalMs?: number;
}

export interface LoopState {
  mode: LoopMode;
  prompt: string;
  intervalMs?: number;
  /** Completed ticks. */
  iterations: number;
  status: 'waiting' | 'running';
  /** Epoch ms of the next due tick (meaningful while `waiting`). */
  nextFireAt: number;
  startedAt: number;
  /** Dynamic mode: the reason attached to the most recent scheduled wake. */
  lastReason?: string;
}

export type ParseLoopResult =
  | { kind: 'spec'; spec: LoopSpec }
  | { kind: 'command'; command: 'stop' | 'status' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const DURATION_RE = /^(\d+)(s|m|h|d)$/i;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a single duration token (e.g. `5m`, `30s`, `2h`) to ms, or null. */
export function parseDuration(token: string): number | null {
  const m = DURATION_RE.exec(token);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * UNIT_MS[m[2].toLowerCase()];
}

/**
 * Parse the raw argument string after `/loop`. Shapes:
 *   ""              → help
 *   "stop"|"status" → control command
 *   "5m <prompt>"   → fixed spec
 *   "<prompt>"      → dynamic spec
 */
export function parseLoopArgs(raw: string): ParseLoopResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'help' };

  const lower = trimmed.toLowerCase();
  if (lower === 'stop' || lower === 'off' || lower === 'cancel') {
    return { kind: 'command', command: 'stop' };
  }
  if (lower === 'status' || lower === 'list') {
    return { kind: 'command', command: 'status' };
  }

  const spaceIdx = trimmed.search(/\s/);
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const intervalMs = parseDuration(firstToken);
  if (intervalMs !== null) {
    // Leading token is an interval → fixed mode, the remainder is the prompt.
    if (!rest) {
      return {
        kind: 'error',
        message: `Provide a prompt to run every ${firstToken}, e.g. /loop ${firstToken} check the build.`,
      };
    }
    if (intervalMs < MIN_INTERVAL_MS) {
      return { kind: 'error', message: `Interval too short — minimum is ${formatLoopDelay(MIN_INTERVAL_MS)}.` };
    }
    if (intervalMs > MAX_INTERVAL_MS) {
      return {
        kind: 'error',
        message: `Interval too long for a session loop (max ${formatLoopDelay(MAX_INTERVAL_MS)}). For longer schedules use /heartbeat.`,
      };
    }
    return { kind: 'spec', spec: { mode: 'fixed', prompt: rest, intervalMs } };
  }

  // No leading interval → self-paced; the whole string is the prompt.
  return { kind: 'spec', spec: { mode: 'dynamic', prompt: trimmed } };
}

export type LoopTickOutcome =
  | { kind: 'scheduled'; delayMs: number; reason?: string; iterations: number }
  | { kind: 'finished'; reason?: string; iterations: number; implicit: boolean }
  | { kind: 'stopped' };

type Directive =
  | { type: 'next'; delayMs: number; reason?: string }
  | { type: 'done'; reason?: string };

/**
 * Pure state machine for the single active loop in a session. No timers, no I/O:
 * interactive-mode polls `due()` once a second, runs the tick through the normal
 * prompt path, then calls `endTick()` to advance the schedule.
 */
export class LoopController {
  private state: LoopState | null = null;
  /** Set by the dynamic-mode tools during a tick; consumed by endTick(). */
  private directive: Directive | null = null;

  get active(): boolean {
    return this.state !== null;
  }

  /** Read-only view of the current loop, or null when idle. */
  get snapshot(): Readonly<LoopState> | null {
    return this.state;
  }

  /** Begin a loop. The first tick is due immediately (next poll). */
  start(spec: LoopSpec, now: number): void {
    this.state = {
      mode: spec.mode,
      prompt: spec.prompt,
      intervalMs: spec.intervalMs,
      iterations: 0,
      status: 'waiting',
      nextFireAt: now,
      startedAt: now,
    };
    this.directive = null;
  }

  /** Stop and clear the loop. Returns the final state (for a summary) or null. */
  stop(): LoopState | null {
    const s = this.state;
    this.state = null;
    this.directive = null;
    return s;
  }

  /** True when a tick is due and we are idle/waiting. */
  due(now: number): boolean {
    return this.state !== null && this.state.status === 'waiting' && now >= this.state.nextFireAt;
  }

  /** Mark a tick as in-flight. Returns the 1-based tick number for framing. */
  beginTick(): number {
    if (!this.state) throw new Error('no active loop');
    this.state.status = 'running';
    this.directive = null;
    return this.state.iterations + 1;
  }

  /** Dynamic mode: the model requests its next wake (via `schedule_wakeup`). */
  requestNextWake(delaySeconds: number, reason?: string): void {
    const delayMs = Math.min(
      MAX_INTERVAL_MS,
      Math.max(MIN_INTERVAL_MS, Math.round(delaySeconds * 1_000)),
    );
    this.directive = { type: 'next', delayMs, reason };
  }

  /** Dynamic mode: the model declares the task complete (via `end_loop`). */
  requestDone(reason?: string): void {
    this.directive = { type: 'done', reason };
  }

  /**
   * Advance after a tick's agent run completes. Fixed mode always reschedules;
   * dynamic mode follows the directive the tools set, and stops if the model
   * neither scheduled a wake nor declared completion (no silent runaway).
   */
  endTick(now: number): LoopTickOutcome {
    if (!this.state) return { kind: 'stopped' };
    this.state.iterations += 1;
    const iterations = this.state.iterations;

    if (this.state.mode === 'fixed') {
      const interval = this.state.intervalMs ?? MIN_INTERVAL_MS;
      this.state.status = 'waiting';
      this.state.nextFireAt = now + interval;
      return { kind: 'scheduled', delayMs: interval, iterations };
    }

    const directive = this.directive;
    this.directive = null;
    if (directive?.type === 'next') {
      this.state.status = 'waiting';
      this.state.nextFireAt = now + directive.delayMs;
      this.state.lastReason = directive.reason;
      return { kind: 'scheduled', delayMs: directive.delayMs, reason: directive.reason, iterations };
    }

    const reason = directive?.type === 'done' ? directive.reason : undefined;
    const implicit = !directive;
    this.state = null;
    return { kind: 'finished', reason, iterations, implicit };
  }
}

/**
 * Build the prompt injected on each tick. The system-reminder makes clear this
 * is an automated wake-up (not freshly typed by the user) and, for dynamic
 * loops, tells the model how to schedule its own next iteration.
 */
export function buildLoopTickPrompt(opts: {
  mode: LoopMode;
  prompt: string;
  tickNumber: number;
}): string {
  const reminder =
    `<system-reminder>This is an automated /loop wake-up — iteration #${opts.tickNumber}. ` +
    `A timer in the user's live session triggered it; the user did not just type this. ` +
    `The standing loop instruction is reproduced below — continue from the conversation so far.` +
    (opts.mode === 'dynamic'
      ? ` When you finish this iteration, do exactly one of: call \`schedule_wakeup\` ` +
        `(with the delay until you should next check, and a short reason) if the task is not ` +
        `yet done; or call \`end_loop\` (with a short summary) if it is complete. ` +
        `If you call neither, the loop stops.`
      : ` The loop will wake you again automatically on its fixed schedule.`) +
    `</system-reminder>\n\n${opts.prompt}`;
  return reminder;
}

/** Human-friendly delay: `45s`, `8m`, `1h30m`, `2h`. */
export function formatLoopDelay(ms: number): string {
  const totalSec = Math.round(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}

const scheduleWakeupSchema = Type.Object({
  delaySeconds: Type.Number({
    description:
      'Seconds until the next loop iteration should run. Choose it from how soon the ' +
      'situation could meaningfully change (short while a build runs; longer when a PR is quiet).',
  }),
  reason: Type.Optional(
    Type.String({
      description: 'Short, user-visible explanation of why you chose this delay.',
    }),
  ),
});

const endLoopSchema = Type.Object({
  reason: Type.Optional(
    Type.String({ description: 'Short, user-visible summary of why the loop is complete.' }),
  ),
});

export interface ScheduleWakeupDetails {
  scheduled: boolean;
  delaySeconds?: number;
  reason?: string;
}
export interface EndLoopDetails {
  ended: boolean;
  reason?: string;
}

/** Build the `schedule_wakeup` tool bound to a controller. */
function createScheduleWakeupTool(
  controller: LoopController,
): AgentTool<typeof scheduleWakeupSchema, ScheduleWakeupDetails> {
  return {
    name: 'schedule_wakeup',
    label: 'schedule_wakeup',
    description:
      'Schedule the next iteration of the current self-paced /loop. Call this once, at the ' +
      'end of your turn, when the looped task is not yet complete. The same loop prompt runs ' +
      'again after the delay.',
    parameters: scheduleWakeupSchema,
    async execute(_toolCallId, params) {
      if (!controller.active) {
        return {
          content: [{ type: 'text', text: 'No active self-paced loop; nothing scheduled.' }],
          details: { scheduled: false },
        };
      }
      controller.requestNextWake(params.delaySeconds, params.reason);
      const delayMs = Math.max(MIN_INTERVAL_MS, Math.round(params.delaySeconds * 1_000));
      return {
        content: [{ type: 'text', text: `Next wake-up scheduled in ${formatLoopDelay(delayMs)}.` }],
        details: { scheduled: true, delaySeconds: params.delaySeconds, reason: params.reason },
      };
    },
  };
}

/** Build the `end_loop` tool bound to a controller. */
function createEndLoopTool(
  controller: LoopController,
): AgentTool<typeof endLoopSchema, EndLoopDetails> {
  return {
    name: 'end_loop',
    label: 'end_loop',
    description:
      'End the current self-paced /loop because the task is complete. Call this instead of ' +
      'schedule_wakeup when there is no further work to do.',
    parameters: endLoopSchema,
    async execute(_toolCallId, params) {
      if (!controller.active) {
        return {
          content: [{ type: 'text', text: 'No active self-paced loop; nothing to end.' }],
          details: { ended: false },
        };
      }
      controller.requestDone(params.reason);
      return {
        content: [{ type: 'text', text: 'Loop will end after this iteration.' }],
        details: { ended: true, reason: params.reason },
      };
    },
  };
}

/**
 * The two tools a self-paced loop exposes. They are pushed onto the live agent's
 * tool list when a dynamic loop starts and removed when it stops, so they never
 * clutter the default tool set or a fixed-interval loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createLoopTools(controller: LoopController): AgentTool<any>[] {
  return [createScheduleWakeupTool(controller), createEndLoopTool(controller)];
}

/**
 * Bridge the always-on `loop` management tool to the live session. The
 * interactive REPL implements this (sharing its logic with the `/loop` slash
 * command) so a loop started by the agent behaves exactly like one a user typed.
 */
export interface LoopToolHost {
  /** Start a loop from a validated spec. Returns a model-facing message. */
  start(spec: LoopSpec): { ok: boolean; message: string };
  /** Stop the active loop. Returns a model-facing message. */
  stop(): { ok: boolean; message: string };
  /** Plain-text status of the active loop (or a "no loop" note). */
  status(): string;
}

const loopToolSchema = Type.Object({
  command: Type.Union(
    [Type.Literal('status'), Type.Literal('start'), Type.Literal('stop')],
    {
      description:
        'status: describe the active loop. start: begin a loop (provide a prompt; add an ' +
        'interval for fixed cadence, or omit it to self-pace). stop: end the active loop.',
    },
  ),
  interval: Type.Optional(
    Type.String({
      description:
        'Fixed cadence like "5m", "30s", "2h" (units s/m/h/d). Omit for a self-paced loop where ' +
        'you call schedule_wakeup each iteration to pick the next delay.',
    }),
  ),
  prompt: Type.Optional(
    Type.String({ description: 'The instruction to run each iteration. Required for start.' }),
  ),
});

export interface LoopToolDetails {
  command: string;
  ok: boolean;
}

/**
 * The always-on `loop` management tool. Lets the agent start/stop/inspect the
 * session loop itself — the same affordance the `/loop` command gives the user.
 */
export function createLoopManagementTool(
  host: LoopToolHost,
): AgentTool<typeof loopToolSchema, LoopToolDetails> {
  return {
    name: 'loop',
    label: 'loop',
    description:
      'Manage the session loop — a prompt that re-runs on a timer inside this live session and ' +
      'ends when the session does (use `heartbeat` instead for a durable cron schedule). ' +
      'Commands: status, start, stop. Starting one runs its first iteration shortly after your ' +
      'current turn ends.',
    parameters: loopToolSchema,
    async execute(_toolCallId, params) {
      const { command } = params;
      if (command === 'status') {
        return { content: [{ type: 'text', text: host.status() }], details: { command, ok: true } };
      }
      if (command === 'stop') {
        const r = host.stop();
        return { content: [{ type: 'text', text: r.message }], details: { command, ok: r.ok } };
      }
      // start
      const prompt = params.prompt?.trim();
      if (!prompt) {
        return {
          content: [{ type: 'text', text: 'Error: start requires a prompt.' }],
          details: { command, ok: false },
        };
      }
      const raw = (params.interval ? params.interval.trim() + ' ' : '') + prompt;
      const parsed = parseLoopArgs(raw);
      if (parsed.kind !== 'spec') {
        const message =
          parsed.kind === 'error'
            ? parsed.message
            : 'Error: could not interpret the loop arguments.';
        return { content: [{ type: 'text', text: message }], details: { command, ok: false } };
      }
      const r = host.start(parsed.spec);
      return { content: [{ type: 'text', text: r.message }], details: { command, ok: r.ok } };
    },
  };
}
