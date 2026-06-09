"""End-to-end test of the transport + parser against a stub CLI subprocess."""

from __future__ import annotations

import json
import os
from pathlib import Path

from harnext_sdk import (
    AssistantMessage,
    HarnextAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

STUB = str(Path(__file__).parent / "stub_cli.py")


async def _collect(prompt: str, options: HarnextAgentOptions):
    return [m async for m in query(prompt=prompt, options=options)]


async def test_query_yields_full_transcript():
    options = HarnextAgentOptions(
        cli_path=STUB,
        allowed_tools=["Read", "Bash"],
        permission_mode="dontAsk",
    )
    messages = await _collect("list files", options)

    # System init, assistant, user(tool_result), assistant, result.
    assert isinstance(messages[0], SystemMessage)
    assert messages[0].subtype == "init"

    assistants = [m for m in messages if isinstance(m, AssistantMessage)]
    assert len(assistants) == 2
    assert isinstance(assistants[0].content[0], TextBlock)
    assert isinstance(assistants[0].content[1], ToolUseBlock)
    assert assistants[0].content[1].name == "Bash"

    users = [m for m in messages if isinstance(m, UserMessage)]
    assert len(users) == 1
    assert isinstance(users[0].content[0], ToolResultBlock)
    assert users[0].content[0].content == "file1\nfile2"

    result = messages[-1]
    assert isinstance(result, ResultMessage)
    assert result.subtype == "success"
    assert result.result == "There are 2 files."
    assert result.num_turns == 2
    assert result.total_cost_usd == 0.001


async def test_options_reach_the_subprocess_as_flags(tmp_path):
    argv_out = tmp_path / "argv.json"
    options = HarnextAgentOptions(
        cli_path=STUB,
        model="claude-opus-4-8",
        permission_mode="dontAsk",
        max_turns=25,
        allowed_tools=["Read", "Edit", "Bash"],
        disallowed_tools=["WebFetch"],
        setting_sources=["project"],
        sandbox={"enabled": True, "network": {"allowedDomains": []}},
        env={"STUB_ARGV_OUT": str(argv_out)},
    )
    await _collect("do the thing", options)

    argv = json.loads(argv_out.read_text())
    assert "-p" in argv
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert argv[argv.index("--model") + 1] == "claude-opus-4-8"
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--max-turns") + 1] == "25"
    assert argv[argv.index("--setting-sources") + 1] == "project"
    assert "WebFetch" in argv
    assert json.loads(argv[argv.index("--sandbox") + 1]) == options.sandbox
    assert argv[-1] == "do the thing"


async def test_stderr_callback_receives_output(tmp_path):
    # A stub that writes to stderr and exits 0.
    noisy = tmp_path / "noisy.py"
    noisy.write_text(
        "import sys\n"
        "sys.stderr.write('warming up\\n')\n"
        'print(\'{"type":"result","subtype":"success","is_error":false,'
        '"result":"ok","session_id":"s","num_turns":0,"duration_ms":1,'
        '"total_cost_usd":0,"usage":{}}\')\n'
    )
    lines: list[str] = []
    options = HarnextAgentOptions(cli_path=str(noisy), stderr=lines.append)
    messages = await _collect("hi", options)
    assert any("warming up" in line for line in lines)
    assert isinstance(messages[-1], ResultMessage)
