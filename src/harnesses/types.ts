import type { DetectionResult } from '../core/detector.js';
import type { AIRunner } from '../core/ai-runner.js';
import type { FileWriter } from '../core/file-writer.js';
import type { UserPreferences } from '../prompts/types.js';

export type { UserPreferences } from '../prompts/types.js';

export interface HarnessContext {
  repoRoot: string;
  detection: DetectionResult;
  runner: AIRunner;
  fileWriter: FileWriter;
  userPreferences: UserPreferences;
  previousOutputs: Map<string, HarnessOutput>;
}

export interface HarnessOutput {
  harnessName: string;
  filesCreated: string[];
  filesModified: string[];
  metadata?: Record<string, unknown>;
}

export interface HarnessModule {
  name: string;
  displayName: string;
  description: string;
  order: number;
  isApplicable(ctx: HarnessContext): boolean;
  execute(ctx: HarnessContext): Promise<HarnessOutput>;
}
