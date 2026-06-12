import { join } from 'node:path';

import type { TokenClassificationPipeline } from '@huggingface/transformers';

import { getHarnextHome } from '../config.js';

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

/**
 * Lifecycle/download status emitted while loading the PII model. Consumers
 * (the CLI's interactive mode) use these to surface a progress line on the
 * pinned spinner during the first download from HuggingFace. After the model
 * is cached, subsequent sessions go straight from `loading` to `ready` with
 * no `downloading` events in between.
 */
export type PiiMaskerProgress =
  | { type: 'loading' }
  | { type: 'downloading'; file: string; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'error'; error: Error };

export interface PiiMasker {
  /** Load the model (download on first call, then resolve from local cache). Idempotent. */
  ready(): Promise<void>;
  /** Mask PII in `text`. Throws if the model fails to load. */
  mask(text: string): Promise<MaskResult>;
  /** Drop the in-memory model. Does not delete the on-disk cache. */
  dispose(): void;
}

export interface CreatePiiMaskerOptions {
  /** HuggingFace repo id. Defaults to harnext's published int8 quantized export. */
  modelId?: string;
  /** Quantization variant. `q8` = int8 (~165 MB, recommended). */
  dtype?: 'q8' | 'fp32' | 'fp16';
  /**
   * Where transformers.js caches downloaded weights. Defaults to
   * `~/.harnext/models/` so it persists across `npm install` in dev and
   * doesn't leak into a project's node_modules.
   */
  cacheDir?: string;
  /** Status hook for download progress and lifecycle events. */
  onProgress?: (status: PiiMaskerProgress) => void;
}

const DEFAULT_MODEL_ID = 'YashaBor/OpenMed-PII-SuperClinical-Small-44M-v1-ONNX';

class PiiMaskerImpl implements PiiMasker {
  private nlp: TokenClassificationPipeline | null = null;
  private readyPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly opts: Required<Omit<CreatePiiMaskerOptions, 'onProgress'>> & {
      onProgress?: (status: PiiMaskerProgress) => void;
    },
  ) {}

  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('PII masker disposed'));
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.load();
    return this.readyPromise;
  }

  private async load(): Promise<void> {
    this.opts.onProgress?.({ type: 'loading' });
    try {
      // Imported lazily so requiring @harnext/core never loads onnxruntime's
      // native binding — it's missing on some platforms (e.g. macOS x64) and
      // would crash the whole CLI at startup even when masking is unused.
      const { env, pipeline } = await import('@huggingface/transformers');
      // Setting cacheDir is process-global in transformers.js. That's fine —
      // there's only ever one masker per harnext process.
      env.cacheDir = this.opts.cacheDir;
      this.nlp = (await pipeline('token-classification', this.opts.modelId, {
        dtype: this.opts.dtype,
        progress_callback: (event: unknown) => this.handleProgress(event),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as TokenClassificationPipeline;
      this.opts.onProgress?.({ type: 'ready' });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.opts.onProgress?.({ type: 'error', error });
      throw error;
    }
  }

  // transformers.js emits one event per file (config, tokenizer, model, etc.)
  // with status: initiate | download | progress | done, and a final
  // {status:'ready', task, model}. We forward only the pieces interactive
  // mode actually uses for its progress line.
  private handleProgress(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;
    if (
      e.status === 'progress' &&
      typeof e.loaded === 'number' &&
      typeof e.total === 'number'
    ) {
      this.opts.onProgress?.({
        type: 'downloading',
        file: typeof e.file === 'string' ? e.file : '',
        loaded: e.loaded,
        total: e.total,
      });
    }
  }

  async mask(text: string): Promise<MaskResult> {
    if (this.disposed) throw new Error('PII masker disposed');
    await this.ready();
    if (!this.nlp) throw new Error('PII masker not loaded');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await this.nlp(text, { aggregation_strategy: 'simple' } as any)) as RawEntity[];
    const cleaned = trimDedupeMerge(raw, text);
    return { masked: maskText(text, cleaned), entities: cleaned };
  }

  dispose(): void {
    this.disposed = true;
    this.nlp = null;
  }
}

interface RawEntity {
  entity_group?: string;
  start?: number;
  end?: number;
  word?: string;
  score?: number;
}

/**
 * transformers.js's token-classification pipeline returns `{entity_group,
 * word, score}` but omits `start`/`end` (unlike the Python reference, which
 * propagates the tokenizer's offsets). So we re-derive spans by doing an
 * ordered indexOf of each `word` against the source text — entities come
 * back in left-to-right reading order, so a forward-moving cursor is enough.
 */
function attachSpans(raw: RawEntity[], text: string): PiiEntity[] {
  const out: PiiEntity[] = [];
  let cursor = 0;
  for (const e of raw) {
    if (!e.entity_group || typeof e.word !== 'string' || e.word.length === 0) continue;
    const start = text.indexOf(e.word, cursor);
    if (start < 0) continue;
    const end = start + e.word.length;
    out.push({
      entity_group: e.entity_group,
      start,
      end,
      word: e.word,
      score: typeof e.score === 'number' ? e.score : 0,
    });
    cursor = end;
  }
  return out;
}

/**
 * Same post-processing the Python reference script applies:
 * 1. Trim leading/trailing whitespace from each span.
 * 2. Drop empty spans.
 * 3. Resolve overlapping spans — longer wins, ties broken by score.
 * 4. Merge consecutive same-label spans separated only by whitespace, so a
 *    fragmented "John  Smith" tagged twice becomes one entity.
 */
function trimDedupeMerge(raw: RawEntity[], text: string): PiiEntity[] {
  const withSpans = attachSpans(raw, text);
  const entities: PiiEntity[] = [];
  for (const e of withSpans) {
    let s = e.start;
    let end = e.end;
    while (s < end && /\s/.test(text[s])) s++;
    while (end > s && /\s/.test(text[end - 1])) end--;
    if (s >= end) continue;
    entities.push({
      entity_group: e.entity_group,
      start: s,
      end,
      word: text.slice(s, end),
      score: e.score,
    });
  }

  // Dedupe: longest-first, drop any later span that overlaps a kept one.
  entities.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: PiiEntity[] = [];
  for (const e of entities) {
    const overlaps = kept.some((k) => e.start < k.end && e.end > k.start);
    if (!overlaps) kept.push(e);
  }
  kept.sort((a, b) => a.start - b.start);

  // Merge adjacent same-label spans separated only by whitespace.
  const merged: PiiEntity[] = [];
  for (const e of kept) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.entity_group === e.entity_group &&
      text.slice(prev.end, e.start).trim() === ''
    ) {
      prev.end = e.end;
      prev.word = text.slice(prev.start, prev.end);
      prev.score = Math.min(prev.score, e.score);
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

function maskText(text: string, entities: PiiEntity[]): string {
  const sorted = [...entities].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const e of sorted) {
    parts.push(text.slice(cursor, e.start));
    parts.push(`[${e.entity_group.toUpperCase()}]`);
    cursor = e.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function createPiiMasker(options: CreatePiiMaskerOptions = {}): PiiMasker {
  return new PiiMaskerImpl({
    modelId: options.modelId ?? DEFAULT_MODEL_ID,
    dtype: options.dtype ?? 'q8',
    cacheDir: options.cacheDir ?? join(getHarnextHome(), 'models'),
    onProgress: options.onProgress,
  });
}

/**
 * Mask PII in the text blocks of a tool result's content array. Non-text
 * blocks pass through unchanged. Used by secure mode to keep file contents
 * fetched by the read tool from leaking to the LLM — the user's prompt is
 * masked before submit, but tool results travel a separate path back into
 * the conversation transcript.
 */
export async function maskToolResultContent<T extends { type: string }>(
  content: ReadonlyArray<T>,
  masker: PiiMasker,
): Promise<T[]> {
  const out: T[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof (block as unknown as { text?: unknown }).text === 'string') {
      const { masked } = await masker.mask((block as unknown as { text: string }).text);
      out.push({ ...block, text: masked });
    } else {
      out.push(block);
    }
  }
  return out;
}
