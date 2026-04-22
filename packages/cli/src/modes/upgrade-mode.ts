/**
 * `harnext upgrade` — install the latest published `harnext` from npm.
 *
 * Reads the running CLI's version, queries the npm registry's `latest`
 * dist-tag, and (when an upgrade is warranted) shells out to
 * `npm install -g harnext@latest`. The actual install is delegated to npm
 * so the user's existing global prefix, registry, and auth settings are
 * respected without duplication.
 */

import { spawn } from 'node:child_process';

import chalk from 'chalk';

import { VERSION } from '@harnext/core';

const REGISTRY_URL = 'https://registry.npmjs.org/harnext/latest';
const PACKAGE_NAME = 'harnext';

export interface UpgradeModeOptions {
  /** Print the comparison only — do not actually run npm install. */
  check?: boolean;
  /** Reinstall even when the running version already matches the latest. */
  force?: boolean;
}

/**
 * Compare two semver-ish version strings. Returns 1 if `a > b`, -1 if
 * `a < b`, 0 if equal. Pre-release suffixes (`-rc.1` etc.) are compared
 * as ASCII strings, which is good enough for the upgrade-vs-no-upgrade
 * decision; we don't need full semver precedence rules here.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const dash = v.indexOf('-');
    const core = dash >= 0 ? v.slice(0, dash) : v;
    const pre = dash >= 0 ? v.slice(dash + 1) : '';
    const nums = core.split('.').map((p) => Number.parseInt(p, 10) || 0);
    return { nums, pre };
  };

  const A = split(a);
  const B = split(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const av = A.nums[i] ?? 0;
    const bv = B.nums[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  // Equal cores: a release (no pre) outranks any pre-release of the same core.
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1;
  if (B.pre === '') return -1;
  return A.pre > B.pre ? 1 : -1;
}

interface FetchOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the current `latest` dist-tag of `harnext` on the npm registry.
 * Throws on network or HTTP failures so the caller can surface the error.
 */
export async function fetchLatestVersion(opts: FetchOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(REGISTRY_URL, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`registry returned HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { version?: unknown };
  if (typeof data.version !== 'string' || data.version.length === 0) {
    throw new Error('registry response is missing a version field');
  }
  return data.version;
}

interface NpmRunner {
  /** Resolve to the npm exit code. */
  run(target: string): Promise<number>;
}

const defaultNpmRunner: NpmRunner = {
  run(target) {
    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '-g', target], {
        stdio: 'inherit',
        env: process.env,
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  },
};

export interface UpgradeModeDeps {
  fetchLatest?: () => Promise<string>;
  npm?: NpmRunner;
  /** Output sink (defaults to console). Tests inject a buffer. */
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  /** Override of the running version (defaults to the bundled VERSION). */
  currentVersion?: string;
}

export async function runUpgradeMode(
  options: UpgradeModeOptions = {},
  deps: UpgradeModeDeps = {},
): Promise<number> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const errLog = deps.errLog ?? ((s: string) => console.error(s));
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const npm = deps.npm ?? defaultNpmRunner;
  const current = deps.currentVersion ?? VERSION;

  log(`Current version: ${chalk.cyan(current)}`);

  let latest: string;
  try {
    latest = await fetchLatest();
  } catch (err) {
    errLog(
      chalk.red(
        `Could not check the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return 1;
  }

  log(`Latest on npm:   ${chalk.cyan(latest)}`);

  const cmp = compareVersions(latest, current);

  if (cmp === 0 && !options.force) {
    log(chalk.green(`✓ Already on the latest version.`));
    return 0;
  }

  if (cmp < 0 && !options.force) {
    log(
      chalk.yellow(
        `Your version (${current}) is ahead of npm latest (${latest}) — likely installed from source.`,
      ),
    );
    log(chalk.dim(`Re-run with --force to downgrade to the published version.`));
    return 0;
  }

  if (options.check) {
    log(
      cmp > 0
        ? chalk.yellow(`An upgrade is available: ${current} → ${latest}`)
        : chalk.dim('No upgrade needed.'),
    );
    return 0;
  }

  const target = `${PACKAGE_NAME}@${latest}`;
  log(
    cmp > 0
      ? `Upgrading ${chalk.cyan(current)} → ${chalk.cyan(latest)}…`
      : `Reinstalling ${chalk.cyan(target)}…`,
  );

  const exit = await npm.run(target);
  if (exit !== 0) {
    errLog(
      chalk.red(
        `npm install exited with code ${exit}. If this is a permissions error, ` +
          `check 'npm config get prefix' and ensure its bin directory is writable.`,
      ),
    );
    return exit;
  }

  log(chalk.green(`✓ Installed ${target}.`));
  return 0;
}
