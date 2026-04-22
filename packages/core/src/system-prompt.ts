import { formatSkillsForPrompt, type Skill } from './skills.js';

export interface BuildSystemPromptOptions {
  cwd: string;
  customPrompt?: string;
  skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const base = options.customPrompt ?? defaultPrompt(options.cwd);
  const skillsBlock = formatSkillsForPrompt(options.skills ?? []);
  return skillsBlock ? `${base}${skillsBlock}` : base;
}

function defaultPrompt(cwd: string): string {
  const date = new Date().toISOString().split('T')[0];

  return `You are Harnext, an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents with line numbers
- bash: Execute shell commands
- edit: Edit files by replacing exact string matches
- write: Create or overwrite file
Guidelines:
- Be concise in your responses.
- Read files before editing them.
- Use edit for targeted changes (exact string replacement). Use write for new files.
- Run commands with bash. Check results before proceeding.
- Show file paths clearly when referencing code.

Current date: ${date}
Current working directory: ${cwd}`;
}
