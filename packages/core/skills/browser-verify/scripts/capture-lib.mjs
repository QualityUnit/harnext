import { appendFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

function jsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + '\n');
}

function ts() {
  return new Date().toISOString();
}

function safeLabel(label) {
  return label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'step';
}

function collectSecrets() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || typeof v !== 'string' || v.length < 8) continue;
    if (/^(PATH|PWD|HOME|SHELL|TERM|LANG|LC_|XDG_|NODE_|npm_|NVM_|USER|LOGNAME|HOSTNAME|DISPLAY|WAYLAND_|SESSION|DESKTOP)/i.test(k)) continue;
    out.push(v);
  }
  return out;
}

function redact(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '<redacted-env>');
  }
  return out;
}

export function attachListeners(page, runDir) {
  const secrets = collectSecrets();
  const counts = { console: 0, pageErrors: 0, networkErrors: 0 };

  page.on('console', (msg) => {
    counts.console += 1;
    const loc = msg.location?.() ?? {};
    jsonl(join(runDir, 'console.jsonl'), {
      ts: ts(),
      level: msg.type(),
      text: redact(msg.text(), secrets),
      url: loc.url ?? null,
      line: loc.lineNumber ?? null,
      column: loc.columnNumber ?? null,
    });
  });

  page.on('pageerror', (err) => {
    counts.pageErrors += 1;
    jsonl(join(runDir, 'page-errors.jsonl'), {
      ts: ts(),
      message: redact(String(err?.message ?? err), secrets),
      stack: err?.stack ? redact(String(err.stack), secrets) : null,
    });
  });

  page.on('requestfailed', (req) => {
    counts.networkErrors += 1;
    jsonl(join(runDir, 'network-errors.jsonl'), {
      ts: ts(),
      kind: 'requestfailed',
      method: req.method(),
      url: req.url(),
      failureText: req.failure()?.errorText ?? null,
    });
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      counts.networkErrors += 1;
      jsonl(join(runDir, 'network-errors.jsonl'), {
        ts: ts(),
        kind: 'response',
        method: res.request().method(),
        url: res.url(),
        status,
      });
    }
  });

  return { counts };
}

const STEPS = { current: [] };

export async function step(label, fn, { page, runDir } = {}) {
  const startedAt = Date.now();
  const entry = { ts: ts(), label, ok: false, durMs: 0, url: null };
  try {
    const r = await fn();
    entry.ok = true;
    entry.durMs = Date.now() - startedAt;
    if (page) entry.url = page.url();
    return r;
  } catch (err) {
    entry.ok = false;
    entry.durMs = Date.now() - startedAt;
    entry.error = String(err?.message ?? err);
    if (page) {
      entry.url = page.url();
      try {
        const tree = await page.accessibility.snapshot();
        if (tree && runDir) {
          const target = join(runDir, 'snapshots', `${safeLabel(label)}.a11y.txt`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, serializeA11y(tree));
        }
      } catch {
        // best-effort snapshot
      }
    }
    throw err;
  } finally {
    if (runDir) jsonl(join(runDir, 'steps.jsonl'), entry);
    STEPS.current.push(entry);
  }
}

function serializeA11y(node, depth = 0) {
  if (!node) return '';
  const pad = '  '.repeat(depth);
  const role = node.role ?? '?';
  const name = node.name ? ` "${node.name}"` : '';
  const value = node.value ? ` value="${node.value}"` : '';
  const state = [];
  if (node.disabled) state.push('disabled');
  if (node.checked != null) state.push(`checked=${node.checked}`);
  if (node.expanded != null) state.push(`expanded=${node.expanded}`);
  if (node.selected) state.push('selected');
  const stateStr = state.length ? ` [${state.join(',')}]` : '';
  let out = `${pad}${role}${name}${value}${stateStr}\n`;
  for (const c of node.children ?? []) out += serializeA11y(c, depth + 1);
  return out;
}

export async function finalize(meta, { context, page, listenersCounts }) {
  const runDir = meta.runDir ?? process.env.RUN_DIR;
  const endedAt = ts();

  // Final screenshot (best-effort)
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: join(runDir, 'final.png'), fullPage: false });
    } catch {
      // may fail if page already closed
    }
  }

  // Stop tracing to trace.zip (best-effort)
  try {
    await context.tracing.stop({ path: join(runDir, 'trace.zip') });
  } catch {
    // tracing may not have started; ignore
  }

  // Close context — this flushes HAR and video
  try {
    await context.close();
  } catch {
    // best-effort close
  }

  // Rename any video file(s) to a stable name alongside their dir
  const videoDir = join(runDir, 'video');
  if (existsSync(videoDir)) {
    const files = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
    if (files.length === 1) {
      try {
        renameSync(join(videoDir, files[0]), join(videoDir, 'recording.webm'));
      } catch {
        // best-effort rename; Playwright's generated name is fine as fallback
      }
    }
    // Convert webm → mp4. Playwright's webm has stream-level
    // duration=N/A, which VLC (at least the Linux snap) refuses to
    // play. H.264 MP4 is also meaningfully smaller for screen
    // recording content. Best-effort: if ffmpeg or libx264 is
    // missing we keep the webm.
    const webmPath = join(videoDir, 'recording.webm');
    if (existsSync(webmPath)) {
      const mp4Path = join(videoDir, 'recording.mp4');
      const r = spawnSync(
        'ffmpeg',
        [
          '-y', '-v', 'error',
          '-i', webmPath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          mp4Path,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      if (r.status === 0 && existsSync(mp4Path)) {
        try { unlinkSync(webmPath); } catch { /* ignore */ }
      } else {
        try { if (existsSync(mp4Path)) unlinkSync(mp4Path); } catch { /* ignore */ }
        const why = r.error?.code === 'ENOENT'
          ? 'ffmpeg not on PATH'
          : String(r.stderr ?? r.error?.message ?? `exit ${r.status}`);
        jsonl(join(runDir, 'page-errors.jsonl'), {
          ts: ts(),
          message: `video mp4 conversion failed (keeping .webm): ${why}`,
          stack: null,
        });
      }
    }
  }

  // Redact HAR in-place
  const harPath = join(runDir, 'network.har');
  if (existsSync(harPath)) {
    try {
      const mod = await import('./redact-har.mjs');
      await mod.redactHarFile(harPath);
    } catch (err) {
      // Record the failure but don't crash
      jsonl(join(runDir, 'page-errors.jsonl'), {
        ts: ts(),
        message: `HAR redaction failed: ${String(err?.message ?? err)}`,
        stack: null,
      });
    }
  }

  const counts = listenersCounts ?? { console: 0, pageErrors: 0, networkErrors: 0 };
  const summary = {
    runId: meta.runId ?? null,
    mode: meta.mode ?? null,
    passed: !!meta.passed,
    failedStep: meta.failedStep ?? null,
    startedAt: meta.startedAt ?? null,
    endedAt,
    url: meta.url ?? null,
    counts,
    steps: STEPS.current.length,
    artifactPaths: {
      summary: 'summary.json',
      scenario: 'scenario.mjs',
      steps: 'steps.jsonl',
      console: 'console.jsonl',
      pageErrors: 'page-errors.jsonl',
      networkErrors: 'network-errors.jsonl',
      har: 'network.har',
      snapshots: 'snapshots/',
      video: 'video/',
      trace: 'trace.zip',
      finalScreenshot: 'final.png',
    },
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
}
