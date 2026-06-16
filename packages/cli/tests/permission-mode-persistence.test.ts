/**
 * Integration test for issue #56: the permission mode chosen interactively
 * (Shift+Tab) must persist and be restored as the starting mode of the next
 * session. Exercises the real seam end-to-end:
 *
 *   onShiftTab → setDefaultMode (persist to ~/.harnext/agent/preferences.json)
 *   next launch → main.ts resolves `--permission-mode flag ?? getDefaultMode()`
 *   runInteractiveMode → toUiMode(...) narrows to a UI mode
 *
 * Uses a temp HARNEXT_AGENT_DIR so the real user preferences are untouched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDefaultMode, setDefaultMode, type PermissionMode } from '@harnext/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toUiMode } from '../src/modes/interactive/interactive-mode.js';

/** Mirror main.ts: CLI flag wins, else the persisted mode, narrowed for the UI. */
function resolveStartMode(flag: PermissionMode | undefined): string {
  return toUiMode(flag ?? getDefaultMode());
}

describe('permission mode persistence (issue #56)', () => {
  let dir: string;
  const original = process.env.HARNEXT_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnext-mode-'));
    process.env.HARNEXT_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HARNEXT_AGENT_DIR;
    else process.env.HARNEXT_AGENT_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to acceptEdits when nothing is persisted and no flag is given', () => {
    expect(resolveStartMode(undefined)).toBe('acceptEdits');
  });

  it('restores the mode last selected via Shift+Tab', () => {
    // Simulate the user cycling to plan mode and exiting.
    setDefaultMode('plan');
    // Next launch with no --permission-mode flag.
    expect(resolveStartMode(undefined)).toBe('plan');
  });

  it('restores bypassPermissions across a restart', () => {
    setDefaultMode('bypassPermissions');
    expect(resolveStartMode(undefined)).toBe('bypassPermissions');
  });

  it('lets an explicit --permission-mode flag override the saved mode', () => {
    setDefaultMode('bypassPermissions');
    expect(resolveStartMode('plan')).toBe('plan');
  });

  it('narrows a persisted non-UI mode (e.g. dontAsk) to acceptEdits', () => {
    setDefaultMode('dontAsk');
    expect(getDefaultMode()).toBe('dontAsk');
    expect(resolveStartMode(undefined)).toBe('acceptEdits');
  });
});
