"""Unit tests for option -> CLI argv mapping (no subprocess)."""

from __future__ import annotations

import json

import pytest

from harnext_sdk import HarnextAgentOptions, build_command
from harnext_sdk._cli import resolve_cli_invocation
from harnext_sdk._errors import CLINotFoundError


def _argv(options: HarnextAgentOptions, prompt: str = "hi", **kw) -> list[str]:
    # Force a known CLI path so resolution never depends on PATH.
    options.cli_path = "/usr/bin/harnext"
    return build_command(prompt, options, **kw)


def test_defaults_emit_print_and_stream_json():
    argv = _argv(HarnextAgentOptions())
    assert argv[0] == "/usr/bin/harnext"
    assert "-p" in argv
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    # Prompt is the trailing positional for text input.
    assert argv[-1] == "hi"


def test_core_options_map_to_flags():
    options = HarnextAgentOptions(
        model="claude-sonnet-4-6",
        system_prompt="be terse",
        permission_mode="dontAsk",
        max_turns=7,
        cwd="/work",
    )
    argv = _argv(options)
    assert argv[argv.index("--model") + 1] == "claude-sonnet-4-6"
    assert argv[argv.index("--system-prompt") + 1] == "be terse"
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--max-turns") + 1] == "7"
    assert argv[argv.index("--cwd") + 1] == "/work"


def test_list_options_repeat_flags():
    options = HarnextAgentOptions(
        allowed_tools=["Read", "Bash"],
        disallowed_tools=["Write"],
        setting_sources=["project", "user"],
        add_dirs=["/extra"],
    )
    argv = _argv(options)
    # Each list entry becomes its own flag occurrence.
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--allowed-tools"] == ["Read", "Bash"]
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--disallowed-tools"] == ["Write"]
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--setting-sources"] == [
        "project",
        "user",
    ]
    assert argv[argv.index("--add-dir") + 1] == "/extra"


def test_sandbox_serialized_as_json():
    sandbox = {"enabled": True, "network": {"allowedDomains": []}}
    argv = _argv(HarnextAgentOptions(sandbox=sandbox))
    payload = argv[argv.index("--sandbox") + 1]
    assert json.loads(payload) == sandbox


def test_users_full_option_set_round_trips():
    # The exact ClaudeAgentOptions surface from the migration target.
    options = HarnextAgentOptions(
        cwd="/mnt/work",
        system_prompt="system",
        allowed_tools=["Read", "Edit", "Bash"],
        disallowed_tools=["WebFetch"],
        permission_mode="dontAsk",
        sandbox={"enabled": True, "network": {"allowedDomains": []}},
        max_turns=25,
        model="claude-opus-4-8",
        setting_sources=["project"],
    )
    argv = _argv(options, prompt="do the thing")
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--max-turns") + 1] == "25"
    assert argv[argv.index("--model") + 1] == "claude-opus-4-8"
    assert argv[argv.index("--setting-sources") + 1] == "project"
    assert "Read" in argv and "WebFetch" in argv
    assert argv[-1] == "do the thing"


def test_input_format_stream_json_omits_positional_prompt():
    argv = _argv(HarnextAgentOptions(), prompt="hi", input_format="stream-json")
    assert argv[argv.index("--input-format") + 1] == "stream-json"
    assert argv[-1] != "hi"


def test_extra_args_passthrough():
    options = HarnextAgentOptions(extra_args={"verbose": None, "tag": "exp1"})
    argv = _argv(options)
    assert "--verbose" in argv
    assert argv[argv.index("--tag") + 1] == "exp1"


def test_resolve_js_path_uses_node():
    assert resolve_cli_invocation("/a/b/index.js") == ["node", "/a/b/index.js"]


def test_resolve_missing_cli_raises(monkeypatch):
    monkeypatch.delenv("HARNEXT_CLI_PATH", raising=False)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    with pytest.raises(CLINotFoundError):
        resolve_cli_invocation(None)
