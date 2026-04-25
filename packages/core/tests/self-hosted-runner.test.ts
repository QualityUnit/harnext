import { describe, expect, it } from 'vitest';

import {
  buildArchiveName,
  buildTarballUrl,
  checkPublicRepoApprovalGate,
  defaultRunnerLabels,
  defaultRunnerName,
  deregisterRunner,
  getRemoteRunnerStatus,
  getRunnerInstallDir,
  getRunnerMetadataPath,
  installRunner,
  installRunnerService,
  loadRunnerMetadata,
  registerRunner,
  type RunnerMetadata,
  type SelfHostedRunnerShims,
} from '../src/self-hosted-runner.js';
import { getProjectStateDir } from '../src/config.js';

interface StubFs {
  files: Map<string, string>;
  removed: string[];
}

function makeStubFs(): StubFs {
  return { files: new Map(), removed: [] };
}

function makeFsShims(fs: StubFs): Pick<
  SelfHostedRunnerShims,
  'ensureDir' | 'pathExists' | 'removePath' | 'readFile' | 'writeFile'
> {
  return {
    ensureDir: () => {},
    pathExists: (p) => fs.files.has(p),
    removePath: (p) => {
      fs.removed.push(p);
      // Also strip everything that lives under the removed prefix so
      // re-checks behave like the real `rmSync({ recursive: true })`.
      for (const key of [...fs.files.keys()]) {
        if (key === p || key.startsWith(p + '/')) fs.files.delete(key);
      }
    },
    readFile: (p) => {
      const v = fs.files.get(p);
      if (v === undefined) throw new Error(`stub fs: no file at ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      fs.files.set(p, c);
    },
  };
}

const TEST_CWD = '/tmp/proj-self-hosted-test';

describe('buildArchiveName / buildTarballUrl', () => {
  it('produces the canonical actions/runner archive name', () => {
    expect(buildArchiveName('linux', 'x64', '2.321.0')).toBe(
      'actions-runner-linux-x64-2.321.0.tar.gz',
    );
    expect(buildArchiveName('osx', 'arm64', '2.321.0')).toBe(
      'actions-runner-osx-arm64-2.321.0.tar.gz',
    );
  });

  it('builds the github.com release download URL', () => {
    expect(buildTarballUrl('linux', 'x64', '2.321.0')).toBe(
      'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz',
    );
  });
});

describe('defaultRunnerName / defaultRunnerLabels', () => {
  it('derives a stable per-project runner name and label set', () => {
    const name = defaultRunnerName(TEST_CWD);
    expect(name).toMatch(/^harnext-[0-9a-f]{12}$/);
    const labels = defaultRunnerLabels(TEST_CWD);
    expect(labels[0]).toBe('self-hosted');
    expect(labels[1]).toBe('harnext');
    expect(labels[2]).toBe(name);
  });

  it('two different project paths produce different runner names', () => {
    expect(defaultRunnerName('/a/proj')).not.toBe(defaultRunnerName('/b/proj'));
  });
});

describe('installRunner', () => {
  function baseShims(fs: StubFs, calls: { downloads: string[]; extracts: string[] }) {
    return {
      ...makeFsShims(fs),
      detectPlatform: () => 'linux' as const,
      detectArch: () => 'x64' as const,
      releaseLookup: async () => ({
        version: '2.321.0',
        archiveName: 'actions-runner-linux-x64-2.321.0.tar.gz',
        tarballUrl: 'https://example.invalid/runner.tar.gz',
        sha256: 'abc123',
      }),
      download: async (url: string, dest: string) => {
        calls.downloads.push(`${url} -> ${dest}`);
        fs.files.set(dest, 'tarball-bytes');
      },
      sha256: async () => 'abc123',
      extractTarball: async (tarball: string, dest: string) => {
        calls.extracts.push(`${tarball} -> ${dest}`);
        fs.files.set(`${dest}/config.sh`, '#!/bin/sh');
        fs.files.set(`${dest}/svc.sh`, '#!/bin/sh');
      },
    } satisfies SelfHostedRunnerShims;
  }

  it('downloads, verifies, extracts on a clean install', async () => {
    const fs = makeStubFs();
    const calls = { downloads: [] as string[], extracts: [] as string[] };
    const shims = baseShims(fs, calls);
    const result = await installRunner(TEST_CWD, shims);
    expect(result.alreadyInstalled).toBe(false);
    expect(result.installDir).toBe(getRunnerInstallDir(TEST_CWD));
    expect(calls.downloads).toHaveLength(1);
    expect(calls.extracts).toHaveLength(1);
    expect(fs.files.has(`${result.installDir}/config.sh`)).toBe(true);
    expect(fs.files.get(`${result.installDir}/.harnext-runner-version`)).toBe('2.321.0');
  });

  it('is idempotent when the same version is already installed', async () => {
    const fs = makeStubFs();
    const calls = { downloads: [] as string[], extracts: [] as string[] };
    fs.files.set(`${getRunnerInstallDir(TEST_CWD)}/config.sh`, '#!/bin/sh');
    fs.files.set(`${getRunnerInstallDir(TEST_CWD)}/.harnext-runner-version`, '2.321.0');
    const result = await installRunner(TEST_CWD, baseShims(fs, calls));
    expect(result.alreadyInstalled).toBe(true);
    expect(calls.downloads).toHaveLength(0);
    expect(calls.extracts).toHaveLength(0);
  });

  it('throws and removes the tarball on checksum mismatch', async () => {
    const fs = makeStubFs();
    const calls = { downloads: [] as string[], extracts: [] as string[] };
    const shims: SelfHostedRunnerShims = {
      ...baseShims(fs, calls),
      sha256: async () => 'WRONG',
    };
    await expect(installRunner(TEST_CWD, shims)).rejects.toThrow(/checksum mismatch/);
    expect(calls.extracts).toHaveLength(0);
    expect(fs.removed.some((p) => p.endsWith('.tar.gz'))).toBe(true);
  });
});

describe('registerRunner', () => {
  function setupInstalled(fs: StubFs) {
    const installDir = getRunnerInstallDir(TEST_CWD);
    fs.files.set(`${installDir}/config.sh`, '#!/bin/sh');
    fs.files.set(`${installDir}/svc.sh`, '#!/bin/sh');
  }

  it('fetches a registration token, runs config.sh, persists metadata', async () => {
    const fs = makeStubFs();
    setupInstalled(fs);
    const ghCalls: string[][] = [];
    const execCalls: { binary: string; args: string[]; cwd: string }[] = [];
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: (args) => {
        ghCalls.push(args);
        return { ok: true, value: 'AAAATOKEN\n' };
      },
      exec: async (binary, args, cwd) => {
        execCalls.push({ binary, args, cwd });
        return { exit: 0, stdout: 'configured', stderr: '' };
      },
    };
    const meta = await registerRunner(
      { cwd: TEST_CWD, repo: 'owner/repo' },
      shims,
    );
    expect(ghCalls[0]).toEqual([
      'api',
      '--method',
      'POST',
      'repos/owner/repo/actions/runners/registration-token',
      '--jq',
      '.token',
    ]);
    expect(execCalls[0].binary).toBe('./config.sh');
    expect(execCalls[0].args).toContain('--token');
    expect(execCalls[0].args).toContain('AAAATOKEN');
    expect(execCalls[0].args).toContain('--unattended');
    expect(execCalls[0].args).toContain('--replace');
    expect(execCalls[0].args[execCalls[0].args.indexOf('--name') + 1]).toBe(
      defaultRunnerName(TEST_CWD),
    );
    expect(execCalls[0].args[execCalls[0].args.indexOf('--labels') + 1]).toBe(
      defaultRunnerLabels(TEST_CWD).join(','),
    );
    expect(meta.repo).toBe('owner/repo');
    expect(meta.runnerName).toBe(defaultRunnerName(TEST_CWD));
    expect(meta.serviceInstalled).toBe(false);
    const persisted = JSON.parse(fs.files.get(getRunnerMetadataPath(TEST_CWD))!);
    expect(persisted.runnerName).toBe(meta.runnerName);
  });

  it('throws if installRunner has not been run yet', async () => {
    const fs = makeStubFs();
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: true, value: 'tok' }),
      exec: async () => ({ exit: 0, stdout: '', stderr: '' }),
    };
    await expect(
      registerRunner({ cwd: TEST_CWD, repo: 'owner/repo' }, shims),
    ).rejects.toThrow(/not installed/);
  });

  it('throws when the registration-token API fails', async () => {
    const fs = makeStubFs();
    setupInstalled(fs);
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: false, message: 'permission denied', exitCode: 1 }),
      exec: async () => ({ exit: 0, stdout: '', stderr: '' }),
    };
    await expect(
      registerRunner({ cwd: TEST_CWD, repo: 'owner/repo' }, shims),
    ).rejects.toThrow(/permission denied/);
  });

  it('throws when config.sh exits non-zero', async () => {
    const fs = makeStubFs();
    setupInstalled(fs);
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: true, value: 'tok' }),
      exec: async () => ({ exit: 2, stdout: '', stderr: 'bad token' }),
    };
    await expect(
      registerRunner({ cwd: TEST_CWD, repo: 'owner/repo' }, shims),
    ).rejects.toThrow(/bad token/);
  });
});

describe('installRunnerService', () => {
  function setupRegistered(fs: StubFs) {
    const installDir = getRunnerInstallDir(TEST_CWD);
    fs.files.set(`${installDir}/svc.sh`, '#!/bin/sh');
    const meta: RunnerMetadata = {
      repo: 'owner/repo',
      installDir,
      runnerName: 'harnext-x',
      labels: ['self-hosted'],
      registeredAt: '2026-04-25T00:00:00Z',
      serviceInstalled: false,
    };
    fs.files.set(getRunnerMetadataPath(TEST_CWD), JSON.stringify(meta));
    return meta;
  }

  it('runs svc.sh install + start and flips serviceInstalled', async () => {
    const fs = makeStubFs();
    setupRegistered(fs);
    const calls: string[] = [];
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      detectPlatform: () => 'linux',
      exec: async (_b, args) => {
        calls.push(args.join(' '));
        return { exit: 0, stdout: '', stderr: '' };
      },
    };
    const meta = await installRunnerService(TEST_CWD, shims);
    expect(calls).toEqual(['install', 'start']);
    expect(meta.serviceInstalled).toBe(true);
    const persisted = JSON.parse(fs.files.get(getRunnerMetadataPath(TEST_CWD))!);
    expect(persisted.serviceInstalled).toBe(true);
  });

  it('surfaces svc.sh install failures', async () => {
    const fs = makeStubFs();
    setupRegistered(fs);
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      detectPlatform: () => 'linux',
      exec: async () => ({ exit: 1, stdout: '', stderr: 'no permission' }),
    };
    await expect(installRunnerService(TEST_CWD, shims)).rejects.toThrow(/no permission/);
  });
});

describe('deregisterRunner', () => {
  function setupRegistered(fs: StubFs, serviceInstalled: boolean): RunnerMetadata {
    const installDir = getRunnerInstallDir(TEST_CWD);
    fs.files.set(`${installDir}/config.sh`, '#!/bin/sh');
    fs.files.set(`${installDir}/svc.sh`, '#!/bin/sh');
    const meta: RunnerMetadata = {
      repo: 'owner/repo',
      installDir,
      runnerName: 'harnext-x',
      labels: ['self-hosted'],
      registeredAt: '2026-04-25T00:00:00Z',
      serviceInstalled,
    };
    fs.files.set(getRunnerMetadataPath(TEST_CWD), JSON.stringify(meta));
    return meta;
  }

  it('runs the full teardown when the service is installed', async () => {
    const fs = makeStubFs();
    setupRegistered(fs, true);
    const execLog: string[] = [];
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: true, value: 'REMOVE-TOK' }),
      exec: async (b, args) => {
        execLog.push(`${b} ${args.join(' ')}`);
        return { exit: 0, stdout: '', stderr: '' };
      },
    };
    const result = await deregisterRunner(TEST_CWD, shims);
    expect(result.errors).toEqual([]);
    expect(execLog).toEqual([
      './svc.sh stop',
      './svc.sh uninstall',
      './config.sh remove --token REMOVE-TOK',
    ]);
    expect(fs.removed).toContain(getRunnerInstallDir(TEST_CWD));
  });

  it('skips svc.sh when the service was never installed', async () => {
    const fs = makeStubFs();
    setupRegistered(fs, false);
    const execLog: string[] = [];
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: true, value: 'TOK' }),
      exec: async (b, args) => {
        execLog.push(`${b} ${args.join(' ')}`);
        return { exit: 0, stdout: '', stderr: '' };
      },
    };
    const result = await deregisterRunner(TEST_CWD, shims);
    expect(result.errors).toEqual([]);
    expect(execLog).toEqual(['./config.sh remove --token TOK']);
  });

  it('continues teardown even if the remove-token API fails', async () => {
    const fs = makeStubFs();
    setupRegistered(fs, true);
    const shims: SelfHostedRunnerShims = {
      ...makeFsShims(fs),
      gh: () => ({ ok: false, message: 'api down', exitCode: 1 }),
      exec: async () => ({ exit: 0, stdout: '', stderr: '' }),
    };
    const result = await deregisterRunner(TEST_CWD, shims);
    // svc.sh stop+uninstall still ran; remove-token failed; install dir cleaned.
    expect(result.errors.some((e) => /remove-token/.test(e))).toBe(true);
    expect(fs.removed).toContain(getRunnerInstallDir(TEST_CWD));
  });

  it('returns gracefully when no metadata exists', async () => {
    const fs = makeStubFs();
    const shims: SelfHostedRunnerShims = makeFsShims(fs);
    const result = await deregisterRunner(TEST_CWD, shims);
    expect(result.errors[0]).toMatch(/no runner metadata/);
  });
});

describe('loadRunnerMetadata', () => {
  it('round-trips through the metadata file', () => {
    const fs = makeStubFs();
    const meta: RunnerMetadata = {
      repo: 'owner/repo',
      installDir: '/x',
      runnerName: 'n',
      labels: ['self-hosted'],
      registeredAt: '2026-04-25T00:00:00Z',
      serviceInstalled: false,
    };
    fs.files.set(getRunnerMetadataPath(TEST_CWD), JSON.stringify(meta));
    const loaded = loadRunnerMetadata(TEST_CWD, makeFsShims(fs));
    expect(loaded.runnerName).toBe('n');
  });
});

describe('getRemoteRunnerStatus', () => {
  const meta: RunnerMetadata = {
    repo: 'owner/repo',
    installDir: '/x',
    runnerName: 'harnext-abc',
    labels: ['self-hosted'],
    registeredAt: '2026-04-25T00:00:00Z',
    serviceInstalled: true,
  };

  it('reports online when GitHub lists the runner as online', () => {
    const shims: SelfHostedRunnerShims = {
      gh: () => ({
        ok: true,
        value: '{"name":"harnext-abc","status":"online","busy":false}',
      }),
    };
    const res = getRemoteRunnerStatus(meta, shims);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        registeredOnGithub: true,
        online: true,
        busy: false,
      });
    }
  });

  it('reports not-registered when the name is missing from the API response', () => {
    const shims: SelfHostedRunnerShims = {
      gh: () => ({
        ok: true,
        value: '{"name":"some-other","status":"online","busy":false}',
      }),
    };
    const res = getRemoteRunnerStatus(meta, shims);
    if (res.ok) {
      expect(res.value.registeredOnGithub).toBe(false);
      expect(res.value.online).toBe(false);
    }
  });
});

describe('checkPublicRepoApprovalGate', () => {
  it('treats private repos as always-acceptable without a second API call', () => {
    let calls = 0;
    const shims: SelfHostedRunnerShims = {
      gh: (args) => {
        calls += 1;
        if (args[1] === 'repos/owner/repo') {
          return { ok: true, value: '{"visibility":"private","forks":false}' };
        }
        return { ok: false, message: 'should not be called', exitCode: 1 };
      },
    };
    const res = checkPublicRepoApprovalGate('owner/repo', shims);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.isPublic).toBe(false);
      expect(res.value.approvalGateEnabled).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it('flags public + first-time-contributor approval as gated', () => {
    const shims: SelfHostedRunnerShims = {
      gh: (args) => {
        if (args[1] === 'repos/owner/repo') {
          return { ok: true, value: '{"visibility":"public","forks":true}' };
        }
        if (args[1] === 'repos/owner/repo/actions/permissions') {
          return { ok: true, value: '"first_time_contributors"\n' };
        }
        return { ok: false, message: 'unexpected', exitCode: 1 };
      },
    };
    const res = checkPublicRepoApprovalGate('owner/repo', shims);
    if (res.ok) {
      expect(res.value.isPublic).toBe(true);
      expect(res.value.approvalGateEnabled).toBe(true);
      expect(res.value.forkPrApprovalPolicy).toBe('first_time_contributors');
    }
  });

  it('flags public + requires_no_approval as ungated', () => {
    const shims: SelfHostedRunnerShims = {
      gh: (args) => {
        if (args[1] === 'repos/owner/repo') {
          return { ok: true, value: '{"visibility":"public","forks":true}' };
        }
        return { ok: true, value: '"requires_no_approval"\n' };
      },
    };
    const res = checkPublicRepoApprovalGate('owner/repo', shims);
    if (res.ok) {
      expect(res.value.isPublic).toBe(true);
      expect(res.value.approvalGateEnabled).toBe(false);
    }
  });

  it('writes runner state under the project state dir', () => {
    // Smoke test: verify our path helpers stay aligned with config helpers
    // so dropping tests do not silently start writing to / or homedir().
    expect(getRunnerInstallDir(TEST_CWD).startsWith(getProjectStateDir(TEST_CWD))).toBe(true);
    expect(getRunnerMetadataPath(TEST_CWD).startsWith(getProjectStateDir(TEST_CWD))).toBe(true);
  });
});
