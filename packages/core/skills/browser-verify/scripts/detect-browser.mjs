import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { prefer: 'chrome' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prefer') out.prefer = argv[++i];
  }
  return out;
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function whichLinux(bins) {
  for (const b of bins) {
    const p = tryExec(`command -v ${b}`);
    if (p) return p;
  }
  return null;
}

const LINUX_CANDIDATES = {
  chrome: {
    bins: ['google-chrome', 'google-chrome-stable', 'chrome'],
    userDataCandidates: ['.config/google-chrome'],
    desktopPattern: /google-chrome|chrome/i,
  },
  edge: {
    bins: ['microsoft-edge', 'microsoft-edge-stable'],
    userDataCandidates: ['.config/microsoft-edge'],
    desktopPattern: /microsoft-edge|msedge/i,
  },
  brave: {
    bins: ['brave-browser', 'brave'],
    userDataCandidates: ['.config/BraveSoftware/Brave-Browser'],
    desktopPattern: /brave/i,
  },
  chromium: {
    bins: ['chromium', 'chromium-browser'],
    userDataCandidates: ['.config/chromium'],
    desktopPattern: /chromium/i,
  },
};

const MAC_CANDIDATES = {
  chrome: {
    exec: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userData: 'Library/Application Support/Google/Chrome',
  },
  edge: {
    exec: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    userData: 'Library/Application Support/Microsoft Edge',
  },
  brave: {
    exec: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    userData: 'Library/Application Support/BraveSoftware/Brave-Browser',
  },
  chromium: {
    exec: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    userData: 'Library/Application Support/Chromium',
  },
};

const WINDOWS_CANDIDATES = {
  chrome: {
    execs: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    userData: 'AppData\\Local\\Google\\Chrome\\User Data',
  },
  edge: {
    execs: [
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    userData: 'AppData\\Local\\Microsoft\\Edge\\User Data',
  },
  brave: {
    execs: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
    userData: 'AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data',
  },
};

function detectLinuxDefault() {
  const raw = tryExec('xdg-settings get default-web-browser');
  if (!raw) return null;
  const desktopName = raw.trim();
  for (const [name, cand] of Object.entries(LINUX_CANDIDATES)) {
    if (cand.desktopPattern.test(desktopName)) return name;
  }
  return null;
}

function detectLinux(prefer) {
  const order = [detectLinuxDefault(), prefer, 'chrome', 'edge', 'brave', 'chromium'].filter(Boolean);
  const seen = new Set();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const cand = LINUX_CANDIDATES[name];
    if (!cand) continue;
    const exec = whichLinux(cand.bins);
    if (!exec) continue;
    for (const rel of cand.userDataCandidates) {
      const udd = join(homedir(), rel);
      if (existsSync(udd)) {
        return { browser: name, executablePath: exec, userDataDir: udd, platform: 'linux' };
      }
    }
    // executable exists but no user-data-dir yet; still return — Playwright will create one if needed
    const udd = join(homedir(), cand.userDataCandidates[0]);
    return { browser: name, executablePath: exec, userDataDir: udd, platform: 'linux' };
  }
  return null;
}

function detectMac(prefer) {
  const order = [prefer, 'chrome', 'edge', 'brave', 'chromium'];
  const seen = new Set();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const cand = MAC_CANDIDATES[name];
    if (!cand) continue;
    if (!existsSync(cand.exec)) continue;
    return {
      browser: name,
      executablePath: cand.exec,
      userDataDir: join(homedir(), cand.userData),
      platform: 'darwin',
    };
  }
  return null;
}

function detectWindows(prefer) {
  const order = [prefer, 'chrome', 'edge', 'brave'];
  const seen = new Set();
  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const cand = WINDOWS_CANDIDATES[name];
    if (!cand) continue;
    for (const exec of cand.execs) {
      if (existsSync(exec)) {
        return {
          browser: name,
          executablePath: exec,
          userDataDir: join(homedir(), cand.userData),
          platform: 'win32',
        };
      }
    }
  }
  return null;
}

function main() {
  const { prefer } = parseArgs(process.argv.slice(2));
  const plat = platform();
  let result = null;
  if (plat === 'linux') result = detectLinux(prefer);
  else if (plat === 'darwin') result = detectMac(prefer);
  else if (plat === 'win32') result = detectWindows(prefer);

  if (!result) {
    console.error(
      JSON.stringify({
        error: 'no-chromium-browser-found',
        platform: plat,
        supported: ['chrome', 'edge', 'brave', 'chromium'],
      }),
    );
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
}
