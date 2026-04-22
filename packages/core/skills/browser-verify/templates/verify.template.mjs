// browser-verify scenario — copied from templates/verify.template.mjs into a run dir.
// Do NOT import via relative paths: this file is relocated at runtime. Resolve
// everything through SKILL_DIR (set by the agent when invoking this scenario).

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SKILL_DIR = process.env.SKILL_DIR;
const RUN_DIR = process.env.RUN_DIR;
const USER_DATA_DIR = process.env.USER_DATA_DIR;
const EXECUTABLE_PATH = process.env.EXECUTABLE_PATH;
const HEADLESS = process.env.HEADLESS === '1' || process.env.CI === '1';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30000);
const RUN_ID = process.env.RUN_ID ?? null;
const MODE = process.env.MODE ?? null;

if (!SKILL_DIR || !RUN_DIR || !USER_DATA_DIR || !EXECUTABLE_PATH) {
  console.error(
    'Missing required env: SKILL_DIR, RUN_DIR, USER_DATA_DIR, EXECUTABLE_PATH',
  );
  process.exit(2);
}

const { chromium } = await import(
  pathToFileURL(join(SKILL_DIR, 'node_modules', 'playwright', 'index.mjs')).href
);
const { attachListeners, step, finalize } = await import(
  pathToFileURL(join(SKILL_DIR, 'scripts', 'capture-lib.mjs')).href
);

const startedAt = new Date().toISOString();
const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  executablePath: EXECUTABLE_PATH,
  headless: HEADLESS,
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: join(RUN_DIR, 'video') },
  recordHar: { path: join(RUN_DIR, 'network.har'), content: 'omit' },
  args: ['--disable-extensions'],
});

await context.tracing.start({ screenshots: true, snapshots: true });
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(TIMEOUT_MS);
const { counts } = attachListeners(page, RUN_DIR);

let passed = true;
let failedStep = null;
let finalUrl = null;

try {
  // TODO(model): STARTING_URL — replace with the URL this scenario targets.
  await page.goto('https://example.com/');

  // TODO(model): REPRO_STEPS — add one `step(...)` call per user-visible action.
  // Each call captures an a11y snapshot + steps.jsonl entry on failure.
  // Example:
  //   await step('click-submit', async () => {
  //     await page.getByRole('button', { name: 'Submit' }).click();
  //   }, { page, runDir: RUN_DIR });

  // TODO(model): ASSERTIONS — throw from within a step() to record a failure.
  // Example:
  //   await step('assert-heading', async () => {
  //     const h = page.getByRole('heading', { name: 'Expected text' });
  //     if (!(await h.isVisible())) throw new Error('heading not visible');
  //   }, { page, runDir: RUN_DIR });

  finalUrl = page.url();
} catch (err) {
  passed = false;
  failedStep = String(err?.message ?? err);
  try {
    finalUrl = page.url();
  } catch {
    // ignore
  }
} finally {
  await finalize(
    {
      runId: RUN_ID,
      mode: MODE,
      passed,
      failedStep,
      startedAt,
      url: finalUrl,
      runDir: RUN_DIR,
    },
    { context, page, listenersCounts: counts },
  );
}

if (!passed) process.exit(1);
