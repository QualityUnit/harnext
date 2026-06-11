import { describe, expect, it } from 'vitest';

import { highlightSlashCommands } from '../src/cli/input.js';

/**
 * `highlightSlashCommands` colorizes recognized slash-command tokens in the
 * input so the user sees they are special. The rules it must hold:
 *  - only tokens that *exactly* match a known command are wrapped;
 *  - matching works wherever the token appears, not just at the start;
 *  - the wrapping is zero-width (ANSI only), so the visible text is unchanged.
 */
const ESC = '\x1B[';
const ACCENT = `${ESC}38;5;74m`;
const RESET = `${ESC}39m`;

const COMMANDS = new Set(['/model', '/goal', '/compact', '/skill:foo']);

// Strip ANSI to recover the visible characters.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

describe('highlightSlashCommands', () => {
  it('wraps a known command that is the whole input', () => {
    expect(highlightSlashCommands('/goal', COMMANDS)).toBe(`${ACCENT}/goal${RESET}`);
  });

  it('wraps a known command embedded mid-prompt', () => {
    expect(highlightSlashCommands('please run /goal now', COMMANDS)).toBe(
      `please run ${ACCENT}/goal${RESET} now`,
    );
  });

  it('wraps namespaced skill commands (/skill:foo)', () => {
    expect(highlightSlashCommands('use /skill:foo here', COMMANDS)).toBe(
      `use ${ACCENT}/skill:foo${RESET} here`,
    );
  });

  it('highlights multiple known commands in one line', () => {
    expect(highlightSlashCommands('/model then /goal', COMMANDS)).toBe(
      `${ACCENT}/model${RESET} then ${ACCENT}/goal${RESET}`,
    );
  });

  it('leaves an unknown /token untouched', () => {
    expect(highlightSlashCommands('unknown /foo cmd', COMMANDS)).toBe('unknown /foo cmd');
  });

  it('does not highlight a partially typed command', () => {
    expect(highlightSlashCommands('/goa', COMMANDS)).toBe('/goa');
  });

  it('does not highlight a command that is a prefix of the typed token', () => {
    // "/goalsetter" is not the command "/goal", so it must not be colorized.
    expect(highlightSlashCommands('/goalsetter', COMMANDS)).toBe('/goalsetter');
  });

  it('returns text unchanged when there is no slash', () => {
    expect(highlightSlashCommands('just some text', COMMANDS)).toBe('just some text');
  });

  it('returns text unchanged when no commands are registered', () => {
    expect(highlightSlashCommands('/goal', new Set())).toBe('/goal');
  });

  it('preserves the visible text exactly (zero-width wrapping)', () => {
    const input = 'run /goal then /model and /foo';
    expect(stripAnsi(highlightSlashCommands(input, COMMANDS))).toBe(input);
  });
});
