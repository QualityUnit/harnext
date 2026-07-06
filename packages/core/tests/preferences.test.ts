import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getDefaultMode,
  loadPreferences,
  savePreferences,
  setDefault,
  setDefaultMode,
  setDefaultModel,
  setDefaultProvider,
} from '../src/preferences.js';

describe('preferences', () => {
  let dir: string;
  const original = process.env.HARNEXT_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-prefs-'));
    process.env.HARNEXT_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_AGENT_DIR;
    else process.env.HARNEXT_AGENT_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty object when no preferences file exists', () => {
    expect(loadPreferences()).toEqual({});
  });

  it('persists provider and per-provider model selections', () => {
    setDefaultProvider('openrouter');
    setDefaultModel('openrouter', 'anthropic/claude-opus-4-8');
    const prefs = loadPreferences();
    expect(prefs.defaultProvider).toBe('openrouter');
    expect(prefs.defaultModels?.openrouter).toBe('anthropic/claude-opus-4-8');
  });

  it('setDefault writes provider and model together', () => {
    setDefault('anthropic', 'claude-opus-4-8');
    const prefs = loadPreferences();
    expect(prefs.defaultProvider).toBe('anthropic');
    expect(prefs.defaultModels?.anthropic).toBe('claude-opus-4-8');
  });

  describe('permission mode (issue #56)', () => {
    it('round-trips a saved permission mode', () => {
      expect(getDefaultMode()).toBeUndefined();
      setDefaultMode('plan');
      expect(getDefaultMode()).toBe('plan');
      expect(loadPreferences().defaultMode).toBe('plan');
    });

    it('overwrites the previously saved mode', () => {
      setDefaultMode('plan');
      setDefaultMode('bypassPermissions');
      expect(getDefaultMode()).toBe('bypassPermissions');
    });

    it('ignores an invalid stored mode rather than returning garbage', () => {
      savePreferences({ defaultMode: 'nonsense' as never });
      expect(getDefaultMode()).toBeUndefined();
    });

    it('does not clobber unrelated preferences', () => {
      setDefault('openrouter', 'qwen/qwen3-coder');
      setDefaultMode('acceptEdits');
      const prefs = loadPreferences();
      expect(prefs.defaultProvider).toBe('openrouter');
      expect(prefs.defaultModels?.openrouter).toBe('qwen/qwen3-coder');
      expect(prefs.defaultMode).toBe('acceptEdits');
    });
  });
});
