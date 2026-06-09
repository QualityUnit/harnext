"""Parse the CLI's stream-json envelopes into message dataclasses."""

from __future__ import annotations

import json
from typing import Any, Optional

from ._errors import MessageParseError
from .types import (
    AssistantMessage,
    ContentBlock,
    Message,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)


def _parse_content_blocks(content: Any) -> list[ContentBlock]:
    blocks: list[ContentBlock] = []
    if not isinstance(content, list):
        return blocks
    for raw in content:
        if not isinstance(raw, dict):
            continue
        block_type = raw.get("type")
        if block_type == "text":
            blocks.append(TextBlock(text=raw.get("text", "")))
        elif block_type == "thinking":
            blocks.append(ThinkingBlock(thinking=raw.get("thinking", "")))
        elif block_type == "tool_use":
            blocks.append(
                ToolUseBlock(
                    id=raw.get("id", ""),
                    name=raw.get("name", ""),
                    input=raw.get("input", {}) or {},
                )
            )
        elif block_type == "tool_result":
            blocks.append(
                ToolResultBlock(
                    tool_use_id=raw.get("tool_use_id", ""),
                    content=raw.get("content"),
                    is_error=bool(raw.get("is_error", False)),
                )
            )
    return blocks


def parse_message(obj: dict[str, Any]) -> Optional[Message]:
    """Convert a decoded envelope dict into a message, or ``None`` if unknown."""
    msg_type = obj.get("type")
    session_id = obj.get("session_id")

    if msg_type == "system":
        return SystemMessage(
            subtype=obj.get("subtype", ""),
            data=obj,
            session_id=session_id,
        )

    if msg_type == "assistant":
        message = obj.get("message", {}) or {}
        return AssistantMessage(
            content=_parse_content_blocks(message.get("content")),
            model=message.get("model"),
            usage=message.get("usage"),
            stop_reason=message.get("stop_reason"),
            session_id=session_id,
        )

    if msg_type == "user":
        message = obj.get("message", {}) or {}
        return UserMessage(
            content=_parse_content_blocks(message.get("content")),
            session_id=session_id,
        )

    if msg_type == "result":
        return ResultMessage(
            subtype=obj.get("subtype", ""),
            is_error=bool(obj.get("is_error", False)),
            result=obj.get("result"),
            session_id=session_id,
            num_turns=int(obj.get("num_turns", 0)),
            duration_ms=int(obj.get("duration_ms", 0)),
            total_cost_usd=obj.get("total_cost_usd"),
            usage=obj.get("usage", {}) or {},
        )

    return None


def parse_line(line: str) -> Optional[Message]:
    """Decode a single NDJSON line into a message (``None`` for blank/unknown)."""
    stripped = line.strip()
    if not stripped:
        return None
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise MessageParseError(f"Invalid JSON from CLI: {exc}", line=stripped) from exc
    if not isinstance(obj, dict):
        return None
    return parse_message(obj)
