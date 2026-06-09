# harnext Python SDK

Run the [harnext](https://github.com/QualityUnit/harnext) coding agent from Python. The SDK subprocesses
the harnext CLI (`harnext -p --output-format stream-json`) and yields parsed
messages, with an API that mirrors the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) for the
supported surface.

## Install

```bash
pip install harnext                  # from PyPI
# or, from a checkout of this repo:
pip install -e sdk/python

# the harnext CLI must be installed too:
npm install -g harnext               # or set HARNEXT_CLI_PATH to the CLI entry
```

The SDK locates the CLI via, in order: the `cli_path` option, the
`HARNEXT_CLI_PATH` env var, or `harnext` on `PATH`. A `.js` path is run with
`node`.

## Quickstart

```python
import asyncio
from harnext_sdk import query, HarnextAgentOptions, ResultMessage

async def main():
    async for message in query(
        prompt="What files are in this directory?",
        options=HarnextAgentOptions(allowed_tools=["Read", "Bash"]),
    ):
        if isinstance(message, ResultMessage):
            print(message.result)

asyncio.run(main())
```

## Options (`HarnextAgentOptions`)

Field names match `claude_agent_sdk.ClaudeAgentOptions`; `ClaudeAgentOptions` is
exported as an alias so ported code runs unchanged.

| Option | CLI flag | Notes |
| --- | --- | --- |
| `model` | `--model` | |
| `system_prompt` | `--system-prompt` | |
| `append_system_prompt` | `--append-system-prompt` | |
| `cwd` | `--cwd` | |
| `allowed_tools` | `--allowed-tools` | auto-approve list |
| `disallowed_tools` | `--disallowed-tools` | blocked + hidden |
| `permission_mode` | `--permission-mode` | `default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions` |
| `max_turns` | `--max-turns` | |
| `setting_sources` | `--setting-sources` | `user`/`project`/`local` → loads `CLAUDE.md` |
| `add_dirs` | `--add-dir` | accepted; not yet enforced |
| `fallback_model` | `--fallback-model` | accepted; reserved |
| `sandbox` | `--sandbox` | accepted; **currently a no-op** in harnext |
| `provider` | `--provider` | harnext extra |
| `thinking` | `--thinking` | harnext extra |
| `env` | (process env) | merged over `os.environ` |
| `cli_path` | — | path to the CLI entry point |
| `extra_args` | passthrough | `{"flag": "value"}` → `--flag value` |

### Tool names

Use the Claude names (`Read`, `Write`, `Edit`, `Bash`); they are matched
case-insensitively against harnext's native tools and echoed back in PascalCase.

## Messages

`query()` yields `SystemMessage` (init), `AssistantMessage`, `UserMessage`
(tool results), then a terminal `ResultMessage` with `subtype`
(`success` / `error_max_turns` / `error_during_execution`), `result`,
`num_turns`, `duration_ms`, `total_cost_usd`, and `usage`.

## Tests

```bash
cd sdk/python
pip install -e ".[dev]"
pytest                  # unit + stub-subprocess e2e
HARNEXT_LIVE_E2E=1 pytest -k live   # live run against the real CLI (needs a provider key)
```

## Publishing to PyPI

The package name on PyPI is **`harnext`** (import name `harnext_sdk`).

### CI (recommended): trusted publishing

`.github/workflows/publish-python-sdk.yml` builds, tests, and publishes via PyPI
[trusted publishing](https://docs.pypi.org/trusted-publishers/) (OIDC — no token
stored in the repo).

1. One-time: on PyPI (and TestPyPI) add a *pending publisher* for project
   `harnext`, owner `QualityUnit`, repo `harnext`, workflow
   `publish-python-sdk.yml`.
2. Dry run to TestPyPI: run the workflow manually (`workflow_dispatch`, default
   target `testpypi`).
3. Release to PyPI: push a tag `python-v0.1.0` (independent of the CLI's `v*`
   tags), or run the workflow manually with target `pypi`.

### Manual

```bash
cd sdk/python
python -m build                      # -> dist/*.whl, dist/*.tar.gz
python -m twine check dist/*
python -m twine upload dist/*        # needs a PyPI API token (TWINE_USERNAME=__token__)
```

Bump `version` in `pyproject.toml` and `__version__` in `harnext_sdk/__init__.py`
together for each release.
