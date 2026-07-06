/**
 * Issue #76: `/report-harnext-issue <description>` files a GitHub issue against
 * `QualityUnit/harnext` from within harnext, delegating the title/body drafting
 * and the gh → REST → prefilled-URL fallback chain to a bundled skill.
 *
 * Unit-tests that the command is registered/matchable with `acceptsArgs`, and
 * integration-tests the action's wiring: the empty-arg usage guard, skill
 * resolution from the live session, the on-disk fallback when the session copy
 * is absent, and the "skill missing" error path. The skill itself is agent
 * behavior (driven by the model at runtime) so it is not exercised here.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnsureResult, Skill } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SLASH_COMMANDS, findSlashCommand } from '../src/modes/interactive/interactive-mode.js';

const reportCmd = SLASH_COMMANDS.find((c) => c.name === '/report-harnext-issue')!;

/**
 * Minimal CommandContext stub capturing everything the action touches:
 * `writeAbove` output, the `ensureBundledSkills` result, the session's loaded
 * skills, and any `invokeSkill` call. Only the fields the action reads are set.
 */
function fakeCtx(opts: {
  sessionSkills?: Skill[];
  ensure?: () => EnsureResult;
}) {
  const written: string[] = [];
  const invocations: { skill: Skill; args: string; echoLabel: string }[] = [];
  const ensure =
    opts.ensure ??
    (() => ({ target: '/nonexistent-skills-dir', added: [], present: [], diagnostics: [] }));
  const ctx = {
    session: { skills: opts.sessionSkills ?? [] },
    writeAbove: (text: string) => {
      written.push(text);
    },
    ensureBundledSkills: ensure,
    invokeSkill: async (skill: Skill, args: string, echoLabel: string) => {
      invocations.push({ skill, args, echoLabel });
    },
  };
  return { ctx, written, invocations, output: () => written.join('') };
}

describe('/report-harnext-issue registration (issue #76)', () => {
  it('is registered with a description', () => {
    expect(reportCmd).toBeDefined();
    expect(reportCmd.description.toLowerCase()).toMatch(/issue|report/);
  });

  it('accepts trailing args and stays live (no pause)', () => {
    expect(reportCmd.acceptsArgs).toBe(true);
    expect(reportCmd.pause).toBe(false);
  });

  it('matches and extracts the description via findSlashCommand', () => {
    const match = findSlashCommand('/report-harnext-issue the app crashes on startup');
    expect(match?.cmd.name).toBe('/report-harnext-issue');
    expect(match?.args).toBe('the app crashes on startup');
  });

  it('matches the bare command with empty args', () => {
    const match = findSlashCommand('/report-harnext-issue');
    expect(match?.cmd.name).toBe('/report-harnext-issue');
    expect(match?.args).toBe('');
  });
});

describe('/report-harnext-issue action', () => {
  it('prints usage and does nothing else for an empty description', async () => {
    const ensure = vi.fn(
      (): EnsureResult => ({ target: 't', added: [], present: [], diagnostics: [] }),
    );
    const { ctx, invocations, output } = fakeCtx({ ensure });

    const keepRunning = await reportCmd.action(ctx as never, '   ');

    expect(keepRunning).toBe(true);
    expect(output()).toContain('Usage: /report-harnext-issue <description>');
    // The usage guard must short-circuit before seeding or invoking anything.
    expect(ensure).not.toHaveBeenCalled();
    expect(invocations).toHaveLength(0);
  });

  it('invokes the session-loaded skill with the description and command label', async () => {
    const skill: Skill = {
      name: 'report-harnext-issue',
      description: 'file an issue',
      filePath: '/skills/report-harnext-issue/SKILL.md',
      baseDir: '/skills/report-harnext-issue',
      disableModelInvocation: true,
    };
    const { ctx, invocations } = fakeCtx({ sessionSkills: [skill] });

    const keepRunning = await reportCmd.action(ctx as never, 'crash on launch');

    expect(keepRunning).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].skill.name).toBe('report-harnext-issue');
    expect(invocations[0].args).toBe('crash on launch');
    expect(invocations[0].echoLabel).toBe('/report-harnext-issue');
  });

  describe('on-disk fallback when the session has not loaded the skill', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'harnext-report-skill-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('resolves the skill from the seeded file and invokes it', async () => {
      // Seed a SKILL.md under <target>/report-harnext-issue/ so existsSync passes.
      mkdirSync(join(dir, 'report-harnext-issue'), { recursive: true });
      writeFileSync(join(dir, 'report-harnext-issue', 'SKILL.md'), '# report-harnext-issue\n');
      const { ctx, invocations } = fakeCtx({
        sessionSkills: [],
        ensure: () => ({ target: dir, added: ['report-harnext-issue'], present: [], diagnostics: [] }),
      });

      const keepRunning = await reportCmd.action(ctx as never, 'something broke');

      expect(keepRunning).toBe(true);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].skill.name).toBe('report-harnext-issue');
      expect(invocations[0].skill.disableModelInvocation).toBe(true);
      expect(invocations[0].args).toBe('something broke');
    });

    it('errors gracefully (returns true, no invoke) when the skill is nowhere to be found', async () => {
      const { ctx, invocations, output } = fakeCtx({
        sessionSkills: [],
        ensure: () => ({ target: dir, added: [], present: [], diagnostics: [] }),
      });

      const keepRunning = await reportCmd.action(ctx as never, 'help');

      expect(keepRunning).toBe(true);
      expect(invocations).toHaveLength(0);
      expect(output()).toContain('report-harnext-issue skill not available');
    });
  });
});
