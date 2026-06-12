# CLAUDE.md

## Project Overview

Harnext is an AI coding agent with harness engineering. Built on the pi-agent-core runtime, it provides an interactive coding agent that can read, write, edit files and run shell commands. Written in TypeScript (ESM), runs on Node.js >= 20.

This is a monorepo with npm workspaces containing two packages:
- `@harnext/core` — Reusable library (agent session, tools, SDK, auth, providers)
- `harnext` (CLI) — Interactive terminal UI and CLI binary

## Build & Run Commands

```bash
npm install              # Install dependencies (workspace-aware)
npm run build            # Build core, then CLI
npm run build:core       # Build only @harnext/core
npm run build:cli        # Build only the CLI
npm run dev              # Build in watch mode (all packages)
npm test                 # Run all tests (vitest run)
npm run lint             # Lint all packages
npm run typecheck        # Type-check all packages

# Run the agent
node packages/cli/dist/index.js                          # Interactive REPL
node packages/cli/dist/index.js -p --prompt "list files" # One-shot mode
node packages/cli/dist/index.js --provider openai -m gpt-4o  # Different provider/model
```

## Code Style Rules

- **Formatter**: Prettier — single quotes, semicolons, trailing commas, 100-char line width, 2-space indent.
- **Import order**: Node built-ins (`node:fs`, `node:path`) → external packages → local imports. Keep `import type` separate from value imports.
- **Type imports**: Use `import type { Foo }` for type-only imports. `verbatimModuleSyntax` is enabled.
- **File naming**: `kebab-case.ts` for all source files.
- **Naming conventions**: `camelCase` for variables/functions, `PascalCase` for interfaces/classes/types.
- **Exports**: Named exports only. No default exports.
- **ESM**: Pure ESM package. All local imports must include `.js` extensions.
- **Cross-package imports**: CLI imports from `@harnext/core`, never via relative paths across package boundaries.

## Architecture Overview

```
packages/
  core/                       @harnext/core — library
    src/
      index.ts                Barrel exports
      config.ts               APP_NAME, VERSION, directory helpers
      agent-session.ts        AgentSession class
      auth.ts                 API key storage (~/.harnext/agent/auth.json)
      providers.ts            Provider registry (Anthropic, OpenAI, Google, etc.)
      sdk.ts                  createAgentSession factory
      system-prompt.ts        System prompt builder
      tools/
        bash.ts               Shell command execution
        read.ts               File reading with line numbers
        write.ts              File creation/overwrite
        edit.ts               String-replacement editing
        truncate.ts           Output truncation utility

  cli/                        harnext — CLI binary
    src/
      index.ts                Entry point (calls main)
      main.ts                 CLI orchestrator (args → auth → session → mode)
      cli/
        args.ts               Argument parsing
        input.ts              Raw-mode input with ghost-text completion
        select.ts             Arrow-key select box widget
        onboarding.ts         First-run auth flow
        model-picker.ts       Provider/model switching
      modes/
        print-mode.ts         One-shot (non-interactive) mode
        interactive/
          interactive-mode.ts Main REPL loop with slash commands
          render.ts           Terminal rendering (boxes, spinner, footer)
```

**Key dependencies:**
- `@earendil-works/pi-agent-core` — Stateful agent runtime with event streaming
- `@earendil-works/pi-ai` — Multi-provider LLM API (Anthropic, OpenAI, Google, 25+ providers)
- `@sinclair/typebox` — Tool parameter schemas
- `chalk` — Terminal styling (CLI only)

## Security Constraints

- Never commit secrets, API keys, or `.env` files.
- The bash tool executes shell commands — be careful with untrusted input.
- Tool parameters are validated via TypeBox schemas before execution.
