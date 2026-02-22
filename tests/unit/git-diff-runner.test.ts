import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseAndWriteTextOutput } from '../../src/core/git-diff-runner.js';

describe('parseAndWriteTextOutput()', () => {
  const tmpDir = join(import.meta.dirname, '__tmp_git_diff_test');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should parse "File: <path>" headers and write files', () => {
    const text = [
      'Here are the generated files:',
      '',
      'File: .github/workflows/planner.yml',
      'name: Issue Planner Agent',
      'on:',
      '  issues:',
      '    types: [labeled]',
      'jobs:',
      '  plan:',
      '    runs-on: ubuntu-latest',
      '',
      'File: scripts/guard.ts',
      '#!/usr/bin/env npx tsx',
      'export function evaluate() {',
      '  return { shouldPlan: true };',
      '}',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(2);
    expect(readFileSync(join(tmpDir, '.github/workflows/planner.yml'), 'utf-8')).toContain(
      'Issue Planner Agent',
    );
    expect(readFileSync(join(tmpDir, 'scripts/guard.ts'), 'utf-8')).toContain(
      'export function evaluate',
    );
  });

  it('should strip wrapping code fences around file content', () => {
    const text = [
      'File: .github/workflows/ci.yml',
      '```yaml',
      'name: CI Pipeline',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '```',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(1);
    const content = readFileSync(join(tmpDir, '.github/workflows/ci.yml'), 'utf-8');
    expect(content).toContain('name: CI Pipeline');
    expect(content).not.toContain('```');
  });

  it('should handle markdown heading prefixes on file paths', () => {
    const text = [
      '### .github/workflows/triage.yml',
      'name: Triage',
      'on: issues',
      'jobs:',
      '  triage:',
      '    runs-on: ubuntu-latest',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(1);
    expect(readFileSync(join(tmpDir, '.github/workflows/triage.yml'), 'utf-8')).toContain(
      'name: Triage',
    );
  });

  it('should handle "# File: <path>" prefix', () => {
    const text = [
      '# File: scripts/planner-guard.ts',
      '#!/usr/bin/env npx tsx',
      'console.log("planner guard running");',
      'export const TRIGGER = "agent:plan";',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(1);
    expect(readFileSync(join(tmpDir, 'scripts/planner-guard.ts'), 'utf-8')).toContain('TRIGGER');
  });

  it('should skip files in the skip set', () => {
    const text = [
      'File: .github/workflows/a.yml',
      'name: A',
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '',
      'File: .github/workflows/b.yml',
      'name: B',
      'on: push',
      'jobs:',
      '  b:',
      '    runs-on: ubuntu-latest',
    ].join('\n');

    const skip = new Set(['.github/workflows/a.yml']);
    const written = parseAndWriteTextOutput(text, tmpDir, skip);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('b.yml');
  });

  it('should skip content below minimum length threshold', () => {
    const text = [
      'File: .github/workflows/tiny.yml',
      'name: Tiny',
      '', // too short after trim
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);
    expect(written).toHaveLength(0);
  });

  it('should handle three files (planner-like output)', () => {
    const text = [
      'I will create three files for the issue planner.',
      '',
      'File: .github/workflows/issue-planner.yml',
      'name: Issue Planner Agent',
      'on:',
      '  issues:',
      '    types: [labeled]',
      '  workflow_dispatch:',
      '    inputs:',
      '      issue_number:',
      '        required: true',
      '',
      'File: scripts/issue-planner-guard.ts',
      '#!/usr/bin/env npx tsx',
      'export interface PlannerDecision {',
      '  shouldPlan: boolean;',
      '  issueNumber: number;',
      '}',
      'export function evaluate() { return { shouldPlan: true }; }',
      '',
      'File: .codefactory/prompts/issue-planner.md',
      '# Issue Planner Agent Instructions',
      '',
      'You are a planning agent. Your task is to analyze a GitHub issue.',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);
    expect(written).toHaveLength(3);
  });

  it('should not match paths without a slash (no subdirectory)', () => {
    const text = [
      'File: README.md',
      'This is a readme file with enough content to pass the minimum length check.',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);
    expect(written).toHaveLength(0);
  });

  it('should return empty array when no file patterns found', () => {
    const text = 'Done generating files. All tasks completed successfully.';
    const written = parseAndWriteTextOutput(text, tmpDir);
    expect(written).toHaveLength(0);
  });

  it('should strip ANSI escape codes before matching headers', () => {
    const text = [
      '\x1b[38;5;252m\x1b[1m# Generated Issue Planner Agent System\x1b[0m\x1b[0m',
      '\x1b[0m\x1b[0m',
      '\x1b[38;5;252m\x1b[1m## File: .github/workflows/issue-planner.yml\x1b[0m\x1b[0m',
      '\x1b[0m\x1b[0m',
      '\x1b[1myaml',
      '\x1b[0m\x1b[38;5;10mname: Issue Planner Agent',
      'on:',
      '  issues:',
      '    types: [labeled]',
      'jobs:',
      '  plan:',
      '    runs-on: ubuntu-latest',
      '\x1b[0m\x1b[0m',
      '\x1b[38;5;252m\x1b[1m## File: scripts/issue-planner-guard.ts\x1b[0m\x1b[0m',
      '\x1b[0m\x1b[0m',
      '\x1b[1mtypescript',
      '\x1b[0m\x1b[38;5;10m#!/usr/bin/env npx tsx',
      'export function evaluate() {',
      '  return { shouldPlan: true, reason: "Ready for planning" };',
      '}',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(2);
    const yml = readFileSync(join(tmpDir, '.github/workflows/issue-planner.yml'), 'utf-8');
    expect(yml).toContain('name: Issue Planner Agent');
    expect(yml).not.toContain('yaml'); // language identifier should be stripped
    expect(yml).not.toContain('\x1b'); // ANSI codes should be stripped

    const ts = readFileSync(join(tmpDir, 'scripts/issue-planner-guard.ts'), 'utf-8');
    expect(ts).toContain('export function evaluate');
    expect(ts).not.toContain('typescript'); // language identifier should be stripped
  });

  it('should skip bare language identifiers rendered by kiro-cli', () => {
    const text = [
      'File: .github/workflows/ci.yml',
      'yaml',
      'name: CI',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
    ].join('\n');

    const written = parseAndWriteTextOutput(text, tmpDir);

    expect(written).toHaveLength(1);
    const content = readFileSync(join(tmpDir, '.github/workflows/ci.yml'), 'utf-8');
    expect(content).toContain('name: CI');
    expect(content).not.toMatch(/^yaml\n/); // language identifier should be stripped
  });
});
