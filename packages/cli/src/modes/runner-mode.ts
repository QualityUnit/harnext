/**
 * `harnext runner <verb>` — read-only inspection of the project's self-hosted
 * runner. Supports `status` (metadata + daemon + GitHub-side state) and
 * `logs` (tail the runner's own diag log). These commands never start, stop,
 * or reconfigure the runner — that's `harnext setup`'s job.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';
import { basename, join } from 'node:path';

import chalk from 'chalk';

import { getRemoteRunnerStatus, tryLoadRunnerMetadata } from '@harnext/core';

import { printRunnerHelp, type RunnerVerb } from '../cli/args.js';

export interface RunnerModeOptions {
  cwd: string;
  verb?: RunnerVerb;
  logLines?: number;
  logNoFollow?: boolean;
}

export async function runRunnerMode(options: RunnerModeOptions): Promise<number> {
  if (!options.verb) {
    console.error(chalk.red('Error: missing verb. Try `harnext runner status` or `harnext runner logs`.'));
    printRunnerHelp();
    return 1;
  }
  if (options.verb === 'status') {
    return runStatus(options.cwd);
  }
  if (options.verb === 'logs') {
    return await runLogs(options.cwd, options.logLines ?? 50, options.logNoFollow !== true);
  }
  console.error(chalk.red(`Error: unknown runner verb "${options.verb}".`));
  printRunnerHelp();
  return 1;
}

function runStatus(cwd: string): number {
  const meta = tryLoadRunnerMetadata(cwd);
  if (!meta) {
    console.log(chalk.yellow('No self-hosted runner is registered for this project.'));
    console.log(
      chalk.dim(
        '  Run `harnext setup` and pick "self-hosted" for at least one stage to register one.',
      ),
    );
    return 0;
  }

  console.log(chalk.bold('Registration'));
  console.log(`  ${chalk.dim('runner name:')}   ${meta.runnerName}`);
  console.log(`  ${chalk.dim('repo:')}          ${meta.repo}`);
  console.log(`  ${chalk.dim('install dir:')}   ${meta.installDir}`);
  console.log(`  ${chalk.dim('labels:')}        ${meta.labels.join(', ')}`);
  console.log(`  ${chalk.dim('registered at:')} ${meta.registeredAt}`);
  console.log();

  console.log(chalk.bold('Daemon'));
  if (!meta.serviceInstalled) {
    console.log(`  ${chalk.yellow('not installed as a service')}`);
    console.log(
      chalk.dim('  (the runner only runs when something invokes ./run.sh from the install dir)'),
    );
  } else {
    const localStatus = readLocalServiceStatus(meta.installDir);
    if (!localStatus) {
      console.log(`  ${chalk.dim('service installed, status unavailable on this platform')}`);
    } else if (localStatus.error) {
      console.log(`  ${chalk.yellow(localStatus.error)}`);
    } else {
      console.log(`  ${chalk.dim('unit:')}         ${localStatus.unit}`);
      const stateLine =
        localStatus.active === 'active'
          ? chalk.green(`● ${localStatus.active}${localStatus.sub ? ` (${localStatus.sub})` : ''}`)
          : chalk.yellow(`○ ${localStatus.active ?? 'unknown'}${localStatus.sub ? ` (${localStatus.sub})` : ''}`);
      console.log(`  ${chalk.dim('state:')}        ${stateLine}`);
      if (localStatus.pid) console.log(`  ${chalk.dim('pid:')}          ${localStatus.pid}`);
    }
  }
  console.log();

  console.log(chalk.bold('GitHub'));
  const remote = getRemoteRunnerStatus(meta);
  if (!remote.ok) {
    console.log(`  ${chalk.yellow(`could not query GitHub: ${remote.message}`)}`);
  } else if (!remote.value.registeredOnGithub) {
    console.log(`  ${chalk.yellow('not visible on GitHub for this repo')}`);
    console.log(
      chalk.dim(
        '  (the registration token may have been revoked, or the repo no longer lists this runner)',
      ),
    );
  } else {
    const onlineLine = remote.value.online
      ? chalk.green('● online')
      : chalk.yellow('○ offline');
    const busyLine = remote.value.busy ? chalk.cyan(' (busy)') : '';
    console.log(`  ${chalk.dim('state:')}        ${onlineLine}${busyLine}`);
  }
  console.log();

  console.log(chalk.bold('Diag log'));
  const latest = findLatestRunnerLog(meta.installDir);
  if (!latest) {
    console.log(`  ${chalk.dim('no Runner_*.log yet — runner has not started')}`);
  } else {
    console.log(`  ${chalk.dim('file:')}         ${latest.path}`);
    console.log(`  ${chalk.dim('last write:')}   ${latest.mtime.toISOString()}`);
    console.log(chalk.dim('  (tail with `harnext runner logs`)'));
  }

  return 0;
}

async function runLogs(cwd: string, lines: number, follow: boolean): Promise<number> {
  const meta = tryLoadRunnerMetadata(cwd);
  if (!meta) {
    console.error(chalk.red('No self-hosted runner is registered for this project.'));
    console.error(chalk.dim('  Run `harnext setup` to register one.'));
    return 1;
  }
  const latest = findLatestRunnerLog(meta.installDir);
  if (!latest) {
    console.error(chalk.red(`No Runner_*.log found under ${join(meta.installDir, '_diag')}.`));
    console.error(chalk.dim('  The runner has never started; check `harnext runner status`.'));
    return 1;
  }

  console.log(chalk.dim(`tailing ${latest.path}${follow ? ' (Ctrl-C to stop)' : ''}\n`));
  const args = ['-n', String(lines)];
  if (follow) args.push('-F'); // -F follows by name; survives log rotation
  args.push(latest.path);
  return await new Promise<number>((resolve) => {
    const proc = spawn('tail', args, { stdio: 'inherit' });
    proc.on('exit', (code, signal) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') resolve(0);
      else resolve(code ?? 0);
    });
    proc.on('error', (err) => {
      console.error(chalk.red(`failed to spawn tail: ${err.message}`));
      resolve(1);
    });
  });
}

interface LocalServiceStatus {
  unit?: string;
  active?: string;
  sub?: string;
  pid?: string;
  error?: string;
}

/**
 * Read the unit/label that `svc.sh install` recorded at <installDir>/.service
 * and ask the platform's service manager for its current state. Returns
 * undefined when we don't know how to query the platform; populates `error`
 * when we tried but failed.
 */
function readLocalServiceStatus(installDir: string): LocalServiceStatus | undefined {
  const markerPath = join(installDir, '.service');
  let marker = '';
  if (existsSync(markerPath)) {
    try {
      marker = readFileSync(markerPath, 'utf-8').trim();
    } catch {
      // Fall through; we'll report the error below.
    }
  }

  const plat = osPlatform();
  if (plat === 'linux') {
    if (!marker) {
      return { error: 'service installed but <installDir>/.service is missing — cannot resolve the systemd unit name' };
    }
    const unit = marker.endsWith('.service') ? marker : `${marker}.service`;
    const show = trySystemctlShow(unit);
    if (!show) {
      return { unit, error: `systemctl show ${unit} failed (try \`systemctl status ${unit}\`)` };
    }
    return { unit, ...show };
  }

  if (plat === 'darwin') {
    if (!marker) {
      return { error: 'service installed but <installDir>/.service is missing — cannot resolve the launchd label' };
    }
    const label = basename(marker).replace(/\.plist$/, '');
    const list = tryLaunchctlList(label);
    if (!list) {
      return { unit: label, error: `launchctl list ${label} returned nothing — service may not be loaded` };
    }
    return { unit: label, ...list };
  }

  return undefined;
}

function trySystemctlShow(unit: string): { active?: string; sub?: string; pid?: string } | undefined {
  try {
    const out = execFileSync(
      'systemctl',
      ['show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const fields: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
    }
    return {
      active: fields.ActiveState,
      sub: fields.SubState,
      pid: fields.MainPID && fields.MainPID !== '0' ? fields.MainPID : undefined,
    };
  } catch {
    return undefined;
  }
}

function tryLaunchctlList(label: string): { active?: string; pid?: string } | undefined {
  try {
    const out = execFileSync('launchctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const cols = line.split('\t');
      if (cols.length < 3) continue;
      if (cols[2] !== label) continue;
      const pid = cols[0];
      return {
        active: pid && pid !== '-' ? 'active' : 'inactive',
        pid: pid && pid !== '-' ? pid : undefined,
      };
    }
    return { active: 'inactive' };
  } catch {
    return undefined;
  }
}

function findLatestRunnerLog(installDir: string): { path: string; mtime: Date } | undefined {
  const diagDir = join(installDir, '_diag');
  if (!existsSync(diagDir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(diagDir);
  } catch {
    return undefined;
  }
  // The runner names files Runner_YYYYMMDD-HHMMSS-utc.log, so a descending
  // lexicographic sort puts the newest first regardless of mtime resolution.
  const candidates = entries
    .filter((n) => n.startsWith('Runner_') && n.endsWith('.log'))
    .sort()
    .reverse();
  for (const name of candidates) {
    const path = join(diagDir, name);
    try {
      const st = statSync(path);
      return { path, mtime: st.mtime };
    } catch {
      // skip and try the next candidate
    }
  }
  return undefined;
}
