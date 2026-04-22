import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
  const out = { mode: 'reproduce', cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
  }
  return out;
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
}

function ensureGitignore(cwd) {
  const giPath = join(cwd, '.gitignore');
  const entry = '.harnext/browser-verify/';
  let existing = '';
  if (existsSync(giPath)) {
    existing = readFileSync(giPath, 'utf8');
    const lines = existing.split('\n').map((l) => l.trim());
    if (lines.includes(entry) || lines.includes('.harnext/') || lines.includes('.harnext')) {
      return { added: false, path: giPath };
    }
    const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
    appendFileSync(giPath, `${prefix}${entry}\n`);
    return { added: true, path: giPath };
  }
  writeFileSync(giPath, `${entry}\n`);
  return { added: true, path: giPath };
}

function main() {
  const { mode, cwd } = parseArgs(process.argv.slice(2));
  if (mode !== 'reproduce' && mode !== 'verify') {
    console.error(JSON.stringify({ error: `invalid --mode: ${mode} (expected reproduce|verify)` }));
    process.exit(2);
  }

  const resolvedCwd = resolve(cwd);
  const runId = `${mode}-${isoStamp()}-${randomBytes(2).toString('hex')}`;
  const runDir = join(resolvedCwd, '.harnext', 'browser-verify', runId);

  mkdirSync(join(runDir, 'video'), { recursive: true });
  mkdirSync(join(runDir, 'snapshots'), { recursive: true });

  const gi = ensureGitignore(resolvedCwd);

  const result = {
    runId,
    runDir,
    mode,
    gitignore: gi,
    artifactPaths: {
      summary: join(runDir, 'summary.json'),
      scenario: join(runDir, 'scenario.mjs'),
      steps: join(runDir, 'steps.jsonl'),
      console: join(runDir, 'console.jsonl'),
      pageErrors: join(runDir, 'page-errors.jsonl'),
      networkErrors: join(runDir, 'network-errors.jsonl'),
      har: join(runDir, 'network.har'),
      snapshots: join(runDir, 'snapshots'),
      video: join(runDir, 'video'),
      trace: join(runDir, 'trace.zip'),
      finalScreenshot: join(runDir, 'final.png'),
    },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
}
