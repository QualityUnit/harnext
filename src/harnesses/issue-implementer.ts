import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { INSTRUCTION_FILES } from '../core/ai-runner.js';
import { buildIssueImplementerPrompt } from '../prompts/issue-implementer.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const issueImplementerHarness: HarnessModule = {
  name: 'issue-implementer',
  displayName: 'Issue Implementer Agent',
  description: 'Generates a workflow that spawns an AI agent to implement new issues automatically',
  order: 16,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const instructionFile = INSTRUCTION_FILES[ctx.runner.platform];
    const prompt = buildIssueImplementerPrompt(ctx.detection, ctx.userPreferences, instructionFile);
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);

    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);

      const output: HarnessOutput = {
        harnessName: 'issue-implementer',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: {
          targetFiles: [
            '.github/workflows/issue-implementer.yml',
            'scripts/issue-implementer-guard.ts',
          ],
          promptFile: '.codefactory/prompts/issue-implementer.md',
        },
      };

      ctx.previousOutputs.set('issue-implementer', output);

      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Issue implementer generation failed: ${message}`);
    }
  },
};
