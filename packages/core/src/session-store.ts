/**
 * Per-cwd interactive session history, stored as append-only JSONL transcripts
 * (Claude-Code style) so a conversation can be fully recovered and resumed.
 *
 * Layout: `~/.harnext/agent/sessions/<cwd-hash>/<sessionId>.jsonl`, where the
 * cwd-hash is `getProjectHash(absoluteCwd)` — the same scheme the rest of the
 * machine-state tree uses. The first line of each file is a `session-meta`
 * record; every subsequent line is one `AgentMessage`. Keeping full
 * `AgentMessage` objects (not a lossy flattening) preserves the API `usage`
 * numbers, which the resume flow needs to measure context size.
 *
 * Writes are append-only in the common case. The one mutation the agent makes
 * to its history is compaction, which replaces the whole `messages` array; the
 * writer detects that (the first message's timestamp changes, or the array
 * shrank) and rewrites the file from scratch. Both paths leave a valid JSONL
 * file on disk after every turn.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';

import { getProjectHash, getSessionsDir } from './config.js';

/** Bumped if the on-disk line shape ever changes incompatibly. */
export const SESSION_FILE_VERSION = 1;

/** Keep at most this many transcripts per cwd; oldest are pruned on write. */
export const DEFAULT_MAX_SESSIONS_PER_CWD = 100;

const SESSION_FILE_SUFFIX = '.jsonl';

/** Leading `[Compacted summary …]` marker written by compaction. */
const COMPACTED_MARKER = '[Compacted summary of earlier conversation]';

export interface StoredSessionMeta {
  type: 'session-meta';
  version: number;
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  createdAt: string;
  /**
   * The session's first user prompt, captured at creation. Stored in the meta
   * line so the picker label survives compaction (which would otherwise replace
   * the first message with a summary marker).
   */
  firstUserMessage?: string;
}

interface MessageLine {
  type: 'message';
  message: AgentMessage;
}

type SessionLine = StoredSessionMeta | MessageLine;

/** A fully-loaded transcript, ready to seed `agent.state.messages`. */
export interface StoredSession {
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
}

/** Lightweight row for the `--resume` picker — no full message bodies. */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** First real user prompt, cleaned for display (system-reminders stripped). */
  firstUserMessage: string;
  filePath: string;
}

/** Absolute, normalized cwd → the scheme every store function keys on. */
function normCwd(cwd: string): string {
  return resolvePath(cwd);
}

export function getCwdSessionsDir(cwd: string): string {
  return join(getSessionsDir(), getProjectHash(normCwd(cwd)));
}

export function getSessionFilePath(cwd: string, sessionId: string): string {
  return join(getCwdSessionsDir(cwd), `${sessionId}${SESSION_FILE_SUFFIX}`);
}

// ── Reading ─────────────────────────────────────────────────────────

interface ParsedSessionFile {
  meta?: StoredSessionMeta;
  messages: AgentMessage[];
}

/**
 * Parse a transcript file into its meta record + message list. Tolerant of
 * malformed/truncated trailing lines (a crash mid-write leaves at most one
 * partial line) — those are skipped rather than throwing.
 */
function parseSessionFile(filePath: string): ParsedSessionFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return { messages: [] };
  }
  let meta: StoredSessionMeta | undefined;
  const messages: AgentMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: SessionLine;
    try {
      parsed = JSON.parse(trimmed) as SessionLine;
    } catch {
      continue; // skip a partial/corrupt line
    }
    if (parsed.type === 'session-meta') {
      meta = parsed;
    } else if (parsed.type === 'message' && parsed.message) {
      messages.push(parsed.message);
    }
  }
  return { meta, messages };
}

/** Plain text of a user/assistant message's content (text parts only). */
function messageText(message: AgentMessage): string {
  if (message.role === 'user') {
    const content = (message as UserMessage).content;
    if (typeof content === 'string') return content;
    return content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  }
  if (message.role === 'assistant') {
    return (message as AssistantMessage).content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');
  }
  return '';
}

/**
 * Strip a leading `<system-reminder>…</system-reminder>` block (plan-mode and
 * other prompts prepend one) and collapse whitespace, so the picker shows the
 * user's actual words.
 */
function cleanFirstMessage(text: string): string {
  return text
    .replace(/^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First user prompt worth showing — skips compaction-summary markers. */
function firstUserMessage(messages: AgentMessage[]): string {
  let fallback = '';
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = cleanFirstMessage(messageText(m));
    if (!text) continue;
    if (text.startsWith(COMPACTED_MARKER)) {
      if (!fallback) fallback = text;
      continue;
    }
    return text;
  }
  return fallback;
}

function mtimeIso(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Load a full transcript by id. Looks under `cwd`'s hash first; if `cwd` is
 * omitted or the file isn't there, scans every per-cwd dir for the id (session
 * ids are globally unique, so this is unambiguous).
 */
export function loadSession(sessionId: string, cwd?: string): StoredSession | undefined {
  const filePath = cwd ? getSessionFilePath(cwd, sessionId) : undefined;
  const resolved = filePath && existsSync(filePath) ? filePath : findSessionFile(sessionId);
  if (!resolved) return undefined;

  const { meta, messages } = parseSessionFile(resolved);
  if (!meta && messages.length === 0) return undefined;
  return {
    sessionId,
    cwd: meta?.cwd ?? (cwd ? normCwd(cwd) : ''),
    provider: meta?.provider,
    model: meta?.model,
    createdAt: meta?.createdAt ?? mtimeIso(resolved),
    updatedAt: mtimeIso(resolved),
    messages,
  };
}

/** Scan every `<hash>/` dir under the sessions root for `<sessionId>.jsonl`. */
function findSessionFile(sessionId: string): string | undefined {
  const root = getSessionsDir();
  let hashes: string[];
  try {
    hashes = readdirSync(root);
  } catch {
    return undefined;
  }
  const target = `${sessionId}${SESSION_FILE_SUFFIX}`;
  for (const hash of hashes) {
    const candidate = join(root, hash, target);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** All transcripts for `cwd`, newest first. Best-effort — skips bad files. */
export function listSessions(cwd: string): SessionSummary[] {
  const dir = getCwdSessionsDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
    const filePath = join(dir, name);
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const { meta, messages } = parseSessionFile(filePath);
    if (messages.length === 0) continue; // empty/aborted-before-first-turn
    const sessionId = meta?.sessionId ?? name.slice(0, -SESSION_FILE_SUFFIX.length);
    summaries.push({
      sessionId,
      cwd: meta?.cwd ?? normCwd(cwd),
      provider: meta?.provider,
      model: meta?.model,
      createdAt: meta?.createdAt ?? mtimeIso(filePath),
      updatedAt: mtimeIso(filePath),
      messageCount: messages.length,
      firstUserMessage: meta?.firstUserMessage ?? firstUserMessage(messages),
      filePath,
    });
  }
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return summaries;
}

export function deleteSession(cwd: string, sessionId: string): void {
  try {
    rmSync(getSessionFilePath(cwd, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Keep only the newest `max` transcripts for `cwd`, deleting older ones. Called
 * after a new session is first written so the per-cwd store stays bounded.
 */
export function pruneSessions(cwd: string, max: number = DEFAULT_MAX_SESSIONS_PER_CWD): void {
  if (max <= 0) return;
  const dir = getCwdSessionsDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const files = entries
    .filter((n) => n.endsWith(SESSION_FILE_SUFFIX))
    .map((n) => {
      const filePath = join(dir, n);
      let mtime = 0;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        // unreadable — sort to the front so it's pruned first
      }
      return { filePath, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of files.slice(max)) {
    try {
      rmSync(stale.filePath, { force: true });
    } catch {
      // best-effort
    }
  }
}

// ── Writing ─────────────────────────────────────────────────────────

function serializeLine(line: SessionLine): string {
  return JSON.stringify(line) + '\n';
}

function metaLine(meta: Omit<StoredSessionMeta, 'type' | 'version'>): StoredSessionMeta {
  return { type: 'session-meta', version: SESSION_FILE_VERSION, ...meta };
}

export interface SessionWriterOptions {
  cwd: string;
  sessionId: string;
  provider?: string;
  model?: string;
  createdAt?: string;
  /** Retention cap applied when the transcript is first created. */
  maxSessionsPerCwd?: number;
}

export interface SessionWriter {
  readonly filePath: string;
  /** Persist the current transcript, appending the new tail (or rewriting on compaction). */
  record(messages: AgentMessage[]): void;
}

/**
 * Stateful append-only writer for one transcript. `record(messages)` is meant
 * to be called at each turn boundary with the agent's full `state.messages`:
 *
 *   - First call writes the `session-meta` line, then the messages, and prunes
 *     old transcripts in this cwd.
 *   - Later calls append only the new tail.
 *   - If the array was replaced (compaction changes message[0]'s timestamp, or
 *     the array shrank), the whole file is rewritten so disk matches memory.
 *
 * All writes are synchronous and best-effort: a write failure never throws into
 * the agent loop, it just drops that snapshot (the next turn retries).
 */
export function createSessionWriter(options: SessionWriterOptions): SessionWriter {
  const filePath = getSessionFilePath(options.cwd, options.sessionId);
  // Preserve the original creation time + first-prompt label when resuming an
  // existing transcript; only stamp fresh values for a genuinely new session.
  const existingMeta = existsSync(filePath) ? parseSessionFile(filePath).meta : undefined;
  const createdAt = options.createdAt ?? existingMeta?.createdAt ?? new Date().toISOString();
  // Resolved lazily on the first write (when messages are available), then held
  // stable so compaction can't overwrite the original prompt label.
  let firstUserLabel = existingMeta?.firstUserMessage;

  function buildMeta(): StoredSessionMeta {
    return metaLine({
      sessionId: options.sessionId,
      cwd: normCwd(options.cwd),
      provider: options.provider,
      model: options.model,
      createdAt,
      firstUserMessage: firstUserLabel,
    });
  }

  let initialized = false;
  let writtenCount = 0;
  let firstTimestamp: number | undefined;

  function rewrite(messages: AgentMessage[]): void {
    if (firstUserLabel === undefined) {
      const label = firstUserMessage(messages);
      if (label) firstUserLabel = label;
    }
    const body =
      serializeLine(buildMeta()) +
      messages.map((m) => serializeLine({ type: 'message', message: m })).join('');
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, filePath);
    writtenCount = messages.length;
    firstTimestamp = messages[0]?.timestamp;
  }

  function append(messages: AgentMessage[]): void {
    const tail = messages.slice(writtenCount);
    if (tail.length === 0) return;
    appendFileSync(filePath, tail.map((m) => serializeLine({ type: 'message', message: m })).join(''));
    writtenCount = messages.length;
  }

  return {
    filePath,
    record(messages: AgentMessage[]): void {
      if (messages.length === 0) return;
      try {
        if (!initialized) {
          mkdirSync(getCwdSessionsDir(options.cwd), { recursive: true });
          rewrite(messages);
          initialized = true;
          pruneSessions(options.cwd, options.maxSessionsPerCwd);
          return;
        }
        // Compaction (or clear) replaced the array: the head changed or it
        // shrank. Rewrite so the on-disk prefix stays valid.
        const headChanged = firstTimestamp !== messages[0]?.timestamp;
        if (messages.length < writtenCount || headChanged) {
          rewrite(messages);
          return;
        }
        append(messages);
      } catch {
        // best-effort persistence; never disrupt the session
      }
    },
  };
}
