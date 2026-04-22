import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk from 'chalk';

import { select, type SelectItem } from './select.js';

interface EditorChoiceExternal {
  kind: 'external';
  /** Display label shown in the picker. */
  label: string;
  /** Hint shown next to the label in the picker. */
  hint: string;
  /** Resolved command + args. The temp file path is appended at spawn time. */
  command: string;
  args: string[];
}

interface EditorChoiceInline {
  kind: 'inline';
  label: string;
  hint: string;
}

type EditorChoice = EditorChoiceExternal | EditorChoiceInline;

export interface EditPromptOptions {
  /** Title shown at the top of the picker. */
  title: string;
  /**
   * When false, an empty result from the editor is treated as cancel and this
   * function returns undefined. When true (default), empty results return the
   * original `currentPrompt` — the safe "no change" semantics.
   */
  allowEmpty?: boolean;
}

const KNOWN_EDITORS: Array<{ cmd: string; label: string }> = [
  { cmd: 'code', label: 'VSCode (code)' },
  { cmd: 'nvim', label: 'Neovim' },
  { cmd: 'vim', label: 'Vim' },
  { cmd: 'nano', label: 'Nano' },
];

/** Very small arg splitter — handles `EDITOR="code --wait"` style values. Not a full shell parser. */
function splitEditorEnv(raw: string): { command: string; args: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { command: '', args: [] };
  const parts = trimmed.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function isOnPath(cmd: string): boolean {
  try {
    execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

function detectEditors(): EditorChoice[] {
  const choices: EditorChoice[] = [];
  const seen = new Set<string>();

  const addExternal = (raw: { command: string; args: string[] }, label: string, hint: string) => {
    if (!raw.command) return;
    const key = [raw.command, ...raw.args].join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    choices.push({ kind: 'external', label, hint, command: raw.command, args: raw.args });
  };

  const visual = process.env.VISUAL ?? '';
  if (visual.trim()) {
    const parsed = splitEditorEnv(visual);
    addExternal(parsed, parsed.command + (parsed.args.length ? ` ${parsed.args.join(' ')}` : ''), '$VISUAL');
  }

  const editor = process.env.EDITOR ?? '';
  if (editor.trim()) {
    const parsed = splitEditorEnv(editor);
    addExternal(parsed, parsed.command + (parsed.args.length ? ` ${parsed.args.join(' ')}` : ''), '$EDITOR');
  }

  for (const { cmd, label } of KNOWN_EDITORS) {
    if (isOnPath(cmd)) {
      addExternal({ command: cmd, args: [] }, label, 'on PATH');
    }
  }

  choices.push({
    kind: 'inline',
    label: 'Inline (type in terminal, end with empty line)',
    hint: 'fallback',
  });

  return choices;
}

function normalizeResult(contents: string): string {
  const unified = contents.replace(/\r\n/g, '\n');
  const lines = unified.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function readLineOnce(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runInlineEditor(currentPrompt: string): Promise<string> {
  if (currentPrompt) {
    console.log(chalk.dim('  Current prompt:'));
    for (const line of currentPrompt.split('\n')) {
      console.log(chalk.dim(`    ${line}`));
    }
  }
  console.log(
    chalk.dim('  Type the new prompt. End with an empty line. Leave empty to keep current.'),
  );
  const lines: string[] = [];
  for (;;) {
    const line = await readLineOnce(chalk.cyan('  > '));
    if (line.length === 0) break;
    lines.push(line);
  }
  const joined = lines.join('\n').trim();
  return joined.length > 0 ? joined : currentPrompt;
}

function runExternalEditor(
  choice: EditorChoiceExternal,
  currentPrompt: string,
): { ok: true; text: string } | { ok: false; message: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harnext-prompt-'));
  const file = join(dir, 'prompt.md');
  try {
    writeFileSync(file, currentPrompt, 'utf-8');

    // VSCode (and a couple of other GUI editors) return immediately unless
    // asked to block. Inject --wait for `code` if the user hasn't already.
    let args = [...choice.args];
    if (choice.command === 'code' && !args.includes('--wait') && !args.includes('-w')) {
      args = ['--wait', ...args];
    }
    args.push(file);

    const result = spawnSync(choice.command, args, { stdio: 'inherit' });
    if (result.error) {
      return { ok: false, message: result.error.message };
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      return { ok: false, message: `editor exited with status ${result.status}` };
    }
    const raw = readFileSync(file, 'utf-8');
    return { ok: true, text: normalizeResult(raw) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pick an editor and edit a text prompt in it. Returns the (possibly edited)
 * prompt, or `undefined` when `allowEmpty: false` and the result is empty.
 */
export async function editPrompt(
  currentPrompt: string,
  opts: EditPromptOptions,
): Promise<string | undefined> {
  const allowEmpty = opts.allowEmpty ?? true;
  const choices = detectEditors();
  const items: SelectItem<EditorChoice>[] = choices.map((c) => ({
    label: c.label,
    value: c,
    hint: c.hint,
  }));

  const picked = await select(items, { title: opts.title });
  if (!picked) {
    // User escaped — treat as cancel. Keep the current value.
    return allowEmpty ? currentPrompt : currentPrompt.trim().length > 0 ? currentPrompt : undefined;
  }

  let text: string;
  if (picked.kind === 'inline') {
    text = await runInlineEditor(currentPrompt);
  } else {
    const result = runExternalEditor(picked, currentPrompt);
    if (!result.ok) {
      console.log(chalk.yellow(`  Could not run editor: ${result.message}`));
      // Let the user pick a different editor.
      return editPrompt(currentPrompt, opts);
    }
    text = result.text;
  }

  if (text.trim().length === 0) {
    if (allowEmpty) return currentPrompt;
    return currentPrompt.trim().length > 0 ? currentPrompt : undefined;
  }
  return text;
}
