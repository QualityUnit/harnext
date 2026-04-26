# harnext

An AI coding agent with harness engineering — interactive REPL, MCP support, and a GitHub-issue-driven workflow runner.

Works with Anthropic, OpenAI, Google, Ollama, and 20+ other providers.

## Install

Requires **Node.js ≥ 20**.

```bash
npm install -g harnext
```

Then run:

```bash
harnext
```

On first run you'll be prompted to pick a provider, paste an API key (stored in `~/.harnext/agent/auth.json`, mode `0600`), and choose a model.

## Quick start

```bash
harnext                                          # interactive REPL
harnext -p "list the files in this directory"    # one-shot prompt
harnext --provider openai -m gpt-4o              # different provider/model
harnext setup                                    # configure project pipeline
harnext status                                   # show active agent runs
harnext runner status                            # inspect the self-hosted runner daemon
harnext runner logs                              # tail the runner's diag log
harnext mcp --help                               # manage MCP servers
```

Pass `-h` / `--help` to any subcommand to see its flags.

## Documentation & source

Full README, architecture notes, and contribution guide: <https://github.com/yasha-dev1/codefactory>

## License

MIT
