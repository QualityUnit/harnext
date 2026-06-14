#!/usr/bin/env node
/**
 * Sample client for harnext's headless *steering* feature.
 *
 * It drives the CLI in streaming-input mode:
 *
 *     harnext -p --input-format stream-json --output-format stream-json
 *
 * In that mode stdin stays open and each line is an NDJSON user message. The
 * first message starts the run; any message sent **while the agent is still
 * generating** is injected into the live run as a steering message (delivered
 * at the next turn boundary) instead of starting a new run. This is the
 * headless equivalent of typing into the REPL mid-run.
 *
 * This client:
 *   1. sends an initial task that takes several turns,
 *   2. waits for the agent's first turn, then sends a steering message that
 *      changes the plan,
 *   3. prints a readable timeline of the stream-json envelopes and the final
 *      result.
 *
 * Run it:
 *     node examples/steering-client.mjs
 *
 * Config via env:
 *     HARNEXT_CLI_PATH   path to the CLI entry (default: ../packages/cli/dist/index.js)
 *     HARNEXT_PROVIDER   provider override (e.g. anthropic, openai)
 *     HARNEXT_MODEL      model id override
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cliPath =
  process.env.HARNEXT_CLI_PATH ??
  fileURLToPath(new URL('../packages/cli/dist/index.js', import.meta.url));

const flags = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  // Let the agent run `echo` without a prompt (this is a demo on safe commands).
  '--permission-mode',
  'bypassPermissions',
];
if (process.env.HARNEXT_PROVIDER) flags.push('--provider', process.env.HARNEXT_PROVIDER);
if (process.env.HARNEXT_MODEL) flags.push('-m', process.env.HARNEXT_MODEL);

// A `.js` entry runs under node; an installed `harnext` binary runs directly.
const isJs = cliPath.endsWith('.js') || cliPath.endsWith('.mjs');
const command = isJs ? process.execPath : cliPath;
const argv = isJs ? [cliPath, ...flags] : flags;

const child = spawn(command, argv, { stdio: ['pipe', 'pipe', 'inherit'] });

/** Send one NDJSON user message on stdin. */
function send(text) {
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
}

const INITIAL =
  'Use the bash tool to run these one at a time, one command per turn, narrating each: ' +
  '`echo one`, then `echo two`, then `echo three`.';
const STEER =
  'Change of plans — stop the echo sequence now and reply with only the single word DONE.';

console.log('client → initial task:\n  ' + INITIAL + '\n');
send(INITIAL);

// Safety net: kill a runaway run.
const killTimer = setTimeout(() => {
  console.error('\n[client] timeout — killing the agent');
  child.kill('SIGKILL');
}, 120_000);

let steered = false;
const assistantText = [];

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let env;
  try {
    env = JSON.parse(line);
  } catch {
    return; // ignore non-JSON noise
  }

  switch (env.type) {
    case 'system':
      console.log(`[init] session ${env.session_id?.slice(0, 8)} · model ${env.model}\n`);
      break;

    case 'assistant': {
      const text = (env.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const tools = (env.message?.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => `${b.name}(${JSON.stringify(b.input)})`);
      if (text) {
        assistantText.push(text);
        console.log('assistant ▸ ' + text);
      }
      for (const t of tools) console.log('assistant ▸ ⚙ ' + t);

      // Steer mid-run, exactly once, after the agent's first turn. The agent is
      // busy here, so this message is injected into the live run (not a new one).
      if (!steered) {
        steered = true;
        console.log('\n>>> client → STEERING mid-run:\n  ' + STEER + '\n');
        send(STEER);
        // No more input after the steer — close stdin so the session ends once
        // this (now redirected) run finishes.
        child.stdin.end();
      }
      break;
    }

    case 'user': // tool_result echoes
      for (const b of env.message?.content ?? []) {
        if (b.type === 'tool_result') {
          console.log('  ↳ tool_result: ' + JSON.stringify(b.content).slice(0, 120));
        }
      }
      break;

    case 'result':
      console.log(
        `\n[result] ${env.subtype} · ${env.num_turns} turns · ` +
          `$${(env.total_cost_usd ?? 0).toFixed(4)}`,
      );
      console.log('[result] final text: ' + JSON.stringify(env.result));
      break;
  }
});

child.on('close', (code) => {
  clearTimeout(killTimer);
  const followed = assistantText.join('\n').includes('DONE');
  console.log('\n──────────────────────────────────────────');
  console.log(`exit code: ${code}`);
  console.log(
    followed
      ? '✓ steering took effect — the agent ended with DONE instead of finishing the echo sequence.'
      : '• run finished — inspect the timeline above to see how the steering message landed.',
  );
  process.exit(code ?? 0);
});
