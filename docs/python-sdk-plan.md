# Harnext Python SDK + CLI parity plan

Goal: run harnext programmatically from Python by **subprocessing the harnext CLI**, with an
API that mirrors the Claude Agent SDK (`claude_agent_sdk`) one-to-one for the options we use.

Target Python usage (must run unchanged except for the import):

```python
from harnext_sdk import query, HarnextAgentOptions  # ClaudeAgentOptions alias also exported

options = HarnextAgentOptions(
    cwd=req.working_dir,
    system_prompt=req.system_prompt,
    allowed_tools=req.allowed_tools,
    disallowed_tools=req.disallowed_tools,
    permission_mode="dontAsk",          # default-deny: only allowed_tools run, no prompts
    sandbox={...},                      # accepted, currently a no-op (see "Sandbox")
    max_turns=req.max_turns,
    model=req.model,
    setting_sources=["project"],        # auto-load ./CLAUDE.md from the mount
)
async for message in query(prompt=req.prompt, options=options):
    ...
```

## Scope decisions (locked)

- **Sandbox**: accepted in the options object (so caller code is unchanged) but a **no-op** for
  now. harnext's Bash tool runs commands directly; real OS isolation is a follow-up. The flag is
  plumbed end-to-end so we can implement enforcement later without an API change.
- **SDK surface**: **core parity** — the `query()` async generator plus the options above, and
  stream-json messages (`system` / `assistant` / `user` / `result`). `ClaudeSDKClient` streaming,
  hooks, subagents, in-process MCP, plugins, and JSON-schema `output_format` are out of scope here.

## How it works

```
Python query(options)
  -> build argv: harnext -p --output-format stream-json --input-format <text|stream-json> [flags]
  -> spawn CLI subprocess (asyncio), write prompt, read NDJSON from stdout
  -> parse each line into a message dataclass, yield it
```

The CLI gains a machine-readable `--output-format stream-json` that emits the exact envelope shapes
the Claude Agent SDK emits, so the Python parser is a thin mapping layer.

## Option -> CLI flag mapping

| Python option (`HarnextAgentOptions`) | CLI flag | Status |
| --- | --- | --- |
| `model` | `-m, --model` | exists |
| `system_prompt` | `--system-prompt` | exists |
| `cwd` | `--cwd` | exists |
| `allowed_tools` | `--allowed-tools <csv>` (repeatable) | **new** |
| `disallowed_tools` | `--disallowed-tools <csv>` (repeatable) | **new** |
| `permission_mode` | `--permission-mode <mode>` | **new** |
| `max_turns` | `--max-turns <n>` | **new** |
| `setting_sources` | `--setting-sources <csv>` | **new** |
| `append_system_prompt` | `--append-system-prompt <text>` | **new** |
| `add_dirs` | `--add-dir <dir>` (repeatable) | **new** |
| `fallback_model` | `--fallback-model <model>` | **new** |
| (output) | `--output-format <text\|json\|stream-json>` | **new** |
| (input) | `--input-format <text\|stream-json>` | **new** |
| `sandbox` | `--sandbox <json>` | **new (no-op)** |
| `provider` (harnext extra) | `--provider <id>` | exists |
| `thinking` | `--thinking <level>` | exists |

`permission_mode` values mirror the Claude SDK: `default`, `acceptEdits`, `plan`, `dontAsk`,
`bypassPermissions`.

## Tool name aliases

The Claude SDK names tools `Read`/`Write`/`Edit`/`Bash`; harnext names them
`read`/`write`/`edit`/`bash`. `tool-policy.ts` normalizes both directions so `allowed_tools`,
`disallowed_tools`, and stream-json output all accept and emit the PascalCase Claude names while
matching harnext's lowercase tools. Unknown names (e.g. MCP tools like `mcp__x__y`) pass through
unchanged.

## Permission semantics (`beforeToolCall` hook)

| mode | behavior (headless) |
| --- | --- |
| `bypassPermissions` | allow everything (disallowed still wins) |
| `default` | allow non-disallowed tools (no interactive prompt exists headless) |
| `acceptEdits` | same as default headless (edits auto-accepted) |
| `plan` | read-only: block `bash`/`edit`/`write`; allow `read` and read-only tools |
| `dontAsk` | default-deny: only tools in `allowed_tools` run; block everything else |

`disallowed_tools` always blocks, in every mode. When `allowed_tools` is set, it gates auto-run in
`dontAsk`/`default`.

## Stream-json envelopes (CLI stdout, NDJSON)

```jsonc
{"type":"system","subtype":"init","session_id":"...","model":"...","cwd":"...","tools":["Read","Bash",...],"permissionMode":"dontAsk"}
{"type":"assistant","message":{"role":"assistant","model":"...","content":[{"type":"text","text":"..."},{"type":"tool_use","id":"...","name":"Bash","input":{...}}],"usage":{...}},"session_id":"..."}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"...","is_error":false}]},"session_id":"..."}
{"type":"result","subtype":"success","is_error":false,"result":"final text","session_id":"...","num_turns":3,"duration_ms":1234,"total_cost_usd":0.01,"usage":{"input_tokens":...,"output_tokens":...,"cache_read_input_tokens":...,"cache_creation_input_tokens":...}}
```

`result.subtype` is `success`, `error_max_turns`, or `error_during_execution`.

## Deliverables / phases

1. **CLI flags** (`packages/cli/src/cli/args.ts`) — parse the new flags, extend help.
2. **Core tool-policy** (`packages/core/src/tool-policy.ts`) — aliases, `filterTools`,
   `createPermissionHook`; wired in `createAgentSession`.
3. **setting_sources / append-system-prompt / max_turns** — `project-context.ts` loads CLAUDE.md;
   system prompt assembly; turn-count + abort enforcement with a stop reason.
4. **Output formats** (`packages/cli/src/modes/sdk-output.ts`) — stream-json + json serializers,
   selected by `--output-format` in print mode.
5. **Python SDK** (`sdk/python/harnext_sdk/`) — `query()`, `HarnextAgentOptions`, message
   dataclasses, subprocess transport, argv builder, NDJSON parser, `pyproject.toml`.
6. **Tests + e2e** — Vitest (tool-policy, project-context, args, sdk-output); Pytest (argv mapping,
   parser, stub-CLI subprocess e2e, gated live e2e).

## Verification

- `npm test` (vitest) green for new TS modules.
- `pytest sdk/python` green: argv mapping + parser + stub-CLI subprocess e2e.
- Gated live e2e (`HARNEXT_LIVE_E2E=1` + provider key): `query()` against the real built CLI.

## Packaging / distribution

- Distribution name `harnext-sdk` (import `harnext_sdk`), published to PyPI.
- `pyproject.toml` carries full metadata (SPDX `MIT`, classifiers, project URLs),
  ships `py.typed`, and builds a clean sdist + wheel (`twine check` PASSED).
- `.github/workflows/publish-python-sdk.yml` publishes via OIDC trusted
  publishing on a `python-v*` tag (TestPyPI dry run via manual dispatch).
