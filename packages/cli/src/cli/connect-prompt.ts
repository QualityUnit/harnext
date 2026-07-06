/**
 * `harnext connect` — link this machine to a context engine so the harness can
 * push its conversations. Runs the OAuth 2.0 device flow: request a code, show
 * the user the verification URL, poll until they approve it in the dashboard,
 * then store the tokens and enable cloud sync.
 */

import { createInterface } from 'node:readline';

import {
  discoverEngine,
  DEFAULT_ENDPOINT,
  loadSettings,
  pollForToken,
  requestDeviceCode,
  saveCloudTokens,
  setCloudSyncSettings,
  CloudAuthError,
} from '@harnext/core';
import chalk from 'chalk';

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Tidy whatever the user typed into a usable origin: default the scheme to https
 * and drop any trailing slash. The actual API base (root vs. a `/api` prefix) is
 * resolved later by probing the engine, so this stays minimal and predictable.
 */
export function normalizeEndpoint(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export interface ConnectOptions {
  cwd: string;
  /** Endpoint from `--endpoint`; falls back to settings, then a prompt. */
  endpoint?: string;
}

export async function runConnectCommand(opts: ConnectOptions): Promise<number> {
  const configured = loadSettings(opts.cwd).cloudSync.endpoint;
  let origin = normalizeEndpoint(opts.endpoint ?? configured ?? '');
  if (!origin) {
    const entered = await readLine(chalk.cyan(`  Context engine URL [${DEFAULT_ENDPOINT}]: `));
    origin = normalizeEndpoint(entered || DEFAULT_ENDPOINT);
  }
  if (!origin) {
    console.error(chalk.red('  A context engine URL is required.'));
    return 1;
  }

  console.log();
  console.log(chalk.dim(`  Connecting to ${origin} …`));

  try {
    // Probe to find where the ingest API lives (root for local `make ingest`,
    // `/api` for the path-routed hosted engine). All token storage + later pushes
    // use this resolved base, not the bare origin the user typed.
    const { apiBase, clientId } = await discoverEngine(origin);
    const device = await requestDeviceCode(apiBase, clientId);

    console.log();
    console.log('  Open this URL and approve the request:');
    console.log('    ' + chalk.cyan(device.verification_uri_complete));
    console.log('  If prompted, your code is: ' + chalk.bold(device.user_code));
    console.log();
    console.log(chalk.dim('  Waiting for approval…'));

    const token = await pollForToken(apiBase, clientId, device.device_code, {
      intervalSeconds: device.interval,
      expiresInSeconds: device.expires_in,
    });

    saveCloudTokens({
      endpoint: apiBase,
      clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAt: Date.now() + token.expires_in * 1000,
    });
    setCloudSyncSettings({ enabled: true, endpoint: apiBase });

    console.log();
    console.log(chalk.green('  ✓ Connected.') + ' Conversations will now be pushed to the context engine.');
    console.log(chalk.dim('  Disable any time with `harnext connect --disable`.'));
    return 0;
  } catch (err) {
    const msg = err instanceof CloudAuthError ? err.message : String(err);
    console.error();
    console.error(chalk.red('  Connection failed: ') + msg);
    return 1;
  }
}

/** `harnext connect --disable` — turn cloud sync off without forgetting the URL. */
export function runDisconnectCommand(): number {
  setCloudSyncSettings({ enabled: false });
  console.log(chalk.dim('  Cloud sync disabled. Stored login kept; re-enable with `harnext connect`.'));
  return 0;
}
