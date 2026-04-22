import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(here, '..');
const sentinel = join(skillDir, '.prepared');

function parseArgs(argv) {
  return { force: argv.includes('--force') };
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    const details = { cmd, args, status: r.status, signal: r.signal };
    throw new Error(`command failed: ${JSON.stringify(details)}`);
  }
}

function main() {
  const { force } = parseArgs(process.argv.slice(2));

  if (!force && existsSync(sentinel)) {
    process.stdout.write(
      JSON.stringify(
        { prepared: true, reused: true, sentinel, skillDir },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // 1. Install the skill's own deps (playwright)
  run('npm', ['install', '--prefix', skillDir, '--no-audit', '--no-fund']);

  // 2. Install the Chromium browser Playwright ships with.
  // Even though we launch the user's real Chrome via executablePath, Playwright
  // requires a matching Chromium to be installed for driver compatibility.
  const pwBin = join(skillDir, 'node_modules', '.bin', 'playwright');
  if (!existsSync(pwBin)) {
    throw new Error(`playwright CLI not found at ${pwBin} after npm install`);
  }
  run(pwBin, ['install', 'chromium']);

  writeFileSync(sentinel, new Date().toISOString() + '\n');
  process.stdout.write(
    JSON.stringify(
      { prepared: true, reused: false, sentinel, skillDir },
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
