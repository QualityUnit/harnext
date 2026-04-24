import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCodeAnalysisPipeline } from '../src/code-analysis/pipeline.js';
import {
  getTechStackPath,
  loadTechStack,
} from '../src/code-analysis/schemas/tech-stack.js';
import type { AnalysisEvent, TechStack } from '../src/code-analysis/types.js';
import { DEFAULT_STAGES } from '../src/github-connection.js';

/**
 * Build a stub `runHarnextAgent` that dispatches on the prompt's content:
 * the tech-stack prompt mentions tech-stack.json, the stage-prompts prompt
 * mentions stages.json, etc. Each handler receives the absolute tmp path
 * the pipeline asked the agent to write to and decides what to put there.
 */
function makeStubAgent(handlers: {
  techStack?: (outputPath: string) => unknown;
  riskContract?: (outputPath: string) => unknown;
  checkScripts?: (prompt: string) => void;
  stagePrompts?: (outputPath: string) => unknown;
  projectSkills?: (prompt: string, cwd: string) => void;
}): (prompt: string, cwd: string) => Promise<string> {
  // Branch order matters: later stages' prompts reference earlier stages'
  // outputs (e.g. the risk-contract prompt says "Read the TechStack
  // inventory"), so we discriminate on the *role-defining* phrase of each
  // prompt, not on passing references to prior artifacts.
  return async (prompt, cwd) => {
    if (prompt.includes('producing a **RiskContract**')) {
      const match = prompt.match(/([^\s]+risk-contract[^\s]*contract\.json)/);
      if (match && handlers.riskContract) {
        writeFileSync(match[1], JSON.stringify(handlers.riskContract(match[1])), 'utf-8');
      }
      return 'wrote contract';
    }
    if (prompt.includes('generating **check scripts**')) {
      if (handlers.checkScripts) handlers.checkScripts(prompt);
      return 'wrote check scripts';
    }
    if (prompt.includes('producing a **TechStack inventory**')) {
      const match = prompt.match(/([^\s]+tech-stack[^\s]*tech-stack\.json)/);
      if (match && handlers.techStack) {
        writeFileSync(match[1], JSON.stringify(handlers.techStack(match[1])), 'utf-8');
      }
      return 'wrote tech-stack';
    }
    if (prompt.includes('stage prompts') || prompt.includes('stage id')) {
      const match = prompt.match(/([^\s]+stages\.json)/);
      if (match && handlers.stagePrompts) {
        writeFileSync(match[1], JSON.stringify(handlers.stagePrompts(match[1])), 'utf-8');
      }
      return 'wrote stages';
    }
    if (prompt.includes('Agent Skills') || prompt.includes('SKILL.md')) {
      if (handlers.projectSkills) handlers.projectSkills(prompt, cwd);
      return 'wrote skills';
    }
    return '';
  };
}

function validTechStackJSON(): unknown {
  return {
    version: '1',
    generatedAt: '2026-04-22T10:00:00.000Z',
    isMonorepo: false,
    root: {
      path: '',
      name: 'root',
      language: 'TypeScript',
      framework: null,
      packageManager: 'npm',
      testCommand: 'npm test',
      lintCommand: null,
      buildCommand: null,
      typecheckCommand: null,
      hasUI: false,
      notes: '',
    },
    packages: [],
    ciProvider: null,
    conventions: [],
  };
}

describe('runCodeAnalysisPipeline', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'harnext-pipeline-test-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('phase: tech-stack only — persists .harnext/tech-stack.json and returns baseline stages', async () => {
    const events: AnalysisEvent[] = [];
    const result = await runCodeAnalysisPipeline({
      cwd,
      codingAgent: 'harnext',
      baselineStages: DEFAULT_STAGES,
      phase: 'tech-stack',
      onProgress: (e) => events.push(e),
      runHarnextAgent: makeStubAgent({ techStack: () => validTechStackJSON() }),
    });

    expect(result.errors).toEqual([]);
    expect(result.techStack.root.language).toBe('TypeScript');
    expect(existsSync(getTechStackPath(cwd))).toBe(true);
    expect(result.stages).toEqual(DEFAULT_STAGES);
    expect(events.map((e) => `${e.stage}:${e.status}`)).toEqual([
      'tech-stack:start',
      'tech-stack:ok',
    ]);
    // No error → session dir cleaned.
    expect(result.sessionDir).toBe('');
  });

  it('synthesizes a minimal stack and retains session on tech-stack failure', async () => {
    const events: AnalysisEvent[] = [];
    const result = await runCodeAnalysisPipeline({
      cwd,
      codingAgent: 'harnext',
      baselineStages: DEFAULT_STAGES,
      phase: 'tech-stack',
      onProgress: (e) => events.push(e),
      runHarnextAgent: async () => 'I did nothing',
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe('tech-stack');
    expect(result.techStack.root.language).toBe('unknown'); // synthesized fallback
    expect(result.sessionDir).not.toBe(''); // retained
    expect(events.some((e) => e.stage === 'tech-stack' && e.status === 'warn')).toBe(true);
    // Clean up the retained session so afterEach rmSync has no trouble.
    rmSync(result.sessionDir, { recursive: true, force: true });
  });

  it('skips tech-stack when a techStack is passed in (reuse path)', async () => {
    const preexisting: TechStack = validTechStackJSON() as TechStack;
    const agent = vi.fn(async () => '');
    const result = await runCodeAnalysisPipeline({
      cwd,
      codingAgent: 'harnext',
      baselineStages: DEFAULT_STAGES,
      phase: 'tech-stack',
      techStack: preexisting,
      runHarnextAgent: agent,
    });

    expect(agent).not.toHaveBeenCalled();
    expect(result.techStack.root.language).toBe('TypeScript');
    // Nothing persisted — the caller owns the reused stack.
    expect(loadTechStack(cwd)).toBeNull();
  });

  it('phase: all — runs every stage in pipeline order', async () => {
    const events: AnalysisEvent[] = [];
    const contract = {
      version: '1',
      riskTierRules: { low: ['**'] },
      mergePolicy: { low: { requiredChecks: ['CI Pipeline', 'risk-policy-gate'] } },
    };
    const result = await runCodeAnalysisPipeline({
      cwd,
      codingAgent: 'harnext',
      baselineStages: DEFAULT_STAGES,
      onProgress: (e) => events.push(e),
      runHarnextAgent: makeStubAgent({
        techStack: () => validTechStackJSON(),
        riskContract: () => contract,
        checkScripts: (prompt) => {
          // Extract missing check entries from the prompt and write
          // one shell script per entry.
          const match = prompt.match(/\[\s*\{[\s\S]*?\}\s*\]/);
          if (!match) return;
          const missing = JSON.parse(match[0]) as { id: string; filePath: string }[];
          for (const entry of missing) {
            writeFileSync(entry.filePath, `#!/usr/bin/env bash\necho ${entry.id}\n`, 'utf-8');
          }
        },
        projectSkills: (prompt) => {
          // The stage now asks the agent to write into a session-scratch
          // dir (so .claude/** permission prompts can't block). The real
          // skills dir is populated by the harness's cpSync promotion
          // step after the agent returns. Mirror that here by writing
          // under the `skillsDir` variable the prompt embeds.
          const match = prompt.match(
            /Skills live under:\s*\n\s*([^\s]+)/,
          );
          const base = match ? match[1] : '';
          if (!base) return;
          for (const slug of ['init']) {
            const dir = join(base, slug);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, 'SKILL.md'),
              `---\nname: ${slug}\ndescription: test\n---\n\nbody`,
              'utf-8',
            );
          }
        },
        stagePrompts: () => ({}), // empty map → baseline stages preserved
      }),
    });

    // Strict phase order enforced by the orchestrator.
    const stageSequence = events
      .filter((e) => e.status === 'start')
      .map((e) => e.stage);
    expect(stageSequence).toEqual([
      'tech-stack',
      'risk-contract',
      'check-scripts',
      'project-skills',
      'stage-prompts',
    ]);

    expect(result.techStack.root.language).toBe('TypeScript');
    expect(result.contract).toEqual(contract);
    expect(result.scriptsGenerated.map((p) => p.split('/').pop()).sort()).toEqual([
      'ci-pipeline.sh',
      'risk-policy-gate.sh',
    ]);
    expect(result.skillsGenerated).toEqual(expect.arrayContaining(['init']));
    // No errors → session dir cleaned.
    expect(result.sessionDir).toBe('');
  });

  it('check-scripts can run standalone by loading contract from disk', async () => {
    // Seed a contract on disk so the stage can pick it up without having
    // run risk-contract in the same pipeline invocation.
    const { saveRiskContract, defaultRiskContract } = await import(
      '../src/code-analysis/schemas/risk-contract.js'
    );
    saveRiskContract(cwd, defaultRiskContract());

    const result = await runCodeAnalysisPipeline({
      cwd,
      codingAgent: 'harnext',
      baselineStages: DEFAULT_STAGES,
      phase: 'check-scripts',
      techStack: validTechStackJSON() as never,
      runHarnextAgent: makeStubAgent({
        checkScripts: (prompt) => {
          const match = prompt.match(/\[\s*\{[\s\S]*?\}\s*\]/);
          if (!match) return;
          const missing = JSON.parse(match[0]) as { filePath: string }[];
          for (const entry of missing) {
            writeFileSync(entry.filePath, '#!/usr/bin/env bash\n', 'utf-8');
          }
        },
      }),
    });

    expect(result.scriptsGenerated.map((p) => p.split('/').pop())).toEqual([
      'ci-pipeline.sh',
    ]);
    expect(result.errors).toEqual([]);
  });
});
