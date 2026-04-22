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

  const { title, pageSize = 15 } = options;
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
      filtered = items.filter((i) => i.label.toLowerCase().includes(lower));
    }
    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
  }

  function render(): void {
    clearRendered();

    const lines: string[] = [];
    lines.push(chalk.bold(`  ${title}`));

    if (filter) {
      lines.push(chalk.dim(`  search: `) + chalk.cyan(filter));
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

      for (let i = start; i < end; i++) {
        const item = filtered[i];
        const isCurrent = i === cursor;
        const prefix = isCurrent ? chalk.cyan('❯ ') : '  ';
        const label = isCurrent ? chalk.cyan.bold(item.label) : item.label;
        const hint = item.hint ? ' ' + chalk.dim(item.hint) : '';
        lines.push(`  ${prefix}${label}${hint}`);
      }

      if (end < filtered.length) {
        lines.push(chalk.dim('  ↓ more'));
      }
    }

    lines.push('');
    lines.push(
      chalk.dim('  ↑↓ navigate  ⏎ select  esc cancel') +
        (items.length > pageSize ? chalk.dim('  type to filter') : ''),
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
