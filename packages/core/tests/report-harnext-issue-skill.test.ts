/**
 * Issue #76: the `/report-harnext-issue` command delegates to a bundled skill
 * that drafts the issue and walks the gh → REST → prefilled-URL fallback chain.
 *
 * This is an integration test over the shipped skill artifact: it parses the
 * real `packages/core/skills/report-harnext-issue/SKILL.md` through the same
 * loader the runtime uses (`loadSkillsFromDir`) and asserts the frontmatter and
 * the behavioral contract from the issue (all three tiers, the hard-coded repo,
 * and the no-secrets guardrail) are actually present in what we ship. The
 * companion `seed.test.ts` covers that this skill is copied into the user dir.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadSkillsFromDir } from '../src/skills.js';

const skillDir = fileURLToPath(new URL('../skills/report-harnext-issue', import.meta.url));

describe('bundled report-harnext-issue skill (issue #76)', () => {
  it('parses with the expected frontmatter and is reserved for the explicit command', () => {
    const { skills, diagnostics } = loadSkillsFromDir(skillDir);
    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);

    const skill = skills[0];
    expect(skill.name).toBe('report-harnext-issue');
    // Reserved for `/report-harnext-issue`, never auto-invoked by the model.
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.description.length).toBeGreaterThan(0);
  });

  it('documents the full fallback chain and the issue guardrails', () => {
    const body = readFileSync(`${skillDir}/SKILL.md`, 'utf-8');

    // Hard-coded target repo (v1 decision in the issue).
    expect(body).toContain('QualityUnit/harnext');

    // Tier 1 — authenticated gh CLI.
    expect(body).toContain('gh issue create --repo QualityUnit/harnext');
    // Tier 2 — REST API with a token from GITHUB_TOKEN / GH_TOKEN.
    expect(body).toContain('api.github.com/repos/QualityUnit/harnext/issues');
    expect(body).toContain('GITHUB_TOKEN');
    expect(body).toContain('GH_TOKEN');
    // Tier 3 — zero-auth prefilled "new issue" URL.
    expect(body).toContain('issues/new?title=');

    // Enrichment context the body must include.
    expect(body).toContain('harnext --version');
    expect(body).toContain('node --version');

    // No-secrets guardrail must be stated.
    expect(body.toLowerCase()).toMatch(/never include secrets|no secrets|never.*secret/);
  });
});
