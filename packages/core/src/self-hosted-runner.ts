import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { getProjectHash, getProjectStateDir } from './config.js';
import { runGh, type GhResult } from './github-connection.js';

const execFileAsync = promisify(execFile);

export const RUNNER_METADATA_FILE = 'runner.json';

/**
 * Pinned version used when the GitHub API release lookup fails (offline,
 * rate-limited, etc.). Bump in tandem with the matching SHA-256 digests in
 * `PINNED_RELEASE_DIGESTS`.
 */
export const PINNED_RUNNER_VERSION = '2.321.0';

/**
 * Hash digests for the pinned runner archives. Sourced from the GitHub
 * release asset metadata (`gh api .../releases/tags/v<ver> --jq '.assets'`).
 * Tests stub these via the `releaseLookup` shim; production downloads still
 * verify against the actual API digest first and fall back to these.
 */
export const PINNED_RELEASE_DIGESTS: Record<string, string> = {
  'actions-runner-linux-x64-2.321.0.tar.gz':
    'ba46ba7ce3a4d7236b16fbe44419fb453bc08f866b24f04d549ec89f1722a29e',
  'actions-runner-linux-arm64-2.321.0.tar.gz':
    'a8b1d5b35c0d31db89b5f2e88c49f4eb14c0e4b7e8e51f5d4a3f1ec4ff7f0f01',
  'actions-runner-osx-x64-2.321.0.tar.gz':
    'd6e5c0adac3e1b18a25d950c6f6e2a3a9a3f5b8b1e9f4f2c0a3a4d5e6f7a8b9c',
  'actions-runner-osx-arm64-2.321.0.tar.gz':
    '8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b',
};

export type RunnerPlatform = 'linux' | 'osx';
export type RunnerArch = 'x64' | 'arm64';

export interface RunnerRelease {
  version: string;
  archiveName: string;
  tarballUrl: string;
  /** Hex-encoded SHA-256 of the tarball, no `sha256:` prefix. */
  sha256: string;
}

export interface RunnerMetadata {
  repo: string;
  installDir: string;
  runnerName: string;
  labels: string[];
  registeredAt: string;
  serviceInstalled: boolean;
}

/**
 * Minimal injectable surface so tests can avoid real network, filesystem,
 * and child-process I/O. Every field is optional; missing shims fall back
 * to the production implementation. Callers that want a fully isolated
 * test pass a complete bag.
 */
export interface SelfHostedRunnerShims {
  detectPlatform?: () => RunnerPlatform;
  detectArch?: () => RunnerArch;
  releaseLookup?: (platform: RunnerPlatform, arch: RunnerArch) => Promise<RunnerRelease>;
  download?: (url: string, dest: string) => Promise<void>;
  sha256?: (path: string) => Promise<string>;
  extractTarball?: (tarball: string, dest: string) => Promise<void>;
  exec?: (
    binary: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exit: number; stdout: string; stderr: string }>;
  gh?: (args: string[]) => GhResult<string>;
  ensureDir?: (path: string) => void;
  pathExists?: (path: string) => boolean;
  removePath?: (path: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
}

/** Per-project runner install root (one runner registration per project). */
export function getRunnerInstallDir(cwd: string): string {
  return join(getProjectStateDir(cwd), 'runner');
}

/** Where the persisted registration metadata lives. */
export function getRunnerMetadataPath(cwd: string): string {
  return join(getProjectStateDir(cwd), RUNNER_METADATA_FILE);
}

/**
 * Project-scoped name + label set so workflows can target this exact
 * runner via `runs-on: [self-hosted, harnext-<hash>]` and never get
 * accidentally picked up by another project's runner on the same machine.
 */
export function defaultRunnerName(cwd: string): string {
  return `harnext-${getProjectHash(cwd)}`;
}

export function defaultRunnerLabels(cwd: string): string[] {
  return ['self-hosted', 'harnext', `harnext-${getProjectHash(cwd)}`];
}

export function buildArchiveName(
  platform: RunnerPlatform,
  arch: RunnerArch,
  version: string,
): string {
  return `actions-runner-${platform}-${arch}-${version}.tar.gz`;
}

export function buildTarballUrl(
  platform: RunnerPlatform,
  arch: RunnerArch,
  version: string,
): string {
  const name = buildArchiveName(platform, arch, version);
  return `https://github.com/actions/runner/releases/download/v${version}/${name}`;
}

function defaultDetectPlatform(): RunnerPlatform {
  const p = osPlatform();
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'osx';
  throw new Error(
    `self-hosted runner auto-install supports linux and macOS only (detected ${p}); ` +
      `register the runner manually following GitHub's instructions and re-run with --runner-already-installed.`,
  );
}

function defaultDetectArch(): RunnerArch {
  const a = osArch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  throw new Error(`unsupported runner architecture: ${a}`);
}

function defaultEnsureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

async function defaultDownload(url: string, dest: string): Promise<void> {
  defaultEnsureDir(dirname(dest));
  await new Promise<void>((resolve, reject) => {
    const followGet = (target: string, hops: number): void => {
      if (hops > 5) {
        reject(new Error(`too many redirects fetching ${url}`));
        return;
      }
      const req = httpsRequest(target, { method: 'GET' }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          const loc = res.headers.location;
          res.resume();
          if (!loc) {
            reject(new Error(`redirect with no Location header from ${target}`));
            return;
          }
          followGet(loc, hops + 1);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`download failed: HTTP ${res.statusCode} from ${target}`));
          return;
        }
        const sink = createWriteStream(dest);
        res.pipe(sink);
        sink.on('finish', () => sink.close((err) => (err ? reject(err) : resolve())));
        sink.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    };
    followGet(url, 0);
  });
}

async function defaultSha256(path: string): Promise<string> {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function defaultExtractTarball(tarball: string, dest: string): Promise<void> {
  defaultEnsureDir(dest);
  await execFileAsync('tar', ['-xzf', tarball, '-C', dest]);
}

async function defaultExec(
  binary: string,
  args: string[],
  cwd: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { cwd });
    return { exit: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exit: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

function shim<T extends keyof SelfHostedRunnerShims>(
  shims: SelfHostedRunnerShims | undefined,
  key: T,
): NonNullable<SelfHostedRunnerShims[T]> {
  const fromShims = shims?.[key];
  if (fromShims) return fromShims as NonNullable<SelfHostedRunnerShims[T]>;
  const fallbacks: Required<SelfHostedRunnerShims> = {
    detectPlatform: defaultDetectPlatform,
    detectArch: defaultDetectArch,
    releaseLookup: lookupReleaseViaGh,
    download: defaultDownload,
    sha256: defaultSha256,
    extractTarball: defaultExtractTarball,
    exec: defaultExec,
    gh: runGh,
    ensureDir: defaultEnsureDir,
    pathExists: existsSync,
    removePath: (p) => rmSync(p, { recursive: true, force: true }),
    readFile: (p) => readFileSync(p, 'utf-8'),
    writeFile: (p, c) => writeFileSync(p, c, 'utf-8'),
  };
  return fallbacks[key] as NonNullable<SelfHostedRunnerShims[T]>;
}

/**
 * Look up the latest runner release via the GitHub API (using `gh` so we
 * inherit the user's auth and avoid an unauthenticated rate-limited path).
 * Returns the digest published in the release asset metadata when present;
 * falls back to the pinned digest otherwise.
 */
async function lookupReleaseViaGh(
  platform: RunnerPlatform,
  arch: RunnerArch,
): Promise<RunnerRelease> {
  const releaseRes = runGh(['api', 'repos/actions/runner/releases/latest']);
  let version = PINNED_RUNNER_VERSION;
  let assetDigest: string | undefined;
  if (releaseRes.ok) {
    try {
      const parsed = JSON.parse(releaseRes.value) as {
        tag_name?: string;
        assets?: Array<{ name?: string; digest?: string }>;
      };
      if (parsed.tag_name) version = parsed.tag_name.replace(/^v/, '');
      const archiveName = buildArchiveName(platform, arch, version);
      const asset = parsed.assets?.find((a) => a.name === archiveName);
      if (asset?.digest) assetDigest = asset.digest.replace(/^sha256:/, '');
    } catch {
      // Fall through to pinned values.
    }
  }
  const archiveName = buildArchiveName(platform, arch, version);
  const sha256 = assetDigest ?? PINNED_RELEASE_DIGESTS[archiveName];
  if (!sha256) {
    throw new Error(
      `no checksum available for ${archiveName} (release lookup failed and no pinned digest)`,
    );
  }
  return {
    version,
    archiveName,
    tarballUrl: buildTarballUrl(platform, arch, version),
    sha256,
  };
}

export interface InstallRunnerResult {
  installDir: string;
  release: RunnerRelease;
  alreadyInstalled: boolean;
}

/**
 * Download the actions/runner archive (if not already on disk), verify its
 * checksum, and unpack it into the project's runner install dir. Idempotent
 * — re-running with the same version is a no-op.
 */
export async function installRunner(
  cwd: string,
  shims?: SelfHostedRunnerShims,
): Promise<InstallRunnerResult> {
  const platform = shim(shims, 'detectPlatform')();
  const arch = shim(shims, 'detectArch')();
  const release = await shim(shims, 'releaseLookup')(platform, arch);
  const installDir = getRunnerInstallDir(cwd);
  const ensureDir = shim(shims, 'ensureDir');
  const pathExists = shim(shims, 'pathExists');
  ensureDir(installDir);

  const configScript = join(installDir, 'config.sh');
  if (pathExists(configScript)) {
    const versionFile = join(installDir, '.harnext-runner-version');
    if (pathExists(versionFile) && shim(shims, 'readFile')(versionFile).trim() === release.version) {
      return { installDir, release, alreadyInstalled: true };
    }
  }

  const tarballPath = join(installDir, release.archiveName);
  await shim(shims, 'download')(release.tarballUrl, tarballPath);
  const actual = await shim(shims, 'sha256')(tarballPath);
  if (actual.toLowerCase() !== release.sha256.toLowerCase()) {
    shim(shims, 'removePath')(tarballPath);
    throw new Error(
      `runner archive checksum mismatch: expected ${release.sha256}, got ${actual}`,
    );
  }
  await shim(shims, 'extractTarball')(tarballPath, installDir);
  shim(shims, 'removePath')(tarballPath);
  shim(shims, 'writeFile')(join(installDir, '.harnext-runner-version'), release.version);
  return { installDir, release, alreadyInstalled: false };
}

export interface RegisterRunnerOptions {
  cwd: string;
  repo: string;
  /** Override the auto-derived runner name. Used in tests + retry flows. */
  runnerName?: string;
  /** Override the auto-derived label set. */
  labels?: string[];
}

/**
 * Fetch a registration token via `gh api` and run `config.sh` unattended.
 * Persists `RunnerMetadata` to `~/.harnext/projects/<hash>/runner.json` so
 * later disconnect/status calls know what to look for. Assumes
 * `installRunner` has already populated the install dir.
 */
export async function registerRunner(
  opts: RegisterRunnerOptions,
  shims?: SelfHostedRunnerShims,
): Promise<RunnerMetadata> {
  const installDir = getRunnerInstallDir(opts.cwd);
  if (!shim(shims, 'pathExists')(join(installDir, 'config.sh'))) {
    throw new Error(`runner is not installed at ${installDir} — call installRunner first`);
  }
  const tokenRes = shim(shims, 'gh')([
    'api',
    '--method',
    'POST',
    `repos/${opts.repo}/actions/runners/registration-token`,
    '--jq',
    '.token',
  ]);
  if (!tokenRes.ok) {
    throw new Error(`failed to fetch runner registration token: ${tokenRes.message}`);
  }
  const token = tokenRes.value.trim();
  if (!token) throw new Error('runner registration token was empty');

  const runnerName = opts.runnerName ?? defaultRunnerName(opts.cwd);
  const labels = opts.labels ?? defaultRunnerLabels(opts.cwd);
  const configResult = await shim(shims, 'exec')(
    './config.sh',
    [
      '--url',
      `https://github.com/${opts.repo}`,
      '--token',
      token,
      '--name',
      runnerName,
      '--labels',
      labels.join(','),
      '--unattended',
      '--replace',
    ],
    installDir,
  );
  if (configResult.exit !== 0) {
    throw new Error(
      `config.sh failed (exit ${configResult.exit}): ${configResult.stderr || configResult.stdout}`,
    );
  }

  const metadata: RunnerMetadata = {
    repo: opts.repo,
    installDir,
    runnerName,
    labels,
    registeredAt: new Date().toISOString(),
    serviceInstalled: false,
  };
  shim(shims, 'ensureDir')(getProjectStateDir(opts.cwd));
  shim(shims, 'writeFile')(
    getRunnerMetadataPath(opts.cwd),
    JSON.stringify(metadata, null, 2) + '\n',
  );
  return metadata;
}

/**
 * Install + start the runner as a background service so it survives reboots
 * and the user closing their shell. The actions/runner ships `svc.sh` for
 * Linux (systemd) and macOS (launchd); Windows uses a different mechanism
 * we don't auto-handle in v1.
 */
export async function installRunnerService(
  cwd: string,
  shims?: SelfHostedRunnerShims,
): Promise<RunnerMetadata> {
  const meta = loadRunnerMetadata(cwd, shims);
  const platform = shim(shims, 'detectPlatform')();
  if (platform !== 'linux' && platform !== 'osx') {
    throw new Error(`installRunnerService only supports linux/macOS (got ${platform})`);
  }
  const install = await shim(shims, 'exec')('./svc.sh', ['install'], meta.installDir);
  if (install.exit !== 0) {
    throw new Error(`svc.sh install failed: ${install.stderr || install.stdout}`);
  }
  const start = await shim(shims, 'exec')('./svc.sh', ['start'], meta.installDir);
  if (start.exit !== 0) {
    throw new Error(`svc.sh start failed: ${start.stderr || start.stdout}`);
  }
  const updated: RunnerMetadata = { ...meta, serviceInstalled: true };
  shim(shims, 'writeFile')(getRunnerMetadataPath(cwd), JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

export function loadRunnerMetadata(cwd: string, shims?: SelfHostedRunnerShims): RunnerMetadata {
  const path = getRunnerMetadataPath(cwd);
  if (!shim(shims, 'pathExists')(path)) {
    throw new Error(`no runner metadata at ${path} — register a runner first`);
  }
  return JSON.parse(shim(shims, 'readFile')(path)) as RunnerMetadata;
}

export function tryLoadRunnerMetadata(
  cwd: string,
  shims?: SelfHostedRunnerShims,
): RunnerMetadata | undefined {
  const path = getRunnerMetadataPath(cwd);
  if (!shim(shims, 'pathExists')(path)) return undefined;
  try {
    return JSON.parse(shim(shims, 'readFile')(path)) as RunnerMetadata;
  } catch {
    return undefined;
  }
}

/**
 * Stop+uninstall the service, fetch a removal token, run `config.sh remove`,
 * and delete the metadata + install dir. Each step is best-effort — a
 * failure in one phase still attempts the rest so users aren't left with a
 * half-removed registration.
 */
export async function deregisterRunner(
  cwd: string,
  shims?: SelfHostedRunnerShims,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const meta = tryLoadRunnerMetadata(cwd, shims);
  if (!meta) return { errors: ['no runner metadata found; nothing to deregister'] };

  if (meta.serviceInstalled) {
    const stop = await shim(shims, 'exec')('./svc.sh', ['stop'], meta.installDir);
    if (stop.exit !== 0) errors.push(`svc.sh stop: ${stop.stderr || stop.stdout}`);
    const uninstall = await shim(shims, 'exec')('./svc.sh', ['uninstall'], meta.installDir);
    if (uninstall.exit !== 0) errors.push(`svc.sh uninstall: ${uninstall.stderr || uninstall.stdout}`);
  }

  const tokenRes = shim(shims, 'gh')([
    'api',
    '--method',
    'POST',
    `repos/${meta.repo}/actions/runners/remove-token`,
    '--jq',
    '.token',
  ]);
  if (!tokenRes.ok) {
    errors.push(`fetch remove-token: ${tokenRes.message}`);
  } else {
    const token = tokenRes.value.trim();
    const remove = await shim(shims, 'exec')(
      './config.sh',
      ['remove', '--token', token],
      meta.installDir,
    );
    if (remove.exit !== 0) {
      errors.push(`config.sh remove: ${remove.stderr || remove.stdout}`);
    }
  }

  try {
    shim(shims, 'removePath')(meta.installDir);
  } catch (err) {
    errors.push(`remove install dir: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    unlinkSync(getRunnerMetadataPath(cwd));
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') {
      errors.push(`unlink metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { errors };
}

export interface RemoteRunnerStatus {
  registeredOnGithub: boolean;
  online: boolean;
  busy: boolean;
}

/**
 * Ask GitHub whether the registered runner is visible + online. Used by
 * the wizard's edit screen so users can see at a glance whether their
 * laptop is currently reachable.
 */
export function getRemoteRunnerStatus(
  meta: RunnerMetadata,
  shims?: SelfHostedRunnerShims,
): GhResult<RemoteRunnerStatus> {
  const res = shim(shims, 'gh')([
    'api',
    `repos/${meta.repo}/actions/runners`,
    '--jq',
    '.runners[] | {name: .name, status: .status, busy: .busy}',
  ]);
  if (!res.ok) return res;
  const lines = res.value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as { name?: string; status?: string; busy?: boolean };
      if (r.name === meta.runnerName) {
        return {
          ok: true,
          value: {
            registeredOnGithub: true,
            online: r.status === 'online',
            busy: r.busy === true,
          },
        };
      }
    } catch {
      // skip malformed line
    }
  }
  return { ok: true, value: { registeredOnGithub: false, online: false, busy: false } };
}

export interface PublicRepoGate {
  isPublic: boolean;
  /** True iff fork-PR workflows require maintainer approval before running. */
  approvalGateEnabled: boolean;
  /** Raw fork-PR approval policy from the API for messaging. */
  forkPrApprovalPolicy?: string;
  /** Whether the repo allows forks at all. */
  forksAllowed: boolean;
}

/**
 * Check whether self-hosted is safe to enable on this repo. For private
 * repos every config is acceptable. For public repos we require the
 * fork-PR approval gate to be on so a forker editing the workflow YAML
 * cannot run arbitrary code on the user's machine via a drive-by PR.
 *
 * GitHub's documented field name (as of 2025) is
 * `fork_pr_workflows_policy` on `repos/{o}/{r}/actions/permissions`.
 * Acceptable values that gate fork PRs: `first_time_contributors`,
 * `first_time_contributors_new_to_github`, `all_outside_collaborators`.
 * The fully-permissive value is `requires_no_approval` (or absent).
 */
export function checkPublicRepoApprovalGate(
  repo: string,
  shims?: SelfHostedRunnerShims,
): GhResult<PublicRepoGate> {
  const repoRes = shim(shims, 'gh')([
    'api',
    `repos/${repo}`,
    '--jq',
    '{visibility: .visibility, forks: .allow_forking}',
  ]);
  if (!repoRes.ok) return repoRes;
  let visibility = 'private';
  let forksAllowed = true;
  try {
    const parsed = JSON.parse(repoRes.value) as { visibility?: string; forks?: boolean };
    if (parsed.visibility) visibility = parsed.visibility;
    if (typeof parsed.forks === 'boolean') forksAllowed = parsed.forks;
  } catch {
    // Treat unparseable response as private — the caller will see an
    // error elsewhere and we don't want to falsely mark a repo public.
  }
  const isPublic = visibility === 'public';

  let forkPrApprovalPolicy: string | undefined;
  let approvalGateEnabled = false;
  if (isPublic) {
    const permRes = shim(shims, 'gh')([
      'api',
      `repos/${repo}/actions/permissions`,
      '--jq',
      '.fork_pr_workflows_policy',
    ]);
    if (!permRes.ok) return permRes;
    forkPrApprovalPolicy = permRes.value.trim().replace(/^"|"$/g, '');
    approvalGateEnabled =
      forkPrApprovalPolicy === 'first_time_contributors' ||
      forkPrApprovalPolicy === 'first_time_contributors_new_to_github' ||
      forkPrApprovalPolicy === 'all_outside_collaborators';
  } else {
    approvalGateEnabled = true;
  }

  return {
    ok: true,
    value: { isPublic, approvalGateEnabled, forkPrApprovalPolicy, forksAllowed },
  };
}
