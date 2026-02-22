import type { HarnessModule, HarnessContext, HarnessOutput } from './types.js';
import { buildPreCommitHooksPrompt } from '../prompts/pre-commit-hooks.js';
import { buildSystemPrompt } from '../prompts/system.js';

export const preCommitHooksHarness: HarnessModule = {
  name: 'pre-commit-hooks',
  displayName: 'Pre-commit Hooks',
  description: 'Generates pre-commit hook configuration',
  order: 4,

  isApplicable(): boolean {
    return true;
  },

  async execute(ctx: HarnessContext): Promise<HarnessOutput> {
    const prompt = buildPreCommitHooksPrompt(ctx.detection, ctx.userPreferences);
    const systemPrompt = buildSystemPrompt(ctx.runner.platform);

    try {
      const result = await ctx.runner.generate(prompt, systemPrompt);

      const output: HarnessOutput = {
        harnessName: 'pre-commit-hooks',
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        metadata: {
          language: ctx.detection.primaryLanguage,
        },
      };

      ctx.previousOutputs.set('pre-commit-hooks', output);

      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Pre-commit hooks generation failed: ${message}`);
    }
  },
};
