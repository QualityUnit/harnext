import { readFile } from 'node:fs/promises';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@sinclair/typebox';

import type { Skill } from '../skills.js';

const skillSchema = Type.Object({
  name: Type.String({
    description: 'The name of the skill to load (as listed in <available_skills>).',
  }),
});

export type SkillToolInput = Static<typeof skillSchema>;

export interface SkillToolDetails {
  name: string;
  found: boolean;
}

export function createSkillTool(
  getSkills: () => Skill[],
): AgentTool<typeof skillSchema, SkillToolDetails> {
  return {
    name: 'skill',
    label: 'skill',
    description:
      "Load a skill's instructions by name. Use this when the task matches the description of a skill listed in <available_skills>. Returns the skill's full SKILL.md, which you should then follow.",
    parameters: skillSchema,
    async execute(_toolCallId, params) {
      const skills = getSkills().filter((s) => !s.disableModelInvocation);
      const skill = skills.find((s) => s.name === params.name);
      if (!skill) {
        const available = skills.map((s) => s.name);
        const hint =
          available.length > 0
            ? `Available skills: ${available.join(', ')}.`
            : 'No skills are loaded.';
        return {
          content: [
            { type: 'text', text: `Unknown skill "${params.name}". ${hint}` },
          ],
          details: { name: params.name, found: false },
        };
      }

      try {
        const content = await readFile(skill.filePath, 'utf-8');
        const text = [
          `<skill name="${skill.name}" location="${skill.filePath}">`,
          `References are relative to ${skill.baseDir}.`,
          '',
          content,
          '</skill>',
        ].join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { name: skill.name, found: true },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: 'text', text: `Error reading skill "${skill.name}": ${msg}` },
          ],
          details: { name: skill.name, found: true },
        };
      }
    },
  };
}
