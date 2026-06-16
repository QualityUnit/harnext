/**
 * Paste store for the interactive textarea (issue #53).
 *
 * The textarea buffer is a single logical line that soft-wraps. A large or
 * multi-line paste inserted inline explodes into many terminal rows and breaks
 * the input frame / caret math. Instead we keep the raw text here and insert a
 * compact placeholder token (`[Pasted text #1 +12 lines]`) into the buffer,
 * expanding it back to the original text only at submit time.
 *
 * The store is pure and side-effect free so it can be unit-tested directly; the
 * textarea owns one instance and drives it from the Ctrl+V/backspace/submit
 * paths.
 */

/** Default thresholds above which a paste is stored instead of inlined. */
export const DEFAULT_PASTE_CHAR_THRESHOLD = 200;

export interface PasteStoreOptions {
  /** Inline pastes at or below this many chars (and single-line). */
  charThreshold?: number;
}

export interface PasteToken {
  /** Byte range of the token within the buffer. */
  start: number;
  end: number;
  /** The placeholder text itself. */
  token: string;
}

export interface PasteStore {
  /** Store `text` and return the placeholder token to insert into the buffer. */
  register(text: string): string;
  /** Replace every known placeholder token in `value` with its raw text. */
  expand(value: string): string;
  /**
   * If a placeholder token ends exactly at `pos` (the caret), return it so the
   * caller can delete the whole token atomically (backspace). Undefined if the
   * caret is not immediately after a token.
   */
  tokenEndingAt(value: string, pos: number): PasteToken | undefined;
  /** Drop all stored entries (e.g. after submit or clear). */
  clear(): void;
  /** Number of stored pastes. */
  readonly size: number;
}

/**
 * Whether a paste should be stored behind a placeholder rather than inlined.
 * True for any multi-line paste (a newline always breaks the single-line
 * buffer) or any paste longer than `charThreshold`.
 */
export function shouldStorePaste(
  text: string,
  options: PasteStoreOptions = {},
): boolean {
  const threshold = options.charThreshold ?? DEFAULT_PASTE_CHAR_THRESHOLD;
  return /\r?\n/.test(text) || text.length > threshold;
}

/** Count of lines in `text` (1 for a single line; trailing newline ignored). */
function countLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalized.split('\n').length;
}

/**
 * A token is `[Pasted text #<id> …]`; the id is what we look up on expand. A
 * fresh `RegExp` is built per use so the `g`-flag `lastIndex` is never shared
 * between `expand` and `tokenEndingAt`.
 */
function tokenRegex(): RegExp {
  return /\[Pasted text #(\d+)[^\]]*\]/g;
}

export function createPasteStore(): PasteStore {
  const entries = new Map<number, string>();
  let nextId = 1;

  function placeholderFor(id: number, text: string): string {
    if (/\r?\n/.test(text)) {
      const lines = countLines(text);
      return `[Pasted text #${id} +${lines} line${lines === 1 ? '' : 's'}]`;
    }
    return `[Pasted text #${id} ${text.length} chars]`;
  }

  return {
    register(text: string): string {
      const id = nextId++;
      entries.set(id, text);
      return placeholderFor(id, text);
    },

    expand(value: string): string {
      return value.replace(tokenRegex(), (match, idStr: string) => {
        const id = Number(idStr);
        const raw = entries.get(id);
        return raw !== undefined ? raw : match; // leave unknown tokens as typed
      });
    },

    tokenEndingAt(value: string, pos: number): PasteToken | undefined {
      const re = tokenRegex();
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) {
        const start = m.index;
        const end = m.index + m[0].length;
        // Only treat as ours if the id is actually stored (avoid grabbing a
        // user-typed look-alike).
        if (end === pos && entries.has(Number(m[1]))) {
          return { start, end, token: m[0] };
        }
      }
      return undefined;
    },

    clear(): void {
      entries.clear();
      // Ids keep incrementing across clears so a stale token left in scrollback
      // never collides with a fresh entry's id.
    },

    get size(): number {
      return entries.size;
    },
  };
}
