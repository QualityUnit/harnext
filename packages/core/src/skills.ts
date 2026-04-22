import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { CONFIG_DIR_NAME, getProjectSkillsDir, getUserSkillsDir } from './config.js';
import { parseFrontmatter } from './utils/frontmatter.js';

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
  [key: string]: unknown;
}

export interface SkillDiagnostic {
  type: 'warning' | 'collision';
  message: string;
  path: string;
}

export interface LoadSkillsOptions {
  /** Working directory to search for project-local skills. Default: process.cwd(). */
  cwd?: string;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];

  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)');
  }
  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen');
  }
  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens');
  }

  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === '') {
    errors.push('description is required');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }
  return errors;
}

function loadSkillFromFile(
  filePath: string,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  try {
    const rawContent = readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);

    for (const error of validateDescription(frontmatter.description)) {
      diagnostics.push({ type: 'warning', message: error, path: filePath });
    }

    const name = frontmatter.name || parentDirName;

    for (const error of validateName(name, parentDirName)) {
      diagnostics.push({ type: 'warning', message: error, path: filePath });
    }

    if (!frontmatter.description || frontmatter.description.trim() === '') {
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        name,
        description: frontmatter.description,
        filePath,
        baseDir: skillDir,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      },
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to parse skill file';
    diagnostics.push({ type: 'warning', message, path: filePath });
    return { skill: null, diagnostics };
  }
}

/**
 * Walk a skills directory.
 *
 * - If `dir` itself contains SKILL.md, it's treated as a single skill root (no recursion).
 * - Otherwise any top-level `.md` file is loaded as a skill, and subdirectories are
 *   recursively scanned for SKILL.md. Hidden directories and `node_modules` are skipped.
 */
export function loadSkillsFromDir(dir: string): LoadSkillsResult {
  return loadSkillsFromDirInternal(dir, true);
}

function loadSkillsFromDirInternal(dir: string, includeRootFiles: boolean): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return { skills, diagnostics };
  }

  // If this directory itself is a skill root, stop recursion.
  for (const entry of entries) {
    if (entry.name !== 'SKILL.md') continue;

    const fullPath = join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = statSync(fullPath).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;

    const result = loadSkillFromFile(fullPath);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const fullPath = join(dir, entry.name);

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(fullPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      const sub = loadSkillsFromDirInternal(fullPath, false);
      skills.push(...sub.skills);
      diagnostics.push(...sub.diagnostics);
      continue;
    }

    if (!isFile || !includeRootFiles || !entry.name.endsWith('.md')) continue;

    const result = loadSkillFromFile(fullPath);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }

  return { skills, diagnostics };
}

/**
 * Load skills from both the project-local `<cwd>/.harnext/skills/` and the
 * user-wide `~/.harnext/skills/` directories. Project skills are scanned first,
 * so they win on name collisions (first-match-wins). Deduped by resolved real
 * path to handle symlinks.
 */
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
  const cwd = options.cwd ?? process.cwd();

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const diagnostics: SkillDiagnostic[] = [];

  const dirs = [getProjectSkillsDir(cwd), getUserSkillsDir()];
  for (const dir of dirs) {
    const { skills, diagnostics: loadDiagnostics } = loadSkillsFromDirInternal(dir, true);
    diagnostics.push(...loadDiagnostics);

    for (const skill of skills) {
      let realPath: string;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }

      if (realPathSet.has(realPath)) continue;

      const existing = skillMap.get(skill.name);
      if (existing) {
        diagnostics.push({
          type: 'collision',
          message: `skill name "${skill.name}" collision; keeping ${existing.filePath}`,
          path: skill.filePath,
        });
        continue;
      }

      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  }

  return { skills: Array.from(skillMap.values()), diagnostics };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format skills for injection into a system prompt.
 * Skills with `disableModelInvocation` are filtered out — they're reserved for explicit
 * `/skill:<name>` invocation only. Returns "" if no visible skills.
 *
 * Format follows the Agent Skills spec: https://agentskills.io/integrate-skills
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = [
    '',
    '',
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];

  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

// Re-export for convenience so callers can resolve the skills dir without digging into config.
export { CONFIG_DIR_NAME, getProjectSkillsDir };
