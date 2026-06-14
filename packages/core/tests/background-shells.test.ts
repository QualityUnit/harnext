import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackgroundShellManager, type BackgroundShell } from '../src/background-shells.js';
import { createBashTool } from '../src/tools/bash.js';
import { createBashOutputTool } from '../src/tools/bash-output.js';
import { createKillShellTool } from '../src/tools/kill-shell.js';

// Background shells spawn into this dir, so it must actually exist (unlike the
// memory tool, which only hashes its cwd). The repo root is a safe real dir;
// log files still land under the temp HARNEXT_HOME set in each beforeEach.
const cwd = process.cwd();

/** Resolve once the given shell has finished (or immediately if already done). */
function waitForExit(
  mgr: BackgroundShellManager,
  id: string,
  timeoutMs = 8000,
): Promise<BackgroundShell> {
  return new Promise((resolve, reject) => {
    const current = mgr.get(id);
    if (current && current.status !== 'running') {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${id} to exit`));
    }, timeoutMs);
    const off = mgr.on('exit', (shell) => {
      if (shell.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(shell);
    });
  });
}

function textOf(result: { content: Array<{ type: string }> }): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('BackgroundShellManager', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;
  let mgr: BackgroundShellManager;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-bg-'));
    process.env.HARNEXT_HOME = home;
    mgr = new BackgroundShellManager(cwd);
  });

  afterEach(() => {
    mgr.disposeAll();
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('starts a command, assigns incrementing ids, and reports completion', async () => {
    const shell = mgr.start('printf "line1\\nline2\\n"');
    expect(shell.id).toBe('bash_1');
    expect(shell.status).toBe('running');
    expect(shell.pid).toBeTypeOf('number');

    const finished = await waitForExit(mgr, shell.id);
    expect(finished.status).toBe('completed');
    expect(finished.exitCode).toBe(0);

    const second = mgr.start('true');
    expect(second.id).toBe('bash_2');
  });

  it('readOutput delivers new output once (cursor advances)', async () => {
    const shell = mgr.start('printf "alpha\\nbeta\\n"');
    await waitForExit(mgr, shell.id);

    const first = mgr.readOutput(shell.id);
    expect(first?.newOutput).toContain('alpha');
    expect(first?.newOutput).toContain('beta');
    expect(first?.truncated).toBe(false);

    // Second read returns nothing new — the cursor already advanced.
    const second = mgr.readOutput(shell.id);
    expect(second?.newOutput).toBe('');
  });

  it('readOutput filter keeps only matching lines', async () => {
    const shell = mgr.start('printf "apple\\nbanana\\napricot\\n"');
    await waitForExit(mgr, shell.id);

    const out = mgr.readOutput(shell.id, { filter: 'ap' });
    expect(out?.newOutput).toContain('apple');
    expect(out?.newOutput).toContain('apricot');
    expect(out?.newOutput).not.toContain('banana');
  });

  it('kill stops a running shell (status becomes killed)', async () => {
    const shell = mgr.start('sleep 30');
    expect(mgr.get(shell.id)?.status).toBe('running');

    const afterKill = mgr.kill(shell.id);
    expect(afterKill?.status).toBe('running'); // signal not processed synchronously

    const finished = await waitForExit(mgr, shell.id);
    expect(finished.status).toBe('killed');
  });

  it('a non-zero exit is reported as failed', async () => {
    const shell = mgr.start('exit 3');
    const finished = await waitForExit(mgr, shell.id);
    expect(finished.status).toBe('failed');
    expect(finished.exitCode).toBe(3);
  });

  it('disposeAll terminates every running shell', async () => {
    const a = mgr.start('sleep 30');
    const b = mgr.start('sleep 30');
    const exits = Promise.all([waitForExit(mgr, a.id), waitForExit(mgr, b.id)]);
    mgr.disposeAll();
    const [ea, eb] = await exits;
    expect(ea.status).toBe('killed');
    expect(eb.status).toBe('killed');
  });

  it('returns undefined for unknown ids', () => {
    expect(mgr.get('bash_999')).toBeUndefined();
    expect(mgr.readOutput('bash_999')).toBeUndefined();
    expect(mgr.kill('bash_999')).toBeUndefined();
    expect(mgr.peek('bash_999')).toBeUndefined();
  });

  it('peek does not advance the model read cursor', async () => {
    const shell = mgr.start('printf "hello\\n"');
    await waitForExit(mgr, shell.id);

    const peeked = mgr.peek(shell.id);
    expect(peeked?.output).toContain('hello');
    // The incremental reader still sees the output after a peek.
    expect(mgr.readOutput(shell.id)?.newOutput).toContain('hello');
  });
});

describe('background-shell tools', () => {
  const original = process.env.HARNEXT_HOME;
  let home: string;
  let mgr: BackgroundShellManager;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'harnext-bg-tool-'));
    process.env.HARNEXT_HOME = home;
    mgr = new BackgroundShellManager(cwd);
  });

  afterEach(() => {
    mgr.disposeAll();
    if (original === undefined) delete process.env.HARNEXT_HOME;
    else process.env.HARNEXT_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('bash run_in_background returns a shell id without blocking', async () => {
    const bash = createBashTool(cwd, { backgroundShells: mgr });
    const result = await bash.execute('1', {
      command: 'printf "hi\\n"',
      run_in_background: true,
    });
    expect(result.details.backgroundId).toBe('bash_1');
    expect(textOf(result)).toContain('Started background shell');

    await waitForExit(mgr, 'bash_1');
    const out = mgr.readOutput('bash_1');
    expect(out?.newOutput).toContain('hi');
  });

  it('bash without a manager refuses to background instead of silently blocking', async () => {
    const bash = createBashTool(cwd); // no manager → background unavailable
    const result = await bash.execute('1', {
      command: 'echo SHOULD_NOT_RUN',
      run_in_background: true,
    });
    // It must NOT silently degrade to a foreground run — the command is skipped
    // (its output never appears) and the model is told background is unavailable.
    expect(result.details.backgroundId).toBeUndefined();
    expect(textOf(result)).toContain('Background execution is not available');
    expect(textOf(result)).not.toContain('SHOULD_NOT_RUN');
  });

  it('bash without run_in_background still runs in the foreground', async () => {
    const bash = createBashTool(cwd);
    const result = await bash.execute('1', { command: 'echo hello-fg' });
    expect(result.details.backgroundId).toBeUndefined();
    expect(textOf(result)).toContain('hello-fg');
  });

  it('bash_output reports status, output, and handles unknown ids', async () => {
    const tool = createBashOutputTool(mgr);
    const shell = mgr.start('printf "ready\\n"');
    await waitForExit(mgr, shell.id);

    const ok = await tool.execute('1', { bash_id: shell.id });
    expect(ok.details.status).toBe('completed');
    expect(ok.details.exitCode).toBe(0);
    expect(textOf(ok)).toContain('ready');

    const missing = await tool.execute('2', { bash_id: 'bash_404' });
    expect(missing.details.status).toBe('failed');
    expect(textOf(missing)).toContain('No background shell');
  });

  it('kill_shell signals a running shell and reports unknown ids', async () => {
    const tool = createKillShellTool(mgr);
    const shell = mgr.start('sleep 30');

    const killed = await tool.execute('1', { shell_id: shell.id });
    expect(killed.details.status).toBe('running');
    expect(textOf(killed)).toContain('Sent SIGTERM');
    const finished = await waitForExit(mgr, shell.id);
    expect(finished.status).toBe('killed');

    const missing = await tool.execute('2', { shell_id: 'bash_404' });
    expect(missing.details.status).toBe('unknown');
    expect(textOf(missing)).toContain('No background shell');
  });
});
