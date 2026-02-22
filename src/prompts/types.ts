export type { DetectionResult } from '../core/detector.js';
import type { AIPlatform } from '../core/ai-runner.js';

export interface UserPreferences {
  ciProvider: 'github-actions' | 'gitlab-ci' | 'bitbucket';
  aiPlatform: AIPlatform;
  strictnessLevel: 'relaxed' | 'standard' | 'strict';
  selectedHarnesses: string[];
  customCriticalPaths?: string[];
}
