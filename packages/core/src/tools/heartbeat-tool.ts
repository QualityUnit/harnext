/**
 * The `heartbeat` tool: the agent's affordance for managing this project's
 * durable, cron-driven heartbeats — the same ones the `/heartbeat` CLI command
 * configures. A small set of commands (`list`, `create`, `update`, `delete`,
 * `view_log`) over the per-project heartbeat store and the user's crontab.
 *
 * Unlike `loop` (session-bound, dies with the session), a heartbeat survives the
 * CLI closing: each tick spawns a fresh headless agent run from cron. Creating or
 * updating one therefore writes a line into the user's crontab.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

import {
  HEARTBEAT_INTERVAL_PRESETS,
  buildCronLine,
  buildCronSchedule,
  deleteHeartbeatConfig,
  findCronLine,
  getHeartbeatPaths,
  getHeartbeatTag,
  installCronLine,
  listHeartbeats,
  loadHeartbeatConfig,
  removeCronLine,
  saveHeartbeatConfig,
  validateHeartbeatName,
  type CrontabIO,
  type HeartbeatConfig,
  type HeartbeatIntervalMinutes,
} from '../heartbeat.js';

const heartbeatSchema = Type.Object({
  command: Type.Union(
    [
      Type.Literal('list'),
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('delete'),
      Type.Literal('view_log'),
    ],
    {
      description:
        'list: show this project’s heartbeats. create: add a new one (installs a cron entry). ' +
        'update: change an existing one’s interval and/or prompt. delete: remove it and its cron entry. ' +
        'view_log: show recent tick records.',
    },
  ),
  name: Type.Optional(
    Type.String({
      description:
        'Heartbeat name (lowercase a-z, 0-9, hyphens; max 32). Required for create/update/delete/view_log.',
    }),
  ),
  interval_minutes: Type.Optional(
    Type.Number({
      description:
        'Minutes between ticks. Must be one of: 1, 3, 5, 15, 30, 60, 120, 360, 720, 1440. ' +
        'Required for create; optional for update.',
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: 'The instruction the agent runs each tick. Required for create; optional for update.',
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'For view_log: how many of the most recent ticks to show (default 10).' }),
  ),
});

export type HeartbeatToolInput = Static<typeof heartbeatSchema>;

export interface HeartbeatToolDetails {
  command: string;
  name?: string;
  ok: boolean;
}

export interface CreateHeartbeatToolOptions {
  /** Absolute path to the harnext CLI entrypoint baked into cron lines. Defaults to process.argv[1]. */
  cliPath?: string;
  /** Absolute path to the node binary baked into cron lines. Defaults to process.execPath. */
  nodePath?: string;
  /** Injected crontab reader/writer (tests pass a fake). Defaults to the real `crontab` shell I/O. */
  crontabIO?: CrontabIO;
}

function ok(text: string, command: string, name?: string) {
  return { content: [{ type: 'text' as const, text }], details: { command, name, ok: true } };
}
function fail(text: string, command: string, name?: string) {
  return { content: [{ type: 'text' as const, text }], details: { command, name, ok: false } };
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes === 60) return 'hourly';
  if (minutes < 1440) return `every ${minutes / 60}h`;
  return 'daily';
}

/**
 * Install (or replace) the cron entry + config for a heartbeat. Mirrors the
 * CLI's install flow: PATH and SSH_AUTH_SOCK are propagated so a tick can find
 * user binaries and authenticate git-over-SSH without a TTY.
 */
function install(
  cwd: string,
  draft: { name: string; intervalMinutes: HeartbeatIntervalMinutes; prompt: string },
  opts: Required<Pick<CreateHeartbeatToolOptions, 'cliPath' | 'nodePath'>> & { crontabIO?: CrontabIO },
): string {
  const schedule = buildCronSchedule(draft.intervalMinutes);
  const tag = getHeartbeatTag(cwd, draft.name);
  const cronLine = buildCronLine({
    schedule,
    cliPath: opts.cliPath,
    cwd,
    name: draft.name,
    tag,
    nodePath: opts.nodePath,
    path: process.env.PATH,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  });
  const cfg: HeartbeatConfig = {
    name: draft.name,
    intervalMinutes: draft.intervalMinutes,
    prompt: draft.prompt,
    cwd,
    updatedAt: Date.now(),
  };
  saveHeartbeatConfig(cfg);
  installCronLine(cronLine, tag, opts.crontabIO);
  return cronLine;
}

export function createHeartbeatTool(
  cwd: string,
  options: CreateHeartbeatToolOptions = {},
): AgentTool<typeof heartbeatSchema, HeartbeatToolDetails> {
  const cliPath = options.cliPath ?? process.argv[1] ?? '';
  const nodePath = options.nodePath ?? process.execPath;
  const crontabIO = options.crontabIO;

  return {
    name: 'heartbeat',
    label: 'heartbeat',
    description:
      'Manage this project’s durable, cron-driven heartbeats — periodic headless agent runs that ' +
      'keep going after the CLI is closed. Commands: list, create, update, delete, view_log. ' +
      'For an in-session loop that you can watch live and that ends with the session, use `loop` instead.',
    parameters: heartbeatSchema,
    async execute(_toolCallId, params) {
      const { command } = params;
      try {
        switch (command) {
          case 'list': {
            const all = listHeartbeats(cwd);
            if (all.length === 0) return ok('No heartbeats configured for this project.', command);
            const lines = all.map((c) => {
              const installed = findCronLine(getHeartbeatTag(c.cwd, c.name), crontabIO)
                ? 'cron installed'
                : 'cron MISSING';
              return `- ${c.name} · ${formatInterval(c.intervalMinutes)} · ${installed}\n    ${c.prompt}`;
            });
            return ok(`Heartbeats (${all.length}):\n${lines.join('\n')}`, command);
          }

          case 'create': {
            const name = params.name?.trim();
            if (!name) return fail('Error: create requires a name.', command);
            const nameErr = validateHeartbeatName(name);
            if (nameErr) return fail(`Error: ${nameErr}`, command, name);
            if (loadHeartbeatConfig(cwd, name))
              return fail(`Error: heartbeat "${name}" already exists — use update.`, command, name);
            if (params.interval_minutes == null)
              return fail('Error: create requires interval_minutes.', command, name);
            if (!HEARTBEAT_INTERVAL_PRESETS.includes(params.interval_minutes as HeartbeatIntervalMinutes))
              return fail(
                `Error: interval_minutes must be one of ${HEARTBEAT_INTERVAL_PRESETS.join(', ')}.`,
                command,
                name,
              );
            const prompt = params.prompt?.trim();
            if (!prompt) return fail('Error: create requires a prompt.', command, name);
            const cronLine = install(
              cwd,
              { name, intervalMinutes: params.interval_minutes as HeartbeatIntervalMinutes, prompt },
              { cliPath, nodePath, crontabIO },
            );
            return ok(
              `Created heartbeat "${name}" (${formatInterval(params.interval_minutes)}).\n` +
                `Installed cron: ${cronLine}`,
              command,
              name,
            );
          }

          case 'update': {
            const name = params.name?.trim();
            if (!name) return fail('Error: update requires a name.', command);
            const existing = loadHeartbeatConfig(cwd, name);
            if (!existing) return fail(`Error: heartbeat "${name}" not found.`, command, name);
            const intervalMinutes =
              params.interval_minutes == null
                ? existing.intervalMinutes
                : (params.interval_minutes as HeartbeatIntervalMinutes);
            if (!HEARTBEAT_INTERVAL_PRESETS.includes(intervalMinutes))
              return fail(
                `Error: interval_minutes must be one of ${HEARTBEAT_INTERVAL_PRESETS.join(', ')}.`,
                command,
                name,
              );
            const prompt = params.prompt?.trim() || existing.prompt;
            const cronLine = install(cwd, { name, intervalMinutes, prompt }, { cliPath, nodePath, crontabIO });
            return ok(
              `Updated heartbeat "${name}" (${formatInterval(intervalMinutes)}).\nCron: ${cronLine}`,
              command,
              name,
            );
          }

          case 'delete': {
            const name = params.name?.trim();
            if (!name) return fail('Error: delete requires a name.', command);
            if (!loadHeartbeatConfig(cwd, name))
              return fail(`Error: heartbeat "${name}" not found.`, command, name);
            removeCronLine(getHeartbeatTag(cwd, name), crontabIO);
            deleteHeartbeatConfig(cwd, name);
            return ok(`Deleted heartbeat "${name}" and removed its cron entry.`, command, name);
          }

          case 'view_log': {
            const name = params.name?.trim();
            if (!name) return fail('Error: view_log requires a name.', command);
            const { log } = getHeartbeatPaths(cwd, name);
            if (!existsSync(log)) return ok(`No ticks logged yet for "${name}".`, command, name);
            const limit = Math.max(1, Math.min(params.limit ?? 10, 100));
            const lines = readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).slice(-limit);
            const rendered = lines.map((raw) => {
              try {
                const r = JSON.parse(raw) as {
                  ts: string;
                  exit: number;
                  durationMs: number;
                  output?: string;
                  error?: string;
                };
                const status = r.exit === 0 ? 'ok' : r.exit === 2 ? 'tool-err' : 'fail';
                const summary = (r.error ?? r.output ?? '').split('\n')[0]?.slice(0, 100) ?? '';
                return `${r.ts}  ${status}  ${r.durationMs}ms  ${summary}`;
              } catch {
                return raw;
              }
            });
            return ok(`Last ${rendered.length} ticks for "${name}":\n${rendered.join('\n')}`, command, name);
          }

          default:
            return fail(`Error: unknown command "${command as string}".`, command);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return fail(`Error (${command}): ${msg}`, command, params.name);
      }
    },
  };
}

export const heartbeatTool = createHeartbeatTool(process.cwd());
