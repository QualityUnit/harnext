/**
 * Generate project-specific Agent Skills tailored to the TechStack.
 *
 * This is the Phase 3 replacement for the legacy
 * `packages/core/src/analysis/skills.ts` `generateProjectSkills` —
 * same pattern (agent writes `SKILL.md` directly into the skills dir,
 * we verify frontmatter after) but driven by the bundled YAML prompt
 * and consuming TechStack directly instead of ProjectProfile.
 *
 * Installation of the **bundled** skills (the built-in init / review
 * / browser-verify set) is still a pure file copy — it doesn't invoke
 * an agent and lives in `install-bundled-skills.ts` next door.
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CodingAgentId } from '../../coding-agents.js';
import type { ExternalAgentSpawner } from '../../coding-agent-runner.js';
import { CODE_ANALYSIS_MAX_TURNS, runCodingAgent } from '../run-coding-agent.js';
import { resolveAgentSkillsDir } from './install-bundled-skills.js';
import { loadPrompt, renderPrompt } from '../prompt-loader.js';
import type { SessionDir } from '../session-dir.js';
import type { TechStack } from '../types.js';

export const DEFAULT_GENERATED_SKILL_SLUGS = ['init'];

const SLUG_DESCRIPTIONS: Record<string, string> = {
  init: [
    "Project-specific startup + repository tour. Must be grounded in a deep read of the repo — NOT just a launch-commands cheatsheet.",
    'Before writing anything, investigate the repo by reading its actual files:',
    '  (a) Find every manifest at the root and inside each package directory — package.json, yarn.lock/pnpm-workspace.yaml, pyproject.toml/poetry.lock, requirements.txt, composer.json, go.mod, Cargo.toml, Gemfile, build.gradle, pom.xml, Makefile, Dockerfile, docker-compose*.yml — and read each one end-to-end. The manifest is authoritative for install/build/test commands; copy them verbatim, never paraphrase.',
    '  (b) Walk the actual source tree of every runnable app (not pure libraries). For backend apps, locate where the HTTP framework mounts routes (FastAPI `APIRouter`, Express `app.use`/`router`, Django `urls.py`, Rails `routes.rb`, Flask blueprints, NestJS controllers, Laravel `routes/*.php`, Go chi/gin router files) and list the top-level route groups by path + source file. For frontend apps, locate the routing entry (Next.js `app/`/`pages/`, React Router config, Vue Router, SvelteKit `routes/`) and list the top-level routes + their file paths.',
    '  (c) Read any `scripts/`, `bin/`, `Makefile`, or CI workflow files (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `circle.yml`) — they usually reveal canonical install/build/test/start sequences the manifests alone do not spell out.',
    '  (d) Note the env vars referenced in code (grep for `process.env.`, `os.environ`, `getenv(`, `ENV[`) and cross-check against `.env.example` / `.env.sample` / `config/` — the skill should list every env var the app needs to boot, not only what is in `.env.example`.',
    'Write the skill as a repository tour + runbook:',
    "  - Top section: a 3–6 line overview naming each runnable app, its language/framework, its port if statically configured, and a one-line description (what it does — not just 'the frontend').",
    '  - One subsection per runnable app with (in order): source path, install command, start-in-background command (detached via `nohup <cmd> >> .harnext/logs/<app>.log 2>&1 &` so the agent bash call returns immediately), tail command (`tail -n 200 .harnext/logs/<app>.log` — never `tail -f` from an agent), stop command, env vars required to boot (with source file paths), key endpoints or entry routes grouped by prefix (with source file paths), and any known boot-order dependencies (databases, caches, message queues — reference the docker-compose service names if present).',
    "  - For monorepos, cover every runnable package — miss none. 'Runnable' = has a dev/start/run target in its manifest OR a Dockerfile with a CMD/ENTRYPOINT. Skip pure libraries (note them briefly under the overview only).",
    'Never guess a command. If the repo does not specify it, omit that field and note the omission in a short "Unknown — confirm with the team" note rather than inventing one.',
  ].join('\n'),
};

export interface RunProjectSkillsStageOptions {
  cwd: string;
  codingAgent: CodingAgentId;
  codingAgentModel?: string;
  session: SessionDir;
  techStack: TechStack;
  /** Slugs to request. Defaults to `DEFAULT_GENERATED_SKILL_SLUGS`. */
  skillSlugs?: string[];
  spawner?: ExternalAgentSpawner;
  runHarnextAgent?: (prompt: string, cwd: string) => Promise<string>;
  onActivity?: (line: string) => void;
}

export interface RunProjectSkillsStageResult {
  /** Absolute path of the skills dir for the active coding agent. */
  target: string;
  /** Slugs that ended up with a well-formed SKILL.md (frontmatter present). */
  generated: string[];
  /** Slugs we asked for but the agent didn't produce (or produced malformed). */
  missing: string[];
  /** Populated on spawn failure / agent error. */
  error?: string;
}

/**
 * Frontmatter sanity check — the skills loader does stricter validation
 * at runtime; this is a fast pass to reject obviously broken files.
 */
export function hasValidFrontmatter(content: string): boolean {
  if (!content.startsWith('---')) return false;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return false;
  const block = content.slice(3, end);
  const hasName = /^\s*name\s*:\s*\S+/m.test(block);
  const hasDesc = /^\s*description\s*:\s*\S+/m.test(block);
  return hasName && hasDesc;
}

export async function runProjectSkillsStage(
  opts: RunProjectSkillsStageOptions,
): Promise<RunProjectSkillsStageResult> {
  const target = resolveAgentSkillsDir(opts.cwd, opts.codingAgent);
  mkdirSync(target, { recursive: true });

  const slugs = opts.skillSlugs ?? DEFAULT_GENERATED_SKILL_SLUGS;
  const slugsList = slugs
    .map((slug) => {
      const d = SLUG_DESCRIPTIONS[slug] ?? '';
      return `  - ${slug}${d ? ` — ${d}` : ''}`;
    })
    .join('\n');

  // Stage agent writes into the session scratch dir, not directly into
  // the real target. Why:
  //   - For `claude-code`, the real target is `.claude/skills/` — inside
  //     its *own* config dir, which its permission system refuses writes
  //     to even with `--dangerously-skip-permissions`. The agent would
  //     loop and fail.
  //   - For any agent, a two-phase write (agent → scratch, harness →
  //     target) means we can validate each SKILL.md before promoting it
  //     and never leave partial files in the real skills dir.
  const stagedDir = opts.session.pathFor('project-skills', 'skills');
  mkdirSync(stagedDir, { recursive: true });

  const prompt = renderPrompt(loadPrompt('project-skills'), {
    skillsDir: stagedDir,
    slugsList,
    techStackJson: JSON.stringify(opts.techStack, null, 2),
    sessionDir: opts.session.root,
    cwd: opts.cwd,
  });

  const { error } = await runCodingAgent({
    cwd: opts.cwd,
    codingAgent: opts.codingAgent,
    codingAgentModel: opts.codingAgentModel,
    prompt,
    maxTurns: CODE_ANALYSIS_MAX_TURNS,
    spawner: opts.spawner,
    runHarnextAgent: opts.runHarnextAgent,
    onActivity: opts.onActivity,
  });

  if (error) {
    opts.session.appendManifest({ stage: 'project-skills', outputs: [stagedDir] });
    return {
      target,
      generated: [],
      missing: slugs.slice(),
      error,
    };
  }

  const generated: string[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const staged = join(stagedDir, slug, 'SKILL.md');
    if (!existsSync(staged)) {
      missing.push(slug);
      continue;
    }
    try {
      const raw = readFileSync(staged, 'utf-8');
      if (!hasValidFrontmatter(raw)) {
        missing.push(slug);
        continue;
      }
      // Promote the staged skill into the real target. Preserves user
      // edits: if the target already has this slug, leave it alone
      // (same policy as `installBundledSkills` at
      // `install-bundled-skills.ts:91`).
      const destDir = join(target, slug);
      if (existsSync(destDir)) {
        // Already present — treat as generated so the caller sees it
        // in the "present" column, even though we didn't copy over it.
        generated.push(slug);
        continue;
      }
      cpSync(join(stagedDir, slug), destDir, { recursive: true });
      generated.push(slug);
    } catch {
      missing.push(slug);
    }
  }

  opts.session.appendManifest({ stage: 'project-skills', outputs: [stagedDir] });
  return { target, generated, missing };
}
