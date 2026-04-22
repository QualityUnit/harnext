import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { getProjectStateDir } from './config.js';

export const HEARTBEAT_INTERVAL_PRESETS = [1, 3, 5, 15, 30, 60, 120, 360, 720, 1440] as const;
export type HeartbeatIntervalMinutes = (typeof HEARTBEAT_INTERVAL_PRESETS)[number];

export const HEARTBEATS_DIR_NAME = 'heartbeats';
const MAX_NAME_LENGTH = 32;

export interface HeartbeatConfig {
  /** Stable identifier for this heartbeat within the project. */
  name: string;
  /** Interval between ticks, in minutes. */
  intervalMinutes: HeartbeatIntervalMinutes;
  /** Prompt the agent runs on each tick. */
  prompt: string;
  /** Absolute path to the project this heartbeat watches. */
  cwd: string;
  /** Provider used when the cron tick runs. Optional — tick falls back to saved prefs. */
  provider?: string;
  /** Model used when the cron tick runs. Optional — tick falls back to saved prefs. */
  model?: string;
  /** Epoch ms when the config was last written. */
  updatedAt: number;
}

export interface HeartbeatPaths {
  /** Base dir containing all heartbeats for this project. */
  dir: string;
  /** Per-heartbeat JSON config file. */
  config: string;
  /** Per-heartbeat JSONL tick log. */
  log: string;
}

/**
 * Validate a heartbeat name. Same rules as skill names so the cron tag and
 * on-disk filenames stay predictable: lowercase a-z, 0-9, hyphens, no leading
 * or trailing hyphen, no double hyphens, 1..32 chars.
 */
export function validateHeartbeatName(name: string): string | null {
  if (!name) return 'name is required';
  if (name.length > MAX_NAME_LENGTH) return `name exceeds ${MAX_NAME_LENGTH} characters`;
  if (!/^[a-z0-9-]+$/.test(name)) return 'name must be lowercase a-z, 0-9, hyphens only';
  if (name.startsWith('-') || name.endsWith('-')) return 'name must not start or end with a hyphen';
  if (name.includes('--')) return 'name must not contain consecutive hyphens';
  return null;
}

export function getHeartbeatsDir(cwd: string): string {
  return join(getProjectStateDir(cwd), HEARTBEATS_DIR_NAME);
}

export function getHeartbeatPaths(cwd: string, name: string): HeartbeatPaths {
  const dir = getHeartbeatsDir(cwd);
  return {
    dir,
    config: join(dir, `${name}.json`),
    log: join(dir, `${name}.jsonl`),
  };
}

/**
 * Stable tag for this project + heartbeat pair. Used to identify the crontab
 * entry so we can list/update/remove it without touching other harnext
 * heartbeats on the same machine.
 */
export function getHeartbeatTag(cwd: string, name: string): string {
  const h = createHash('sha256').update(cwd).digest('hex').slice(0, 10);
  return `harnext:heartbeat:${h}:${name}`;
}

export function loadHeartbeatConfig(cwd: string, name: string): HeartbeatConfig | null {
  const { config } = getHeartbeatPaths(cwd, name);
  if (!existsSync(config)) return null;
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf-8')) as HeartbeatConfig;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.intervalMinutes !== 'number' ||
      typeof parsed.prompt !== 'string' ||
      typeof parsed.cwd !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** All heartbeat configs for this project, sorted by name. */
export function listHeartbeats(cwd: string): HeartbeatConfig[] {
  const dir = getHeartbeatsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: HeartbeatConfig[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    const cfg = loadHeartbeatConfig(cwd, name);
    if (cfg) out.push(cfg);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function saveHeartbeatConfig(cfg: HeartbeatConfig): void {
  const err = validateHeartbeatName(cfg.name);
  if (err) throw new Error(`invalid heartbeat name: ${err}`);
  const { dir, config } = getHeartbeatPaths(cfg.cwd, cfg.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

export function deleteHeartbeatConfig(cwd: string, name: string): boolean {
  const { config } = getHeartbeatPaths(cwd, name);
  if (!existsSync(config)) return false;
  try {
    unlinkSync(config);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the cron expression for a given interval. We intentionally only
 * support minute-resolution intervals that divide 60, or multiples of hours,
 * so the semantics ("every N minutes") hold across hour boundaries.
 */
export function buildCronSchedule(intervalMinutes: number): string {
  if (intervalMinutes < 60) {
    if (60 % intervalMinutes !== 0) {
      throw new Error(`intervalMinutes ${intervalMinutes} must divide 60 (or be a multiple of 60)`);
    }
    return `*/${intervalMinutes} * * * *`;
  }
  if (intervalMinutes % 60 !== 0) {
    throw new Error(`intervalMinutes ${intervalMinutes} >= 60 must be a multiple of 60`);
  }
  const hours = intervalMinutes / 60;
  if (24 % hours !== 0 && hours !== 24) {
    throw new Error(`interval ${hours}h must divide 24 (or equal 24)`);
  }
  return hours === 24 ? '0 0 * * *' : `0 */${hours} * * *`;
}

export interface CronLineOptions {
  schedule: string;
  cliPath: string;
  cwd: string;
  name: string;
  tag: string;
  nodePath?: string;
  /** PATH value to inject so the tick can find user-installed binaries (e.g. `gh`). */
  path?: string;
  /**
   * SSH_AUTH_SOCK from the installing shell. Propagated so heartbeats that
   * shell out to git over SSH can authenticate without a TTY.
   */
  sshAuthSock?: string;
}

/**
 * Build a single crontab line. Stderr/stdout are captured to the heartbeat's
 * JSONL log so a crashed boot leaves a trail alongside successful ticks.
 */
export function buildCronLine(opts: CronLineOptions): string {
  const node = opts.nodePath ?? 'node';
  const logPath = getHeartbeatPaths(opts.cwd, opts.name).log;
  const pathPrefix = opts.path ? `PATH=${shellQuote(opts.path)} ` : '';
  const sshPrefix = opts.sshAuthSock
    ? `SSH_AUTH_SOCK=${shellQuote(opts.sshAuthSock)} `
    : '';
  const cmd =
    `cd ${shellQuote(opts.cwd)} && ` +
    `${pathPrefix}${sshPrefix}${shellQuote(node)} ${shellQuote(opts.cliPath)} --heartbeat ${shellQuote(opts.name)} ` +
    `>> ${shellQuote(logPath)} 2>&1`;
  return `${opts.schedule} ${cmd} # ${opts.tag}`;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CrontabIO {
  read: () => string;
  write: (contents: string) => void;
}

function defaultCrontabIO(): CrontabIO {
  return {
    read: () => {
      try {
        return execSync('crontab -l', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        return '';
      }
    },
    write: (contents: string) => {
      execSync('crontab -', {
        input: contents,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
    },
  };
}

/**
 * Install or replace the heartbeat line for `tag` in the user's crontab.
 * Idempotent: at most one line per tag after the call. Returns true if the
 * crontab was changed, false if it already matched.
 */
export function installCronLine(line: string, tag: string, io: CrontabIO = defaultCrontabIO()): boolean {
  const current = io.read();
  const filtered = stripTag(current, tag);
  const next = (filtered.length > 0 && !filtered.endsWith('\n') ? filtered + '\n' : filtered) + line + '\n';
  if (next === current) return false;
  io.write(next);
  return true;
}

export function removeCronLine(tag: string, io: CrontabIO = defaultCrontabIO()): boolean {
  const current = io.read();
  const filtered = stripTag(current, tag);
  if (filtered === current) return false;
  io.write(filtered);
  return true;
}

export function findCronLine(tag: string, io: CrontabIO = defaultCrontabIO()): string | null {
  const current = io.read();
  for (const line of current.split('\n')) {
    if (line.includes(`# ${tag}`)) return line;
  }
  return null;
}

function stripTag(contents: string, tag: string): string {
  const marker = `# ${tag}`;
  const kept = contents.split('\n').filter((line) => !line.includes(marker));
  let out = kept.join('\n');
  if (contents.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  return out;
}

export interface HeartbeatTickRecord {
  ts: string;
  exit: number;
  durationMs: number;
  prompt: string;
  output: string;
  error?: string;
}

export function appendHeartbeatTick(
  cwd: string,
  name: string,
  record: HeartbeatTickRecord,
): void {
  const { dir, log } = getHeartbeatPaths(cwd, name);
  mkdirSync(dir, { recursive: true });
  appendFileSync(log, JSON.stringify(record) + '\n', 'utf-8');
}

