import { describe, expect, it } from 'vitest';

import {
  CODING_AGENT_IDS,
  CODING_AGENTS,
  getCodingAgentSpec,
  isCodingAgentId,
  listCodingAgents,
} from '../src/coding-agents.js';

describe('coding-agents registry', () => {
  it('exposes exactly harnext, claude-code, codex', () => {
    expect([...CODING_AGENT_IDS]).toEqual(['harnext', 'claude-code', 'codex']);
  });

  it('has a spec for every registered id', () => {
    for (const id of CODING_AGENT_IDS) {
      const spec = CODING_AGENTS[id];
      expect(spec.id).toBe(id);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('lists agents in registration order', () => {
    expect(listCodingAgents().map((s) => s.id)).toEqual([...CODING_AGENT_IDS]);
  });

  it('gives harnext an empty model list (picker routes through preferences)', () => {
    expect(getCodingAgentSpec('harnext').supportedModels).toEqual([]);
    expect(getCodingAgentSpec('harnext').binary).toBeUndefined();
  });

  it('gives external agents a binary, model-flag, and non-empty model list', () => {
    for (const id of ['claude-code', 'codex'] as const) {
      const spec = getCodingAgentSpec(id);
      expect(spec.binary).toBeTruthy();
      expect(spec.modelFlag).toBeTruthy();
      expect(spec.supportedModels.length).toBeGreaterThan(0);
    }
  });

  it('isCodingAgentId accepts registered ids and rejects strangers', () => {
    expect(isCodingAgentId('harnext')).toBe(true);
    expect(isCodingAgentId('claude-code')).toBe(true);
    expect(isCodingAgentId('codex')).toBe(true);
    expect(isCodingAgentId('cursor')).toBe(false);
    expect(isCodingAgentId(42)).toBe(false);
    expect(isCodingAgentId(undefined)).toBe(false);
  });
});
