import { emitKeypressEvents } from 'node:readline';

import chalk from 'chalk';

export interface SelectItem<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface SelectOptions {
  title: string;
  pageSize?: number;
  /**
   * Show the type-to-search bar and enable filtering. Default true. Set false
   * for short, fixed action menus (e.g. Refresh / Kill / Back) where search is
   * just noise.
   */
  searchable?: boolean;
}

/**
 * Fuzzy-match a pattern against a target string. Each character in `pattern`
 * must appear in `target` in order (but not necessarily contiguously). The
 * match is anchored: the first pattern char must match the first target char,
 * and after that the algorithm prefers consecutive matches (lower gap penalty).
 *
 * Returns a score ≥ 0 when matched, or -1 when unmatched. Lower scores are
 * better (fewer gaps = more consecutive).
 */
function fuzzyScore(pattern: string, target: string): number {
  let pi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < target.length && pi < pattern.length; ti++) {
    if (target[ti] === pattern[pi]) {
      // Penalty for gaps between matches (consecutive = no penalty)
      if (ti > prevMatch + 1) score += ti - prevMatch - 1;
      prevMatch = ti;
      pi++;
    }
  }
  return pi === pattern.length ? score : -1;
}

/**
 * Interactive select box with arrow-key navigation and type-ahead filtering.
 *
 * - Up/Down arrows to navigate
 * - Type to filter
 * - Enter to select
 * - Escape to cancel
 */
export async function select<T>(
  items: SelectItem<T>[],
  options: SelectOptions,
): Promise<T | undefined> {
  if (items.length === 0) return undefined;

  const { title, pageSize = 15, searchable = true } = options;
  let cursor = 0;
  let filter = '';
  let filtered = items;
  let linesRendered = 0;

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;

  if (stdin.isTTY) stdin.setRawMode(true);
  emitKeypressEvents(stdin);
  stdin.resume();

  function clearRendered(): void {
    if (linesRendered > 0) {
      process.stdout.write(`\x1B[${linesRendered}F\x1B[J`);
      linesRendered = 0;
    }
  }

  function applyFilter(): void {
    if (!filter) {
      filtered = items;
    } else {
      const lower = filter.toLowerCase();
      // Primary: fuzzy match on label. Fallback: substring match on hint.
      const scored = items.map((item) => {
        const labelScore = fuzzyScore(lower, item.label.toLowerCase());
        if (labelScore >= 0) return { item, score: labelScore };
        // Fallback: substring match on hint (if present)
        if (item.hint && item.hint.toLowerCase().includes(lower)) {
          return { item, score: 1000 }; // hint matches rank below label matches
        }
        return { item, score: -1 };
      });
      filtered = scored
        .filter((s) => s.score >= 0)
        .sort((a, b) => a.score - b.score)
        .map((s) => s.item);
    }
    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
  }

  function render(): void {
    clearRendered();

    const lines: string[] = [];
    lines.push(chalk.bold(`  ${title}`));

    // Search bar with a blinking cursor so the user knows they can start typing
    // immediately. Suppressed for non-searchable menus (short action lists).
    if (searchable) {
      if (filter) {
        lines.push(chalk.dim('  search: ') + chalk.cyan(filter) + '█');
      } else {
        lines.push(chalk.dim('  search: ') + '█  ' + chalk.dim.italic('type to search…'));
      }
    }

    lines.push('');

    if (filtered.length === 0) {
      lines.push(chalk.dim('  No matches'));
    } else {
      const half = Math.floor(pageSize / 2);
      let start = Math.max(0, cursor - half);
      const end = Math.min(filtered.length, start + pageSize);
      start = Math.max(0, end - pageSize);

      if (start > 0) {
        lines.push(chalk.dim('  ↑ more'));
      }

      // Clamp each row to the terminal width so a long label/hint (e.g. a
      // verbose background-job command) never wraps — a wrapped row would make
      // the in-place redraw (clearRendered) miscount and corrupt the box. The
      // secondary hint is truncated first, then the label if it alone overflows.
      const termW = Math.max(20, process.stdout.columns || 80); // || so 0/undefined → 80
      const avail = Math.max(8, termW - 4); // 4 = 2 leading spaces + 2 chevron
      for (let i = start; i < end; i++) {
        const item = filtered[i];
        const isCurrent = i === cursor;
        const prefix = isCurrent ? chalk.cyan('❯ ') : '  ';
        let labelText = item.label;
        let hintText = item.hint ?? '';
        if (labelText.length > avail) {
          labelText = labelText.slice(0, avail - 1) + '…';
          hintText = '';
        } else if (hintText) {
          const hintBudget = avail - labelText.length - 1; // 1 = separating space
          if (hintBudget < 2) hintText = '';
          else if (hintText.length > hintBudget) hintText = hintText.slice(0, hintBudget - 1) + '…';
        }
        const label = isCurrent ? chalk.cyan.bold(labelText) : labelText;
        const hint = hintText ? ' ' + chalk.dim(hintText) : '';
        lines.push(`  ${prefix}${label}${hint}`);
      }

      if (end < filtered.length) {
        lines.push(chalk.dim('  ↓ more'));
      }
    }

    lines.push('');
    lines.push(
      chalk.dim(
        searchable
          ? '  ↑↓ navigate  ⏎ select  esc cancel  type to search'
          : '  ↑↓ navigate  ⏎ select  esc cancel',
      ),
    );

    for (const line of lines) {
      process.stdout.write(line + '\n');
    }
    linesRendered = lines.length;
  }

  render();

  return new Promise<T | undefined>((resolve) => {
    const cleanup = (value: T | undefined) => {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      clearRendered();
      resolve(value);
    };

    const onKeypress = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string },
    ) => {
      if (!key) return;

      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup(undefined);
        return;
      }

      if (key.name === 'return') {
        const selected = filtered[cursor]?.value;
        cleanup(selected);
        return;
      }

      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === 'down') {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
        return;
      }

      if (!searchable) return; // no filtering on fixed action menus

      if (key.name === 'backspace') {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          applyFilter();
          render();
        }
        return;
      }

      if (_str && _str.length === 1 && !key.ctrl && !key.meta && _str.charCodeAt(0) >= 32) {
        filter += _str;
        applyFilter();
        render();
      }
    };

    stdin.on('keypress', onKeypress);
  });
}
