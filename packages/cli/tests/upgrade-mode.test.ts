import { describe, expect, it, vi } from 'vitest';

import {
  compareVersions,
  runUpgradeMode,
  shellRefreshCommand,
  type UpgradeModeDeps,
} from '../src/modes/upgrade-mode.js';

describe('shellRefreshCommand', () => {
  it.each([
    ['/bin/zsh', 'rehash'],
    ['/usr/bin/zsh', 'rehash'],
    ['/bin/bash', 'hash -r'],
    ['/usr/bin/dash', 'hash -r'],
    ['/bin/sh', 'hash -r'],
    [undefined, 'hash -r'],
    ['', 'hash -r'],
    ['/unknown/weird-shell', 'hash -r'],
  ])('maps %s to %s', (shell, expected) => {
    expect(shellRefreshCommand(shell)).toBe(expected);
  });

  it('returns null for fish (auto-rescans PATH)', () => {
    expect(shellRefreshCommand('/usr/local/bin/fish')).toBeNull();
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.2.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-rc.2', '1.0.0-rc.1', 1],
  ])('compareVersions(%s, %s) → %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

function makeDeps(overrides: Partial<UpgradeModeDeps> = {}): {
  deps: UpgradeModeDeps;
  out: string[];
  err: string[];
  npmCalls: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const npmCalls: string[] = [];
  const deps: UpgradeModeDeps = {
    log: (line) => out.push(line),
    errLog: (line) => err.push(line),
    fetchLatest: async () => '1.0.0',
    npm: {
      run: async (target) => {
        npmCalls.push(target);
        return 0;
      },
    },
    currentVersion: '1.0.0',
    ...overrides,
  };
  return { deps, out, err, npmCalls };
}

describe('runUpgradeMode', () => {
  it('reports already-on-latest and skips npm install', async () => {
    const { deps, out, npmCalls } = makeDeps();
    const exit = await runUpgradeMode({}, deps);
    expect(exit).toBe(0);
    expect(npmCalls).toEqual([]);
    expect(out.join('\n')).toMatch(/Already on the latest/);
  });

  it('runs npm install when an upgrade is available', async () => {
    const { deps, out, npmCalls } = makeDeps({
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.2.3',
    });
    const exit = await runUpgradeMode({}, deps);
    expect(exit).toBe(0);
    expect(npmCalls).toEqual(['harnext@1.2.3']);
    expect(out.join('\n')).toMatch(/Upgrading.*1\.0\.0.*1\.2\.3/);
    expect(out.join('\n')).toMatch(/Installed harnext@1\.2\.3/);
  });

  it('prints a shell-refresh hint after a successful install (zsh)', async () => {
    const { deps, out } = makeDeps({
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.2.3',
      shell: '/bin/zsh',
    });
    await runUpgradeMode({}, deps);
    expect(out.join('\n')).toMatch(/run 'rehash'/);
  });

  it('prints a shell-refresh hint after a successful install (bash)', async () => {
    const { deps, out } = makeDeps({
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.2.3',
      shell: '/bin/bash',
    });
    await runUpgradeMode({}, deps);
    expect(out.join('\n')).toMatch(/run 'hash -r'/);
  });

  it('omits the shell-refresh hint for fish', async () => {
    const { deps, out } = makeDeps({
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.2.3',
      shell: '/usr/local/bin/fish',
    });
    await runUpgradeMode({}, deps);
    expect(out.join('\n')).not.toMatch(/to refresh it/);
  });

  it('skips the hint when no install happened', async () => {
    const { deps, out } = makeDeps({ shell: '/bin/zsh' });
    await runUpgradeMode({}, deps);
    expect(out.join('\n')).not.toMatch(/rehash/);
  });

  it('does not downgrade when local is ahead of npm latest', async () => {
    const { deps, out, npmCalls } = makeDeps({
      currentVersion: '2.0.0-dev',
      fetchLatest: async () => '1.0.0',
    });
    const exit = await runUpgradeMode({}, deps);
    expect(exit).toBe(0);
    expect(npmCalls).toEqual([]);
    expect(out.join('\n')).toMatch(/ahead of npm latest/);
    expect(out.join('\n')).toMatch(/--force/);
  });

  it('--force reinstalls even when already on latest', async () => {
    const { deps, npmCalls } = makeDeps();
    const exit = await runUpgradeMode({ force: true }, deps);
    expect(exit).toBe(0);
    expect(npmCalls).toEqual(['harnext@1.0.0']);
  });

  it('--check prints the available upgrade without installing', async () => {
    const { deps, out, npmCalls } = makeDeps({
      currentVersion: '1.0.0',
      fetchLatest: async () => '1.1.0',
    });
    const exit = await runUpgradeMode({ check: true }, deps);
    expect(exit).toBe(0);
    expect(npmCalls).toEqual([]);
    expect(out.join('\n')).toMatch(/upgrade is available: 1\.0\.0 → 1\.1\.0/);
  });

  it('returns 1 and logs to stderr when the registry fetch fails', async () => {
    const { deps, err, npmCalls } = makeDeps({
      fetchLatest: async () => {
        throw new Error('ENETUNREACH');
      },
    });
    const exit = await runUpgradeMode({}, deps);
    expect(exit).toBe(1);
    expect(npmCalls).toEqual([]);
    expect(err.join('\n')).toMatch(/Could not check the npm registry: ENETUNREACH/);
  });

  it('returns the npm exit code when npm install fails', async () => {
    const { deps, err } = makeDeps({
      fetchLatest: async () => '1.1.0',
      npm: {
        run: vi.fn(async () => 13),
      },
    });
    const exit = await runUpgradeMode({}, deps);
    expect(exit).toBe(13);
    expect(err.join('\n')).toMatch(/npm install exited with code 13/);
  });
});
