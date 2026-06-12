import { VERSION } from '@harnext/core';

export type Mode =
  | 'interactive'
  | 'print'
  | 'heartbeat'
  | 'mcp'
  | 'runner'
  | 'setup'
  | 'status'
  | 'upgrade'
  | 'connect';
export type McpVerb = 'add' | 'remove' | 'list' | 'reconnect';
export type McpScopeArg = 'user' | 'project';
export type RunnerVerb = 'status' | 'logs';
export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

export interface Args {
  mode: Mode;
  /** Undefined if not passed on the command line — resolved later from saved preferences. */
  provider?: string;
  /** Undefined if not passed on the command line — resolved later from saved preferences. */
  model?: string;
  thinkingLevel: string;
  systemPrompt?: string;
  /** Text appended to the system prompt (Claude SDK `append_system_prompt`). */
  appendSystemPrompt?: string;
  cwd: string;
  messages: string[];
  /** Auto-approve list (Claude SDK `allowed_tools`). */
  allowedTools?: string[];
  /** Block list (Claude SDK `disallowed_tools`). */
  disallowedTools?: string[];
  /** Permission mode (Claude SDK `permission_mode`). */
  permissionMode?: string;
  /** Stop after this many assistant turns (Claude SDK `max_turns`). */
  maxTurns?: number;
  /** CLAUDE.md sources to load (Claude SDK `setting_sources`): user|project|local. */
  settingSources?: string[];
  /** Extra accessible directories (Claude SDK `add_dirs`). Accepted; not yet enforced. */
  addDirs?: string[];
  /** Fallback model (Claude SDK `fallback_model`). Accepted; not yet enforced. */
  fallbackModel?: string;
  /** Output format for print mode: text (default), json, or stream-json. */
  outputFormat?: OutputFormat;
  /** Input format for print mode: text (default) or stream-json (NDJSON on stdin). */
  inputFormat?: InputFormat;
  /** Raw sandbox JSON (Claude SDK `sandbox`). Accepted for parity; currently a no-op. */
  sandbox?: string;
  /** Heartbeat name — only set when mode === 'heartbeat'. */
  heartbeatName?: string;
  /** MCP subcommand — only set when mode === 'mcp'. */
  mcpVerb?: McpVerb;
  mcpName?: string;
  mcpScope?: McpScopeArg;
  mcpUrl?: string;
  mcpHeaders?: string[];
  mcpLifecycle?: 'lazy' | 'eager' | 'keep-alive';
  mcpDirect?: boolean;
  /** Positional args after `--` for mcp add stdio: command + args. */
  mcpCommandArgs?: string[];
  /** `harnext upgrade --check` — preview only, do not run npm install. */
  upgradeCheck?: boolean;
  /** `harnext upgrade --force` — reinstall even when already on latest. */
  upgradeForce?: boolean;
  /** Runner subcommand verb — only set when mode === 'runner'. */
  runnerVerb?: RunnerVerb;
  /** `harnext runner logs --lines N` — tail buffer size; default 50. */
  runnerLogLines?: number;
  /** `harnext runner logs --no-follow` — dump and exit instead of `tail -f`. */
  runnerLogNoFollow?: boolean;
  /** `harnext connect --endpoint <url>` — context engine to link this machine to. */
  connectEndpoint?: string;
  /** `harnext connect --disable` — turn cloud sync off (keep the stored login). */
  connectDisable?: boolean;
}

/**
 * Append comma-separated values to a list arg, supporting both repeated flags
 * (`--allowed-tools Read --allowed-tools Bash`) and inline CSV
 * (`--allowed-tools Read,Bash`). Returns undefined only when nothing accumulated.
 */
function appendCsv(existing: string[] | undefined, raw: string | undefined): string[] | undefined {
  if (raw === undefined) return existing;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return existing;
  return [...(existing ?? []), ...parts];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'interactive',
    thinkingLevel: 'off',
    cwd: process.cwd(),
    messages: [],
  };

  if (argv[0] === 'mcp') {
    return parseMcpArgs(argv.slice(1), args);
  }

  if (argv[0] === 'setup') {
    return parseSetupArgs(argv.slice(1), args);
  }

  if (argv[0] === 'status') {
    return parseStatusArgs(argv.slice(1), args);
  }

  if (argv[0] === 'upgrade' || argv[0] === 'update') {
    return parseUpgradeArgs(argv.slice(1), args);
  }

  if (argv[0] === 'runner') {
    return parseRunnerArgs(argv.slice(1), args);
  }

  if (argv[0] === 'connect') {
    return parseConnectArgs(argv.slice(1), args);
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '-p':
      case '--print':
        args.mode = 'print';
        break;
      case '--heartbeat':
        args.mode = 'heartbeat';
        args.heartbeatName = argv[++i];
        break;
      case '--provider':
        args.provider = argv[++i] ?? args.provider;
        break;
      case '-m':
      case '--model':
        args.model = argv[++i] ?? args.model;
        break;
      case '--thinking':
        args.thinkingLevel = argv[++i] ?? args.thinkingLevel;
        break;
      case '--system-prompt':
        args.systemPrompt = argv[++i];
        break;
      case '--append-system-prompt':
        args.appendSystemPrompt = argv[++i];
        break;
      case '--allowed-tools':
      case '--allowedTools':
        args.allowedTools = appendCsv(args.allowedTools, argv[++i]);
        break;
      case '--disallowed-tools':
      case '--disallowedTools':
        args.disallowedTools = appendCsv(args.disallowedTools, argv[++i]);
        break;
      case '--permission-mode':
        args.permissionMode = argv[++i];
        break;
      case '--max-turns': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) args.maxTurns = Math.floor(n);
        break;
      }
      case '--setting-sources':
        args.settingSources = appendCsv(args.settingSources, argv[++i]);
        break;
      case '--add-dir':
        if (argv[++i]) args.addDirs = [...(args.addDirs ?? []), argv[i]];
        break;
      case '--fallback-model':
        args.fallbackModel = argv[++i];
        break;
      case '--output-format':
        args.outputFormat = argv[++i] as OutputFormat;
        break;
      case '--input-format':
        args.inputFormat = argv[++i] as InputFormat;
        break;
      case '--sandbox':
        args.sandbox = argv[++i];
        break;
      case '--cwd':
        args.cwd = argv[++i] ?? args.cwd;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '-v':
      case '--version':
        console.log(VERSION);
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-')) {
          args.messages.push(arg);
        }
        break;
    }
    i++;
  }

  return args;
}

function parseStatusArgs(rest: string[], args: Args): Args {
  args.mode = 'status';
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--cwd':
        args.cwd = rest[++i] ?? args.cwd;
        break;
      case '-h':
      case '--help':
        printStatusHelp();
        process.exit(0);
        break;
      default:
        break;
    }
    i++;
  }
  return args;
}

export function printStatusHelp(): void {
  console.log(`
harnext status - Show active coding-agent runs for this project

Usage:
  harnext status [--cwd <directory>]

Lists each registered worktree (per open issue/PR), the branch checked out,
any coding-agent process currently running against it (with stage + elapsed
time), and the uncommitted file changes present in the worktree.
`);
}

function parseUpgradeArgs(rest: string[], args: Args): Args {
  args.mode = 'upgrade';
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--check':
        args.upgradeCheck = true;
        break;
      case '--force':
        args.upgradeForce = true;
        break;
      case '-h':
      case '--help':
        printUpgradeHelp();
        process.exit(0);
        break;
      default:
        break;
    }
    i++;
  }
  return args;
}

export function printUpgradeHelp(): void {
  console.log(`
harnext upgrade (or: harnext update) - Install the latest published harnext from npm

Usage:
  harnext upgrade [--check] [--force]
  harnext update  [--check] [--force]

Options:
  --check                  Print the available version without installing
  --force                  Reinstall even when already on the latest version

Runs 'npm install -g harnext@<latest>' under the hood, so the user's existing
global prefix, registry, and auth settings are respected.
`);
}

function parseRunnerArgs(rest: string[], args: Args): Args {
  args.mode = 'runner';
  if (rest[0] === '-h' || rest[0] === '--help') {
    printRunnerHelp();
    process.exit(0);
  }
  const verbRaw = rest[0];
  if (!verbRaw || verbRaw.startsWith('-')) {
    return args; // missing verb — handled downstream
  }
  args.runnerVerb = verbRaw as RunnerVerb;
  let i = 1;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--cwd':
        args.cwd = rest[++i] ?? args.cwd;
        break;
      case '-n':
      case '--lines': {
        const n = Number(rest[++i]);
        if (Number.isFinite(n) && n > 0) args.runnerLogLines = Math.floor(n);
        break;
      }
      case '--no-follow':
        args.runnerLogNoFollow = true;
        break;
      case '-h':
      case '--help':
        printRunnerHelp();
        process.exit(0);
        break;
      default:
        break;
    }
    i++;
  }
  return args;
}

export function printRunnerHelp(): void {
  console.log(`
harnext runner - Inspect this project's self-hosted GitHub Actions runner

Usage:
  harnext runner status [--cwd <directory>]
  harnext runner logs   [--cwd <directory>] [-n N | --lines N] [--no-follow]

Verbs:
  status                   Show local registration, daemon state (systemd/launchd),
                           and how GitHub currently sees the runner.
  logs                     Tail the latest <installDir>/_diag/Runner_*.log
                           (default: follow with -n 50; use --no-follow for a
                           one-shot dump).

The runner is registered automatically by \`harnext setup\` when any pipeline
stage is set to "self-hosted". These commands are read-only — they never
start, stop, or reconfigure the daemon.
`);
}

function parseConnectArgs(rest: string[], args: Args): Args {
  args.mode = 'connect';
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--endpoint':
      case '--url':
        args.connectEndpoint = rest[++i];
        break;
      case '--disable':
      case '--disconnect':
        args.connectDisable = true;
        break;
      case '--cwd':
        args.cwd = rest[++i] ?? args.cwd;
        break;
      case '-h':
      case '--help':
        printConnectHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-') && !args.connectEndpoint) args.connectEndpoint = arg;
        break;
    }
    i++;
  }
  return args;
}

export function printConnectHelp(): void {
  console.log(`
harnext connect - Link this machine to a context engine (push conversations)

Usage:
  harnext connect [--endpoint <url>]
  harnext connect --disable

Runs the OAuth device flow: prints a URL to approve in the engine's dashboard,
waits for approval, then stores the tokens and turns on cloud sync. Every
conversation is then streamed to the engine, turn by turn.

With no endpoint, connects to the official engine at https://app.harnext.dev.

Options:
  --endpoint, --url <url>  Context engine base URL (default: https://app.harnext.dev)
  --disable                Turn cloud sync off (keeps the stored login)
  --cwd <directory>        Working directory [default: .]
`);
}

function parseSetupArgs(rest: string[], args: Args): Args {
  args.mode = 'setup';
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '--cwd':
        args.cwd = rest[++i] ?? args.cwd;
        break;
      case '-h':
      case '--help':
        printSetupHelp();
        process.exit(0);
        break;
      default:
        break;
    }
    i++;
  }
  return args;
}

export function printSetupHelp(): void {
  console.log(`
harnext setup - Configure this project's coding agent and pipeline

Usage:
  harnext setup [--cwd <directory>]

Asks which coding agent should drive the pipeline (harnext | claude-code |
codex), picks a model for that agent, then runs the GitHub connection
wizard (polling interval, issue filter, workflow stages). When a config
already exists, asks first whether to keep it.
`);
}

function parseMcpArgs(rest: string[], args: Args): Args {
  args.mode = 'mcp';
  if (rest[0] === '-h' || rest[0] === '--help') {
    printMcpHelp();
    process.exit(0);
  }
  const verbRaw = rest[0];
  if (!verbRaw || verbRaw.startsWith('-')) {
    return args; // treated as missing verb; handled by runner
  }
  args.mcpVerb = verbRaw as McpVerb;
  args.mcpHeaders = [];

  let i = 1;
  const positional: string[] = [];
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === '--') {
      args.mcpCommandArgs = rest.slice(i + 1);
      break;
    }
    switch (arg) {
      case '--scope':
        args.mcpScope = rest[++i] as McpScopeArg;
        break;
      case '--url':
        args.mcpUrl = rest[++i];
        break;
      case '--header':
      case '-H':
        if (rest[++i]) args.mcpHeaders!.push(rest[i]);
        break;
      case '--lifecycle':
        args.mcpLifecycle = rest[++i] as 'lazy' | 'eager' | 'keep-alive';
        break;
      case '--direct':
        args.mcpDirect = true;
        break;
      case '--cwd':
        args.cwd = rest[++i] ?? args.cwd;
        break;
      case '-h':
      case '--help':
        printMcpHelp();
        process.exit(0);
        break;
      default:
        if (!arg.startsWith('-')) positional.push(arg);
        break;
    }
    i++;
  }

  if (positional.length > 0) args.mcpName = positional[0];
  return args;
}

export function printMcpHelp(): void {
  console.log(`
harnext mcp - Manage MCP (Model Context Protocol) servers

Usage:
  harnext mcp add <name> [--scope user|project] [--lifecycle lazy|eager|keep-alive] [--direct] -- <command> [args...]
  harnext mcp add <name> --url <url> [--header "K: V"] [--scope user|project]
  harnext mcp list [--scope user|project]
  harnext mcp remove <name> [--scope user|project]
  harnext mcp reconnect <name>

Options:
  --scope <user|project>   Where to write the config (default: user)
  --lifecycle <mode>       lazy (default) | eager | keep-alive
  --direct                 Register tools directly (bypass proxy) for this server
  --url <url>              HTTP transport URL (instead of stdio command)
  --header, -H "K: V"      HTTP header (repeatable)
`);
}

export function printHelp(): void {
  console.log(`
harnext - AI coding agent

Usage:
  harnext [options] [message...]
  harnext setup [--cwd <directory>]
  harnext mcp <verb> [...]

Options:
  -p, --print                  Run in non-interactive (single-shot) mode
  --heartbeat <name>           Run the named heartbeat prompt once (for cron)
  --provider <provider>        LLM provider (anthropic, openai, google) [default: anthropic]
  -m, --model <model>          Model ID [default: claude-sonnet-4-6]
  --fallback-model <model>     Model to fall back to (accepted; reserved)
  --thinking <level>           Thinking level (off, low, medium, high) [default: off]
  --system-prompt <text>       Override system prompt
  --append-system-prompt <t>   Append text to the system prompt
  --allowed-tools <csv>        Auto-approve tools (repeatable / comma-separated)
  --disallowed-tools <csv>     Block tools (repeatable / comma-separated)
  --permission-mode <mode>     default | acceptEdits | plan | dontAsk | bypassPermissions
  --max-turns <n>              Stop after n assistant turns
  --setting-sources <csv>      Load CLAUDE.md from: user, project, local
  --add-dir <dir>              Extra accessible directory (repeatable; reserved)
  --output-format <fmt>        text (default) | json | stream-json
  --input-format <fmt>         text (default) | stream-json
  --sandbox <json>             Sandbox config (accepted for parity; currently a no-op)
  --cwd <directory>            Working directory [default: .]
  -h, --help                   Show this help
  -v, --version                Show version

Subcommands:
  setup                    Pick a coding agent and configure the project pipeline
  status                   Show active coding-agent runs (worktrees + processes)
  upgrade, update          Install the latest harnext from npm
  mcp                      Manage MCP servers (run \`harnext mcp --help\`)
  runner                   Inspect the self-hosted runner (run \`harnext runner --help\`)
  connect                  Link a context engine to push conversations (run \`harnext connect --help\`)
`);
}
