import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PiiEntity {
  entity_group: string;
  start: number;
  end: number;
  word: string;
  score: number;
}

export interface MaskResult {
  masked: string;
  entities: PiiEntity[];
}

export interface PiiMasker {
  /** Spawn the Python daemon and wait for the model to load. Idempotent. */
  ready(): Promise<void>;
  /** Mask PII in `text`. Throws if the daemon fails to start or respond. */
  mask(text: string): Promise<MaskResult>;
  /** Kill the daemon and reject pending requests. Safe to call multiple times. */
  dispose(): void;
}

export interface CreatePiiMaskerOptions {
  pythonPath?: string;
  scriptPath?: string;
  /** Time budget for `ready()`; first run includes model download. Default 5min. */
  readyTimeoutMs?: number;
  /** Time budget for a single `mask()` call. Default 30s. */
  maskTimeoutMs?: number;
}

function defaultScriptPath(): string {
  // After build, tsup copies pii-masker.py next to the bundled JS — both for
  // core's own dist and for the CLI bundle (which inlines core via noExternal).
  // In dev (pre-build), fall back to the source path.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'pii-masker.py'),
    join(here, 'pii', 'pii-masker.py'),
    join(here, '..', 'src', 'pii', 'pii-masker.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

interface PendingRequest {
  resolve: (value: MaskResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface DaemonMessage {
  ready?: boolean;
  masked?: string;
  entities?: PiiEntity[];
  error?: string;
}

class PiiMaskerImpl implements PiiMasker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private queue: PendingRequest[] = [];
  private buffer = '';
  private disposed = false;

  constructor(private readonly opts: Required<CreatePiiMaskerOptions>) {}

  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('PII masker disposed'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.spawn();
    return this.readyPromise;
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.cleanup();
        reject(new Error(`PII model load timed out after ${this.opts.readyTimeoutMs}ms`));
      }, this.opts.readyTimeoutMs);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.opts.pythonPath, ['-u', this.opts.scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;

      // Buffer recent stderr — surfaced if the process dies before ready.
      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail += chunk.toString('utf8');
        if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
      });

      child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: DaemonMessage;
          try {
            msg = JSON.parse(line) as DaemonMessage;
          } catch {
            continue;
          }
          if (!resolved) {
            if (msg.ready) {
              resolved = true;
              clearTimeout(timer);
              resolve();
              continue;
            }
            if (msg.error) {
              resolved = true;
              clearTimeout(timer);
              this.cleanup();
              reject(new Error(`PII model load failed: ${msg.error}`));
              continue;
            }
          }
          // After ready: every JSON line corresponds to the head of the queue.
          const pending = this.queue.shift();
          if (!pending) continue;
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else if (typeof msg.masked === 'string' && Array.isArray(msg.entities)) {
            pending.resolve({ masked: msg.masked, entities: msg.entities });
          } else {
            pending.reject(new Error('PII masker returned malformed response'));
          }
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
        this.flushQueueWithError(err);
      });

      child.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
          reject(
            new Error(
              `PII masker process exited with code ${code}` + (tail ? `\n${tail}` : ''),
            ),
          );
        }
        this.child = null;
        this.flushQueueWithError(new Error('PII masker process exited'));
      });
    });
  }

  async mask(text: string): Promise<MaskResult> {
    if (this.disposed) throw new Error('PII masker disposed');
    await this.ready();
    const child = this.child;
    if (!child) throw new Error('PII masker not running');

    return new Promise<MaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`PII mask timed out after ${this.opts.maskTimeoutMs}ms`));
      }, this.opts.maskTimeoutMs);

      this.queue.push({ resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        const idx = this.queue.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private flushQueueWithError(err: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private cleanup(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushQueueWithError(new Error('PII masker disposed'));
    this.cleanup();
  }
}

export function createPiiMasker(options: CreatePiiMaskerOptions = {}): PiiMasker {
  const opts: Required<CreatePiiMaskerOptions> = {
    pythonPath: options.pythonPath ?? process.env.HARNEXT_PYTHON ?? 'python3',
    scriptPath: options.scriptPath ?? defaultScriptPath(),
    readyTimeoutMs: options.readyTimeoutMs ?? 5 * 60_000,
    maskTimeoutMs: options.maskTimeoutMs ?? 30_000,
  };
  return new PiiMaskerImpl(opts);
}
