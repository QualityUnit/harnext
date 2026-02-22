import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { logger } from '../ui/logger.js';
import { withSpinner } from '../ui/spinner.js';
import { confirmPrompt, selectPrompt, multiselectPrompt, inputPrompt } from '../ui/prompts.js';
import { isGitRepo, getRepoRoot } from '../utils/git.js';
import { readFileIfExists } from '../utils/fs.js';
import { NotAGitRepoError } from '../utils/errors.js';
import { AI_PLATFORMS, INSTRUCTION_FILES } from '../core/ai-runner.js';
import type { AIPlatform } from '../core/ai-runner.js';
import { createRunner, validatePlatformCLI } from '../core/runner-factory.js';
import { FileWriter } from '../core/file-writer.js';
import { loadHarnessConfig } from '../core/config.js';
import { runHeuristicDetection } from '../core/detector.js';
import type { DetectionResult } from '../core/detector.js';
import { getHarnessModules } from '../harnesses/index.js';
import type {
  HarnessContext,
  HarnessModule,
  HarnessOutput,
  UserPreferences,
} from '../harnesses/types.js';

const execFileAsync = promisify(execFile);

export interface InitOptions {
  skipDetection?: boolean;
  dryRun?: boolean;
  platform?: string;
  ciProvider?: string;
  strictness?: string;
  yes?: boolean;
}

// Mapping from harness name to npm script entries
const HARNESS_SCRIPTS: Record<string, Record<string, string>> = {
  'risk-policy-gate': {
    'harness:risk-tier': 'npx tsx scripts/risk-policy-gate.ts',
  },
  'risk-contract': {
    'harness:smoke': 'npx tsx scripts/harness-smoke.ts',
  },
  'browser-evidence': {
    'harness:ui:capture-browser-evidence': 'npx tsx scripts/harness-ui-capture-browser-evidence.ts',
    'harness:ui:verify-browser-evidence': 'npx tsx scripts/harness-ui-verify-browser-evidence.ts',
    'harness:ui:pre-pr':
      'npm run harness:ui:capture-browser-evidence && npm run harness:ui:verify-browser-evidence',
  },
  'garbage-collection': {
    'harness:weekly-metrics': 'npx tsx scripts/harness-weekly-metrics.ts',
  },
};

export async function initCommand(options: InitOptions): Promise<void> {
  // ── 1. Pre-flight checks ─────────────────────────────────────────────
  if (!(await isGitRepo())) {
    throw new NotAGitRepoError();
  }

  const repoRoot = await getRepoRoot();

  logger.header('CodeFactory - Harness Engineering Setup');
  logger.dim(
    'This wizard will analyze your repository and generate harness engineering artifacts.',
  );
  console.log();

  const nonInteractive = !!(options.yes || (options.platform && options.ciProvider));

  // Check for existing config
  const existingConfig = await loadHarnessConfig(repoRoot);
  if (existingConfig) {
    logger.warn('An existing harness.config.json was found in this repository.');
    if (nonInteractive) {
      logger.info('Overwriting existing configuration (non-interactive mode).');
    } else {
      const overwrite = await confirmPrompt(
        'Do you want to overwrite the existing configuration?',
        false,
      );
      if (!overwrite) {
        logger.info('Init cancelled. Existing configuration preserved.');
        return;
      }
    }
  }

  // ── 2. Detection phase ───────────────────────────────────────────────
  let detection = await withSpinner('Analyzing repository...', () =>
    runHeuristicDetection(repoRoot),
  );

  // ── 3. User preferences ──────────────────────────────────────────────
  displayDetectionSummary(detection);

  if (!nonInteractive) {
    const detectionOk = await confirmPrompt('Does this detection look correct?', true);
    if (!detectionOk) {
      detection = await correctDetection(detection);
    }
  }

  const ciProvider = nonInteractive
    ? ((options.ciProvider as UserPreferences['ciProvider']) ?? 'github-actions')
    : await selectPrompt<UserPreferences['ciProvider']>('Which CI provider do you use?', [
        { name: 'GitHub Actions', value: 'github-actions' },
        { name: 'GitLab CI', value: 'gitlab-ci' },
        { name: 'Bitbucket Pipelines', value: 'bitbucket' },
      ]);

  const aiPlatform = nonInteractive
    ? ((options.platform ?? 'claude') as AIPlatform)
    : await selectPrompt<AIPlatform>(
        'Which AI coding agent do you use?',
        AI_PLATFORMS.map((p) => ({ name: `${p.name} — ${p.description}`, value: p.value })),
      );

  // Validate CLI availability
  try {
    validatePlatformCLI(aiPlatform);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(msg);
    return;
  }

  // ── Platform-specific setup check ────────────────────────────────────
  if (aiPlatform === 'claude' && ciProvider === 'github-actions') {
    console.log();
    logger.warn('CodeFactory generates CI workflows that use the Claude Code GitHub Action.');
    logger.warn(
      'These workflows require the Claude GitHub App to be installed on your repository.',
    );
    console.log();
    logger.info("If you haven't already, run /install-github-app in Claude Code to set it up.");
    logger.info(
      'This ensures the CLAUDE_CODE_OAUTH_TOKEN secret is available for your CI workflows.',
    );
    console.log();

    if (!nonInteractive) {
      const hasGitHubApp = await confirmPrompt(
        'Have you installed the Claude GitHub App on this repository?',
        false,
      );
      if (!hasGitHubApp) {
        logger.warn(
          'Please run /install-github-app in Claude Code first, then re-run codefactory init.',
        );
        logger.dim(
          '  Without the GitHub App, Claude-powered CI workflows (review agent, remediation, etc.) will not function.',
        );
        return;
      }
    }
  } else if (aiPlatform === 'kiro' && ciProvider === 'github-actions') {
    console.log();
    logger.info('Kiro-powered CI workflows require AWS OIDC authentication via GitHub secrets.');
    logger.info('Ensure AWS_ROLE_ARN is set as a repository secret for OIDC authentication.');
    console.log();
  } else if (aiPlatform === 'codex' && ciProvider === 'github-actions') {
    console.log();
    logger.info('Codex-powered CI workflows require an OpenAI API key as a GitHub secret.');
    logger.info('Ensure OPENAI_API_KEY is set in your repo secrets.');
    console.log();
  }

  // Build harness selection list
  const tempRunner = createRunner(aiPlatform, { cwd: repoRoot });
  const tempCtx: HarnessContext = {
    repoRoot,
    detection,
    runner: tempRunner,
    fileWriter: new FileWriter(),
    userPreferences: {
      ciProvider,
      aiPlatform,
      strictnessLevel: 'standard',
      selectedHarnesses: [],
    },
    previousOutputs: new Map(),
  };

  const allHarnesses = getHarnessModules();
  const harnessChoices = allHarnesses.map((h) => ({
    name: `${h.displayName} - ${h.description}`,
    value: h.name,
    checked: h.isApplicable(tempCtx),
  }));

  const selectedHarnesses = nonInteractive
    ? harnessChoices.filter((c) => c.checked).map((c) => c.value)
    : await multiselectPrompt<string>('Select harnesses to install:', harnessChoices);

  if (selectedHarnesses.length === 0) {
    logger.warn('No harnesses selected. Nothing to generate.');
    return;
  }

  // Critical paths
  console.log();
  if (detection.criticalPaths.length > 0) {
    logger.info('Auto-detected critical paths:');
    for (const p of detection.criticalPaths) {
      logger.dim(`  - ${p}`);
    }
  }

  let customCriticalPaths: string[] | undefined;
  if (!nonInteractive) {
    const editPaths = await confirmPrompt('Would you like to add or modify critical paths?', false);
    if (editPaths) {
      const pathInput = await inputPrompt('Enter additional critical paths (comma-separated):');
      const extra = pathInput
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      customCriticalPaths = [...detection.criticalPaths, ...extra];
    }
  }

  const strictnessLevel = nonInteractive
    ? ((options.strictness ?? 'standard') as UserPreferences['strictnessLevel'])
    : await selectPrompt<UserPreferences['strictnessLevel']>(
        'Strictness level for harness rules:',
        [
          { name: 'Relaxed - warnings only, no blocking', value: 'relaxed' },
          { name: 'Standard - block on high-risk, warn on medium', value: 'standard' },
          { name: 'Strict - block on medium and high-risk', value: 'strict' },
        ],
      );

  const userPreferences: UserPreferences = {
    ciProvider,
    aiPlatform,
    strictnessLevel,
    selectedHarnesses,
    customCriticalPaths,
  };

  // Dry-run bail-out
  if (options.dryRun) {
    displayDryRun(detection, userPreferences, allHarnesses);
    return;
  }

  // ── 4. Ensure GitHub labels ──────────────────────────────────────────
  await ensureGitHubLabels(repoRoot, ciProvider);

  // ── 5. Harness execution ─────────────────────────────────────────────
  const runner = createRunner(aiPlatform, {
    cwd: repoRoot,
    onLogLine: (line) => logger.dim(line),
  });
  const fileWriter = new FileWriter();
  const previousOutputs = new Map<string, HarnessOutput>();

  const ctx: HarnessContext = {
    repoRoot,
    detection,
    runner,
    fileWriter,
    userPreferences,
    previousOutputs,
  };

  console.log();
  logger.header('Generating harness artifacts');

  const applicableHarnesses = allHarnesses.filter((h) => selectedHarnesses.includes(h.name));

  const batches = [
    ['risk-contract', 'claude-md', 'docs-structure', 'pre-commit-hooks'],
    ['risk-policy-gate', 'ci-pipeline', 'review-agent', 'remediation-loop'],
    ['browser-evidence', 'pr-templates', 'architectural-linters', 'garbage-collection'],
    ['incident-harness-loop', 'issue-triage', 'issue-planner', 'issue-implementer'],
  ];

  for (const batch of batches) {
    const harnessesInBatch = batch
      .map((name) => applicableHarnesses.find((h) => h.name === name))
      .filter((h): h is HarnessModule => h != null);

    if (harnessesInBatch.length === 0) continue;

    const results = await Promise.allSettled(harnessesInBatch.map((h) => h.execute(ctx)));

    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        const output = result.value;
        previousOutputs.set(harnessesInBatch[i].name, output);

        for (const f of output.filesCreated) {
          logger.fileCreated(relative(repoRoot, f));
        }
        for (const f of output.filesModified) {
          logger.fileModified(relative(repoRoot, f));
        }
      } else {
        logger.warn(`Harness ${harnessesInBatch[i].name} failed: ${result.reason}`);
      }
    }
  }

  // ── 6. Add npm scripts to target repo's package.json ─────────────────
  await addHarnessScripts(repoRoot, selectedHarnesses, fileWriter);

  // ── 7. Save harness config (merge with Claude-generated config) ─────
  // The risk-contract harness writes harness.config.json with riskTiers,
  // commands, shaDiscipline, architecturalBoundaries, etc. We merge the
  // harness registry into that config rather than overwriting it.
  const configPath = join(repoRoot, 'harness.config.json');
  let claudeConfig: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    claudeConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // No existing config from risk-contract harness, start fresh
  }

  const harnessRegistry = {
    version: '1.0.0',
    repoRoot: '.',
    aiPlatform,
    detection: {
      primaryLanguage: detection.primaryLanguage,
      framework: detection.framework,
      packageManager: detection.packageManager,
      ciProvider: detection.ciProvider,
      monorepo: detection.monorepo,
    },
    harnesses: applicableHarnesses.map((h) => {
      const output = previousOutputs.get(h.name);
      return {
        name: h.name,
        enabled: true,
        generatedAt: new Date().toISOString(),
        files: output ? [...output.filesCreated, ...output.filesModified] : [],
      };
    }),
    generatedAt: claudeConfig.generatedAt ?? new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  // Merge: Claude's config (riskTiers, commands, etc.) is the base,
  // harness registry fields are added/overwritten on top
  const mergedConfig = { ...claudeConfig, ...harnessRegistry };
  await writeFile(configPath, JSON.stringify(mergedConfig, null, 2) + '\n', 'utf-8');
  logger.fileCreated('harness.config.json');

  // ── 8. Summary ───────────────────────────────────────────────────────
  console.log();
  logger.header('Summary');

  const allCreated: string[] = [];
  const allModified: string[] = [];
  for (const output of previousOutputs.values()) {
    allCreated.push(...output.filesCreated);
    allModified.push(...output.filesModified);
  }

  if (allCreated.length > 0) {
    logger.success(`Files created (${allCreated.length}):`);
    for (const f of allCreated) {
      logger.dim(`  + ${relative(repoRoot, f)}`);
    }
  }

  if (allModified.length > 0) {
    logger.success(`Files modified (${allModified.length}):`);
    for (const f of allModified) {
      logger.dim(`  ~ ${relative(repoRoot, f)}`);
    }
  }

  // Useful command set
  console.log();
  logger.info('Useful commands:');
  logger.dim('  npm run typecheck');
  logger.dim('  npm test');
  logger.dim('  npm run build');

  if (selectedHarnesses.includes('risk-contract')) {
    logger.dim('  npm run harness:smoke');
  }
  if (selectedHarnesses.includes('browser-evidence') && detection.hasUIComponents) {
    logger.dim('  npm run harness:ui:pre-pr');
  }
  if (selectedHarnesses.includes('risk-policy-gate')) {
    logger.dim('  npm run harness:risk-tier');
  }
  if (selectedHarnesses.includes('garbage-collection')) {
    logger.dim('  npm run harness:weekly-metrics');
  }

  // Offer to commit
  console.log();
  const shouldCommit = nonInteractive
    ? true
    : await confirmPrompt('Would you like to create a git commit with the generated files?', true);

  if (shouldCommit) {
    try {
      const allFiles = [...allCreated, ...allModified, join(repoRoot, 'harness.config.json')];
      const relativePaths = allFiles.map((f) => relative(repoRoot, f));
      const uniquePaths = [...new Set(relativePaths)];

      await execFileAsync('git', ['add', ...uniquePaths], { cwd: repoRoot });
      await execFileAsync(
        'git',
        ['commit', '-m', 'chore: initialize harness engineering with CodeFactory'],
        { cwd: repoRoot },
      );
      logger.success('Created commit: chore: initialize harness engineering with CodeFactory');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Git commit failed: ${msg}`);
      logger.dim('  You can commit the changes manually.');
    }
  }

  // Next steps
  const instructionFile = INSTRUCTION_FILES[aiPlatform];

  console.log();
  logger.header('Next steps');
  logger.info(`1. Review the generated ${instructionFile} and harness.config.json files.`);
  logger.info('2. Run "npm run harness:smoke" to verify the harness setup works.');
  logger.info('3. Open a PR with these changes and observe the CI harness checks.');
  logger.info('4. Customize risk tiers and policies in harness.config.json as needed.');
  console.log();
  logger.success('Harness engineering setup complete!');
}

// ── Helper functions ──────────────────────────────────────────────────────

const GITHUB_LABELS: { name: string; color: string; description: string }[] = [
  { name: 'agent:plan', color: '0E8A16', description: 'Triggers the planner agent' },
  { name: 'agent:implement', color: '1D76DB', description: 'Triggers the implementer agent' },
  { name: 'agent:needs-judgment', color: 'D93F0B', description: 'Requires human judgment' },
  { name: 'agent-pr', color: 'BFD4F2', description: 'PR created by an agent' },
  { name: 'review-fix-cycle-1', color: 'FBCA04', description: 'First review-fix cycle' },
  { name: 'review-fix-cycle-2', color: 'FBCA04', description: 'Second review-fix cycle' },
  { name: 'review-fix-cycle-3', color: 'FBCA04', description: 'Third review-fix cycle' },
  { name: 'needs-more-info', color: 'D4C5F9', description: 'Needs additional information' },
  { name: 'triage:failed', color: 'B60205', description: 'Triage failed' },
  { name: 'needs-human-review', color: 'E99695', description: 'Needs human review' },
];

async function ensureGitHubLabels(repoRoot: string, ciProvider: string): Promise<void> {
  if (ciProvider !== 'github-actions') return;

  logger.info('Ensuring GitHub labels exist...');
  for (const label of GITHUB_LABELS) {
    try {
      execFileSync(
        'gh',
        [
          'label',
          'create',
          label.name,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ],
        { cwd: repoRoot, stdio: 'ignore' },
      );
    } catch {
      // Label creation may fail if gh CLI is not available or not authenticated — non-fatal
    }
  }
  logger.dim('  GitHub labels checked.');
}

function displayDetectionSummary(d: DetectionResult): void {
  console.log();
  logger.info('Detection results:');
  logger.dim(`  Language:        ${d.primaryLanguage}`);
  if (d.framework) logger.dim(`  Framework:       ${d.framework}`);
  if (d.packageManager) logger.dim(`  Package manager: ${d.packageManager}`);
  if (d.testFramework) logger.dim(`  Test framework:  ${d.testFramework}`);
  if (d.linter) logger.dim(`  Linter:          ${d.linter}`);
  if (d.formatter) logger.dim(`  Formatter:       ${d.formatter}`);
  if (d.typeChecker) logger.dim(`  Type checker:    ${d.typeChecker}`);
  if (d.buildTool) logger.dim(`  Build tool:      ${d.buildTool}`);
  if (d.ciProvider) logger.dim(`  CI provider:     ${d.ciProvider}`);
  logger.dim(`  Monorepo:        ${d.monorepo ? 'yes' : 'no'}`);
  logger.dim(`  UI components:   ${d.hasUIComponents ? 'yes' : 'no'}`);
  if (d.existingClaude) logger.dim('  Existing CLAUDE.md detected');
  if (d.architecturalLayers.length > 0) {
    logger.dim(`  Layers:          ${d.architecturalLayers.join(', ')}`);
  }
  if (d.criticalPaths.length > 0) {
    logger.dim(`  Critical paths:  ${d.criticalPaths.length} detected`);
  }
  console.log();
}

async function correctDetection(d: DetectionResult): Promise<DetectionResult> {
  const corrected = { ...d };

  const language = await inputPrompt('Primary language:', d.primaryLanguage);
  corrected.primaryLanguage = language;

  const framework = await inputPrompt('Framework (leave empty for none):', d.framework ?? '');
  corrected.framework = framework || null;

  const testFramework = await inputPrompt(
    'Test framework (leave empty for none):',
    d.testFramework ?? '',
  );
  corrected.testFramework = testFramework || null;

  return corrected;
}

async function addHarnessScripts(
  repoRoot: string,
  selectedHarnesses: string[],
  fileWriter: FileWriter,
): Promise<void> {
  const packageJsonPath = join(repoRoot, 'package.json');
  const raw = await readFileIfExists(packageJsonPath);
  if (!raw) return;

  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = (pkg.scripts as Record<string, string>) ?? {};

    for (const harnessName of selectedHarnesses) {
      const harnessScripts = HARNESS_SCRIPTS[harnessName];
      if (harnessScripts) {
        Object.assign(scripts, harnessScripts);
      }
    }

    pkg.scripts = scripts;
    await fileWriter.write(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  } catch {
    logger.warn('Could not update package.json with harness scripts.');
  }
}

function displayDryRun(
  detection: DetectionResult,
  prefs: UserPreferences,
  allHarnesses: { name: string; displayName: string }[],
): void {
  console.log();
  logger.header('Dry Run - What would be generated');

  logger.info(`CI provider: ${prefs.ciProvider}`);
  logger.info(`Strictness: ${prefs.strictnessLevel}`);
  console.log();

  logger.info('Selected harnesses:');
  const selectedModules = allHarnesses.filter((h) => prefs.selectedHarnesses.includes(h.name));
  for (const h of selectedModules) {
    logger.dim(`  - ${h.displayName}`);
  }

  console.log();
  logger.info('Scripts that would be added to package.json:');
  for (const harnessName of prefs.selectedHarnesses) {
    const scripts = HARNESS_SCRIPTS[harnessName];
    if (scripts) {
      for (const [key, val] of Object.entries(scripts)) {
        logger.dim(`  "${key}": "${val}"`);
      }
    }
  }

  console.log();
  logger.info('No files were written (dry-run mode).');
}
