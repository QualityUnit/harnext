import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

import {
  hostCommandExecutor,
  type ChildProcessLike,
  type CommandExecutor,
} from './command-executor.js';
import { getProjectStateDir } from './config.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from './tools/truncate.js';

/** Public, serializable view of a background shell. */
export interface BackgroundShell {
  /** Human-readable session id, e.g. "bash_1". */
  id: string;
  /** The command that was launched. */
  command: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  /** Process exit code once finished; null while running or if signal-killed. */
  exitCode: number | null;
  /** Epoch ms when the shell started. */
  startedAt: number;
  /** Epoch ms when the shell finished; undefined while running. */
  endedAt?: number;
  /** OS process id, if the spawn succeeded. */
  pid?: number;
  /** Absolute path to the full output log on disk. */
  logPath: string;
}

export interface ReadOutputResult {
  shell: BackgroundShell;
  /** Output produced since the previous read (cursor-based). */
  newOutput: string;
  /** True when older buffered output was dropped before this read. */
  truncated: boolean;
}

export type BackgroundShellListener = (shell: BackgroundShell) => void;

/** Max output retained in memory per shell. The full stream is teed to the log file. */
const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MiB

/** Placeholder handle for a shell whose spawn failed synchronously. */
const NULL_CHILD: ChildProcessLike = {
  stdout: null,
  stderr: null,
  kill: () => false,
  on: () => undefined,
};

interface ShellRecord {
  view: BackgroundShell;
  child: ChildProcessLike;
  /** Retained tail of output (older bytes are dropped past MAX_BUFFER_BYTES). */
  buffer: Buffer;
  /** Total bytes ever produced (buffer.length + bytes dropped from the front). */
  totalBytes: number;
  /** Absolute byte offset already delivered by readOutput. */
  readCursor: number;
  /** Bytes dropped from the front of `buffer` to stay under the cap. */
  discardedBytes: number;
  logStream?: WriteStream;
  killRequested: boolean;
  killTimer?: NodeJS.Timeout;
}

export interface BackgroundShellManagerOptions {
  /** Where commands run. Defaults to the host shell executor. */
  executor?: CommandExecutor;
  /**
   * Directory the executor runs commands in, when it differs from `cwd` — e.g.
   * a container bind-mount target. The `cwd` argument still locates the on-disk
   * log directory (a host path); `execCwd` is the command's working directory.
   */
  execCwd?: string;
  /** Grace period before a SIGTERM'd shell is force-killed with SIGKILL. */
  killGraceMs?: number;
}

/**
 * Owns shell processes started with `run_in_background`. One instance per
 * session, constructed in `createAgentSession` and shared by the `bash`,
 * `bash_output`, and `kill_shell` tools — mirroring how `McpServerManager`
 * is wired. Output is buffered in memory (capped) and teed to a per-shell log
 * file so it survives between reads. Every shell is SIGTERM'd on `disposeAll`.
 * Command execution is routed through an injectable {@link CommandExecutor}, so
 * background shells can be sandboxed the same way foreground `bash` is.
 */
export class BackgroundShellManager {
  private readonly shells = new Map<string, ShellRecord>();
  private readonly exitListeners = new Set<BackgroundShellListener>();
  private counter = 0;
  private readonly executor: CommandExecutor;
  private readonly execCwd: string;
  private readonly killGraceMs: number;

  constructor(
    /** Host path used to locate the on-disk log directory. */
    private readonly cwd: string,
    options: BackgroundShellManagerOptions = {},
  ) {
    this.executor = options.executor ?? hostCommandExecutor;
    this.execCwd = options.execCwd ?? cwd;
    this.killGraceMs = options.killGraceMs ?? 5000;
  }

  /** Start a command in the background and return its shell view immediately. */
  start(command: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): BackgroundShell {
    const id = `bash_${++this.counter}`;
    const cwd = opts?.cwd ?? this.execCwd;

    const logPath = join(getProjectStateDir(this.cwd), 'bg-shells', `${id}.log`);
    let logStream: WriteStream | undefined;
    try {
      mkdirSync(join(getProjectStateDir(this.cwd), 'bg-shells'), { recursive: true });
      logStream = createWriteStream(logPath, { flags: 'a' });
      logStream.on('error', () => {
        /* best-effort logging; ignore disk errors */
      });
    } catch {
      logStream = undefined;
    }

    const view: BackgroundShell = {
      id,
      command,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      logPath,
    };

    const record: ShellRecord = {
      view,
      child: NULL_CHILD,
      buffer: Buffer.alloc(0),
      totalBytes: 0,
      readCursor: 0,
      discardedBytes: 0,
      logStream,
      killRequested: false,
    };
    this.shells.set(id, record);

    // Executor.spawn can fail synchronously (e.g. the host executor's
    // missing-cwd guard). Record it as a failed shell so callers still see it
    // via get()/readOutput() instead of the whole tool call throwing.
    let child: ChildProcessLike;
    try {
      child = this.executor.spawn(command, { cwd, env: opts?.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.append(record, Buffer.from(`[spawn error] ${message}\n`));
      this.finalize(record, null, true);
      return { ...record.view };
    }

    record.child = child;
    view.pid = child.pid;

    const onData = (data: Buffer) => this.append(record, data);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      this.append(record, Buffer.from(`\n[spawn error] ${err.message}\n`));
      // A spawn failure emits 'error' but may not emit 'close'; finalize here if
      // the process never started.
      if (view.status === 'running' && child.pid === undefined) {
        this.finalize(record, null, true);
      }
    });

    child.on('close', (code) => {
      this.finalize(record, code, false);
    });

    return { ...view };
  }

  /** Snapshot of a single shell, or undefined if the id is unknown. */
  get(id: string): BackgroundShell | undefined {
    const record = this.shells.get(id);
    return record ? { ...record.view } : undefined;
  }

  /** All shells, oldest first. */
  list(): BackgroundShell[] {
    return [...this.shells.values()].map((r) => ({ ...r.view }));
  }

  /**
   * Read output produced since the previous call (the read cursor advances so
   * each chunk is delivered once). `filter` keeps only lines matching the regex.
   * Returns undefined if the id is unknown.
   */
  readOutput(id: string, opts?: { filter?: string }): ReadOutputResult | undefined {
    const record = this.shells.get(id);
    if (!record) return undefined;

    // Absolute offsets: bytes [discardedBytes, totalBytes) are in `buffer`.
    const start = Math.max(record.readCursor, record.discardedBytes);
    const lostBeforeCursor = record.readCursor < record.discardedBytes;
    const sliceStart = start - record.discardedBytes;
    let text = record.buffer.subarray(sliceStart).toString('utf-8');
    record.readCursor = record.totalBytes;

    if (opts?.filter && text) {
      try {
        const re = new RegExp(opts.filter);
        text = text
          .split('\n')
          .filter((line) => re.test(line))
          .join('\n');
      } catch {
        text += `\n[invalid filter regex: ${opts.filter} — ignored]`;
      }
    }

    const truncation = truncateTail(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
    return {
      shell: { ...record.view },
      newOutput: truncation.content,
      truncated: lostBeforeCursor || truncation.truncated,
    };
  }

  /**
   * Current retained output tail for UI display, WITHOUT advancing the model's
   * read cursor — keeps `/bashes` viewing independent from `bash_output` reads.
   */
  peek(id: string): { shell: BackgroundShell; output: string } | undefined {
    const record = this.shells.get(id);
    if (!record) return undefined;
    const truncation = truncateTail(
      record.buffer.toString('utf-8'),
      DEFAULT_MAX_LINES,
      DEFAULT_MAX_BYTES,
    );
    return { shell: { ...record.view }, output: truncation.content };
  }

  /** SIGTERM a shell (SIGKILL after the grace period). No-op if already done. */
  kill(id: string): BackgroundShell | undefined {
    const record = this.shells.get(id);
    if (!record) return undefined;
    if (record.view.status !== 'running') return { ...record.view };

    record.killRequested = true;
    record.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (record.view.status === 'running') record.child.kill('SIGKILL');
    }, this.killGraceMs);
    if (typeof timer.unref === 'function') timer.unref();
    record.killTimer = timer;
    return { ...record.view };
  }

  /** SIGTERM every running shell. Called from `AgentSession.dispose()`. */
  disposeAll(): void {
    for (const record of this.shells.values()) {
      if (record.view.status === 'running') {
        record.killRequested = true;
        try {
          record.child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
      if (record.killTimer) clearTimeout(record.killTimer);
      record.logStream?.end();
    }
  }

  /** Subscribe to shell completion. Returns an unsubscribe function. */
  on(event: 'exit', listener: BackgroundShellListener): () => void {
    void event;
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private append(record: ShellRecord, data: Buffer): void {
    record.totalBytes += data.length;
    record.logStream?.write(data);

    let buffer = Buffer.concat([record.buffer, data]);
    if (buffer.length > MAX_BUFFER_BYTES) {
      const drop = buffer.length - MAX_BUFFER_BYTES;
      record.discardedBytes += drop;
      buffer = buffer.subarray(drop);
    }
    record.buffer = buffer;
  }

  private finalize(record: ShellRecord, code: number | null, failed: boolean): void {
    if (record.view.status !== 'running') return; // guard double-finalize
    if (record.killTimer) clearTimeout(record.killTimer);
    record.view.exitCode = code;
    record.view.endedAt = Date.now();
    record.view.status = record.killRequested
      ? 'killed'
      : failed || (code !== 0 && code !== null)
        ? 'failed'
        : 'completed';
    record.logStream?.end();

    const snapshot = { ...record.view };
    for (const listener of this.exitListeners) {
      try {
        listener(snapshot);
      } catch {
        /* listener errors are not our problem */
      }
    }
  }
}
