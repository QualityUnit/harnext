# harnext

An AI coding agent with harness engineering. `harnext` is an interactive terminal agent that can read, write, and edit files, run shell commands, drive MCP servers, and pick up GitHub issues on a cron-driven schedule.

It works with Anthropic, OpenAI, Google, Ollama, and 20+ other providers via [`pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai).

## Install

Requires **Node.js ≥ 20**.

### npm (recommended)

```bash
npm install -g harnext
```

Then run:

```bash
harnext
```

On first run you'll be prompted to pick a provider, paste an API key (stored in `~/.harnext/agent/auth.json`, mode `0600`), and choose a model.

### One-line install script

If you'd rather not invoke `npm` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/yasha-dev1/codefactory/main/scripts/install.sh | bash
```

The script verifies Node ≥ 20 is on `PATH` and then runs `npm install -g harnext`.

### From source

```bash
git clone https://github.com/yasha-dev1/codefactory.git
cd codefactory
npm install
npm run build
node packages/cli/dist/index.js
```

## Quick start

```bash
harnext                                          # interactive REPL
harnext -p "list the files in this directory"    # one-shot prompt
harnext --provider openai -m gpt-4o              # different provider/model
harnext setup                                    # configure project pipeline
harnext status                                   # show active agent runs
harnext mcp --help                               # manage MCP servers
```

Pass `-h` / `--help` to any subcommand to see its flags.

## Upgrade

```bash
npm update -g harnext
```

## Uninstall

```bash
npm uninstall -g harnext
```

## License

MIT — see [LICENSE](./LICENSE).
