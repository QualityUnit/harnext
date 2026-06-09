"""Unit tests for NDJSON envelope parsing."""

from __future__ import annotations

import pytest

from harnext_sdk import (
    AssistantMessage,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from harnext_sdk._errors import MessageParseError
from harnext_sdk._parser import parse_line


def test_parse_system_init():
    line = '{"type":"system","subtype":"init","session_id":"s1","model":"m","tools":["Read"]}'
    msg = parse_line(line)
    assert isinstance(msg, SystemMessage)
    assert msg.subtype == "init"
    assert msg.session_id == "s1"
    assert msg.data["tools"] == ["Read"]


def test_parse_assistant_with_text_and_tool_use():
    line = (
        '{"type":"assistant","session_id":"s1","message":{"role":"assistant","model":"m",'
        '"content":[{"type":"text","text":"hi"},'
        '{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],'
        '"usage":{"input_tokens":1}}}'
    )
    msg = parse_line(line)
    assert isinstance(msg, AssistantMessage)
    assert msg.model == "m"
    assert isinstance(msg.content[0], TextBlock)
    assert msg.content[0].text == "hi"
    assert isinstance(msg.content[1], ToolUseBlock)
    assert msg.content[1].name == "Bash"
    assert msg.content[1].input == {"command": "ls"}
    assert msg.usage == {"input_tokens": 1}


def test_parse_user_tool_result():
    line = (
        '{"type":"user","session_id":"s1","message":{"role":"user",'
        '"content":[{"type":"tool_result","tool_use_id":"t1","content":"out","is_error":false}]}}'
    )
    msg = parse_line(line)
    assert isinstance(msg, UserMessage)
    assert isinstance(msg.content[0], ToolResultBlock)
    assert msg.content[0].tool_use_id == "t1"
    assert msg.content[0].content == "out"
    assert msg.content[0].is_error is False


def test_parse_result():
    line = (
        '{"type":"result","subtype":"success","is_error":false,"result":"done",'
        '"session_id":"s1","num_turns":3,"duration_ms":100,"total_cost_usd":0.02,'
        '"usage":{"input_tokens":30,"output_tokens":10}}'
    )
    msg = parse_line(line)
    assert isinstance(msg, ResultMessage)
    assert msg.subtype == "success"
    assert msg.is_error is False
    assert msg.result == "done"
    assert msg.num_turns == 3
    assert msg.duration_ms == 100
    assert msg.total_cost_usd == 0.02
    assert msg.usage["input_tokens"] == 30


def test_parse_result_error_max_turns():
    line = '{"type":"result","subtype":"error_max_turns","is_error":true,"result":null,"num_turns":5}'
    msg = parse_line(line)
    assert isinstance(msg, ResultMessage)
    assert msg.subtype == "error_max_turns"
    assert msg.is_error is True
    assert msg.result is None


def test_blank_and_unknown_lines_return_none():
    assert parse_line("") is None
    assert parse_line("   ") is None
    assert parse_line('{"type":"mystery"}') is None


def test_invalid_json_raises():
    with pytest.raises(MessageParseError):
        parse_line("{not json")
