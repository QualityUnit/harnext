import { existsSync, mkdirSync, cpSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {
    userDataDir: null,
    cloneDir: join(homedir(), '.harnext', 'browser-verify', 'profile-clone'),
    forceClone: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--user-data-dir') out.userDataDir = argv[++i];
    else if (a === '--clone-dir') out.cloneDir = argv[++i];
    else if (a === '--force-clone') out.forceClone = true;
  }
  return out;
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function isProfileLocked(userDataDir) {
  if (!userDataDir || !existsSync(userDataDir)) return { locked: false, reason: 'missing' };

  // SingletonLock file (Linux/macOS) indicates a running Chrome using this profile
  const singletonLock = join(userDataDir, 'SingletonLock');
  const singletonCookie = join(userDataDir, 'SingletonCookie');
  const singletonSocket = join(userDataDir, 'SingletonSocket');
  for (const p of [singletonLock, singletonCookie, singletonSocket]) {
    try {
      if (existsSync(p)) return { locked: true, reason: `singleton:${basename(p)}` };
    } catch {
      // ignore
    }
  }

  // Fallback: pgrep for chrome/chromium/edge/brave
  if (process.platform !== 'win32') {
    const matches = tryExec("pgrep -af 'chrome|chromium|msedge|brave' || true");
    if (matches) {
      return { locked: true, reason: 'process-running' };
    }
  }

  return { locked: false, reason: 'ok' };
}

const MINIMAL_COPY_LIST = [
  // Top-level
  'Local State',
  // Profile (Default) subset
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
];

const MINIMAL_DIR_COPY = ['Default/Local Storage', 'Default/Session Storage'];

function safeCopyFile(src, dst) {
  if (!existsSync(src)) return false;
  try {
    const s = statSync(src);
    if (!s.isFile()) return false;
    mkdirSync(resolve(dst, '..'), { recursive: true });
    copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

function safeCopyDir(src, dst) {
  if (!existsSync(src)) return false;
  try {
    cpSync(src, dst, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function cloneMinimal(src, dst) {
  mkdirSync(dst, { recursive: true });
  mkdirSync(join(dst, 'Default'), { recursive: true });
  const copied = [];
  for (const rel of MINIMAL_COPY_LIST) {
    if (safeCopyFile(join(src, rel), join(dst, rel))) copied.push(rel);
  }
  for (const rel of MINIMAL_DIR_COPY) {
    if (safeCopyDir(join(src, rel), join(dst, rel))) copied.push(rel + '/');
  }

  // Clean any lingering Singleton* in dst (must not look locked to Playwright)
  let dstEntries = [];
  try {
    dstEntries = readdirSync(dst);
  } catch {
    // dst just-created; ignore
  }
  for (const entry of dstEntries) {
    if (entry.startsWith('Singleton')) {
      try {
        const p = join(dst, entry);
        if (existsSync(p)) execSync(`rm -rf ${JSON.stringify(p)}`, { stdio: 'ignore' });
      } catch {
        // best-effort
      }
    }
  }

  return copied;
}

function main() {
  const { userDataDir, cloneDir, forceClone } = parseArgs(process.argv.slice(2));
  if (!userDataDir) {
    console.error(JSON.stringify({ error: 'missing --user-data-dir' }));
    process.exit(2);
  }

  const lockState = isProfileLocked(userDataDir);
  const shouldClone = forceClone || lockState.locked;

  if (!shouldClone) {
    process.stdout.write(
      JSON.stringify(
        { userDataDir, cloned: false, reason: 'ok', lock: lockState },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const copied = cloneMinimal(userDataDir, cloneDir);
  process.stdout.write(
    JSON.stringify(
      {
        userDataDir: cloneDir,
        cloned: true,
        reason: lockState.reason,
        lock: lockState,
        source: userDataDir,
        copied,
      },
      null,
      2,
    ) + '\n',
  );
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
}
