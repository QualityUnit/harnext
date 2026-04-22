export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

export function truncateTail(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
): TruncationResult {
  const lines = text.split('\n');
  const totalLines = lines.length;

  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { content: text, truncated: false, totalLines, outputLines: totalLines };
  }

  // Take the tail
  let kept = lines.slice(-maxLines);
  let content = kept.join('\n');

  // Truncate by bytes if still too large
  while (Buffer.byteLength(content, 'utf-8') > maxBytes && kept.length > 1) {
    kept = kept.slice(1);
    content = kept.join('\n');
  }

  return { content, truncated: true, totalLines, outputLines: kept.length };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
