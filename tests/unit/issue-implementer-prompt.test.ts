import { buildIssueImplementerPrompt } from '../../src/prompts/issue-implementer.js';
import type { DetectionResult } from '../../src/core/detector.js';
import type { UserPreferences } from '../../src/prompts/types.js';

const baseDetection: DetectionResult = {
  primaryLanguage: 'typescript',
  languages: ['typescript'],
  hasTypeScript: true,
  framework: 'next',
  packageManager: 'npm',
  testFramework: 'vitest',
  linter: 'eslint',
  formatter: 'prettier',
  typeChecker: 'tsc',
  buildTool: 'tsup',
  ciProvider: 'github-actions',
  existingDocs: [],
  existingClaude: false,
  architecturalLayers: [],
  monorepo: false,
  testCommand: 'npm test',
  buildCommand: 'npm run build',
  lintCommand: 'npm run lint',
  hasUIComponents: false,
  criticalPaths: [],
};

const basePrefs: UserPreferences = {
  ciProvider: 'github-actions',
  aiPlatform: 'claude',
  strictnessLevel: 'standard',
  selectedHarnesses: ['issue-implementer'],
};

describe('buildIssueImplementerPrompt', () => {
  it('should include agent-pr label in gh pr create command', () => {
    const result = buildIssueImplementerPrompt(baseDetection, basePrefs);
    expect(result).toContain('--label "agent-pr"');
  });

  it('should use explicit gh pr create syntax for PR creation', () => {
    const result = buildIssueImplementerPrompt(baseDetection, basePrefs);
    expect(result).toContain('gh pr create');
    expect(result).toContain('--base');
    // stderr must NOT be redirected — errors must be visible in CI logs
    expect(result).not.toContain('2>&1)');
  });

  it('should mention agent-pr label for GitLab CI provider', () => {
    const result = buildIssueImplementerPrompt(baseDetection, {
      ...basePrefs,
      ciProvider: 'gitlab-ci',
    });
    expect(result).toContain('agent-pr');
  });
});
