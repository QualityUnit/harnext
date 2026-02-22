import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';

import { buildBrowserEvidencePrompt } from '../prompts/browser-evidence.js';
import { buildSystemPrompt } from '../prompts/system.js';

const CAPTURE_SCRIPT = `#!/usr/bin/env node
/**
 * Browser Evidence Capture
 *
 * Uses Playwright to capture screenshots of UI components after changes.
 * Intended to run in CI on PRs that touch UI-related files.
 *
 * Usage:
 *   npx tsx scripts/harness-ui-capture-browser-evidence.ts [--base-url URL] [--out-dir DIR]
 *
 * Options:
 *   --base-url   Base URL of the running app (default: http://localhost:3000)
 *   --out-dir    Directory to write screenshots (default: .harness/browser-evidence)
 *
 * Exit codes:
 *   0  Screenshots captured successfully
 *   1  One or more captures failed
 *   2  Configuration or runtime error
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(): { baseUrl: string; outDir: string } {
  const args = process.argv.slice(2);
  let baseUrl = 'http://localhost:3000';
  let outDir = '.harness/browser-evidence';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base-url' && args[i + 1]) baseUrl = args[++i];
    if (args[i] === '--out-dir' && args[i + 1]) outDir = args[++i];
  }

  return { baseUrl, outDir: resolve(outDir) };
}

// ---------------------------------------------------------------------------
// Routes to capture — extend this list as the UI grows
// ---------------------------------------------------------------------------

const DEFAULT_ROUTES = [
  { name: 'home', path: '/' },
  { name: 'about', path: '/about' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { baseUrl, outDir } = parseArgs();

  // Playwright is a peer dependency — fail fast if missing
  let chromium: typeof import('playwright').chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.error('ERROR: playwright is not installed. Run: npm add -D playwright');
    process.exit(2);
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const results: { route: string; file: string; ok: boolean; error?: string }[] = [];

  for (const route of DEFAULT_ROUTES) {
    const url = baseUrl.replace(/\\/$/, '') + route.path;
    const outFile = pathJoin(outDir, route.name + '.png');

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.screenshot({ path: outFile, fullPage: true });
      results.push({ route: route.path, file: outFile, ok: true });
      console.log('  captured ' + route.name + ' -> ' + outFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ route: route.path, file: outFile, ok: false, error: msg });
      console.error('  FAILED ' + route.name + ': ' + msg);
    }
  }

  await browser.close();

  // Write manifest
  const manifestPath = pathJoin(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(results, null, 2));
  console.log('\\nManifest written to ' + manifestPath);

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error(failures.length + ' capture(s) failed');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ERROR: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(2);
});
`;

const VERIFY_SCRIPT = `#!/usr/bin/env node
/**
 * Browser Evidence Verifier
 *
 * Checks that expected screenshot files exist and the manifest is complete.
 * Runs after the capture step to gate the PR on visual evidence.
 *
 * Usage:
 *   npx tsx scripts/harness-ui-verify-browser-evidence.ts [--dir DIR]
 *
 * Exit codes:
 *   0  All evidence present
 *   1  Missing evidence files
 *   2  Configuration or runtime error
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const args = process.argv.slice(2);
  let dir = '.harness/browser-evidence';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
  }

  const resolvedDir = resolve(dir);
  const manifestPath = resolve(resolvedDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    console.error('ERROR: manifest.json not found at ' + manifestPath);
    console.error('Run the capture script first: npx tsx scripts/harness-ui-capture-browser-evidence.ts');
    process.exit(2);
  }

  let manifest: { route: string; file: string; ok: boolean; error?: string }[];
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error('ERROR: Failed to parse manifest: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(2);
  }

  let missing = 0;

  for (const entry of manifest) {
    if (!entry.ok) {
      console.error('  FAIL (capture error): ' + entry.route + ' — ' + (entry.error ?? 'unknown'));
      missing++;
      continue;
    }
    if (!existsSync(entry.file)) {
      console.error('  FAIL (file missing): ' + entry.file);
      missing++;
      continue;
    }
    console.log('  OK: ' + entry.route + ' -> ' + entry.file);
  }

  if (missing > 0) {
    console.error('\\n' + missing + ' evidence file(s) missing or failed');
    process.exit(1);
  }

  console.log('\\nAll ' + manifest.length + ' evidence file(s) verified.');
}

main();
`;

const WORKFLOW_YML = `name: Browser Evidence

on:
  pull_request:
    paths:
      - 'src/**/*.tsx'
      - 'src/**/*.jsx'
      - 'src/**/*.vue'
      - 'src/**/*.svelte'
      - 'app/**'
      - 'pages/**'
      - 'components/**'
      - 'public/**'

permissions:
  contents: read

concurrency:
  group: browser-evidence-\${{ github.head_ref || github.ref }}
  cancel-in-progress: true

jobs:
  capture:
    name: Capture Browser Evidence
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Setup Node.js
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Start dev server
        run: npm run dev &
        env:
          CI: true

      - name: Wait for server
        run: npx wait-on http://localhost:3000 --timeout 30000

      - name: Capture screenshots
        run: npx tsx scripts/harness-ui-capture-browser-evidence.ts

      - name: Verify screenshots
        run: npx tsx scripts/harness-ui-verify-browser-evidence.ts

      - name: Upload evidence
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: browser-evidence
          path: .harness/browser-evidence/
          retention-days: 14
`;

export const browserEvidenceHarness: HarnessModule = {
  name: 'browser-evidence',
  displayName: 'Browser Evidence Capture',
  description: 'Generates browser evidence capture and verification scripts for UI changes',
  order: 9,

  isApplicable(ctx: HarnessContext): boolean {
    return ctx.detection.hasUIComponents === true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const { detection, userPreferences } = ctx;

    // 1. Reference templates from existing string constants
    const refCaptureScript = CAPTURE_SCRIPT;
    const refVerifyScript = VERIFY_SCRIPT;
    const refWorkflow = WORKFLOW_YML;

    // 2. Build the prompt with reference context
    const basePrompt = buildBrowserEvidencePrompt(detection, userPreferences);
    const prompt = `${basePrompt}

## Reference Implementation

Use these as your structural template. Keep the same patterns but customize all
language setup, install commands, test/lint/build commands, and tooling for the
detected stack.

### Reference: scripts/harness-ui-capture-browser-evidence.ts
\`\`\`typescript
${refCaptureScript}
\`\`\`

### Reference: scripts/harness-ui-verify-browser-evidence.ts
\`\`\`typescript
${refVerifyScript}
\`\`\`

### Reference: .github/workflows/browser-evidence.yml
\`\`\`yaml
${refWorkflow}
\`\`\``;

    // 3. Call AI runner
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);
    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);
      const output: HarnessOutput = {
        harnessName: 'browser-evidence',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: { evidencePath: 'scripts/browser-evidence/' },
      };
      ctx.previousOutputs.set('browser-evidence', output);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Browser evidence generation failed: ${message}`);
    }
  },
};
