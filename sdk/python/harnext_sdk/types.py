"""Public types for the harnext Python SDK.

The option and message shapes mirror the Claude Agent SDK one-to-one for the
surface we support, so existing ``claude_agent_sdk`` code ports over by swapping
the import. ``ClaudeAgentOptions`` is exported as an alias of
``HarnextAgentOptions`` for drop-in use.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional, Union

PermissionMode = Literal["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]
OutputFormat = Literal["text", "json", "stream-json"]
InputFormat = Literal["text", "stream-json"]
SettingSource = Literal["user", "project", "local"]


@dataclass
class HarnextAgentOptions:
    """Configuration for a :func:`harnext_sdk.query` run.

    Field names match ``claude_agent_sdk.ClaudeAgentOptions`` for the supported
    surface. Options the harness does not yet act on (``sandbox``,
    ``fallback_model``, ``add_dirs``) are accepted so caller code is unchanged.
    """

    # --- Tools ---
    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)

    # --- System prompt ---
    system_prompt: Optional[str] = None
    append_system_prompt: Optional[str] = None

    # --- Permissions ---
    permission_mode: Optional[PermissionMode] = None

    # --- Limits ---
    max_turns: Optional[int] = None

    # --- Model ---
    model: Optional[str] = None
    fallback_model: Optional[str] = None
    # harnext extras (no Claude equivalent):
    provider: Optional[str] = None
    thinking: Optional[str] = None

    # --- Environment / filesystem ---
    cwd: Optional[Union[str, os.PathLike[str]]] = None
    add_dirs: list[Union[str, os.PathLike[str]]] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    setting_sources: Optional[list[SettingSource]] = None

    # --- Sandbox (accepted; currently a no-op in harnext) ---
    sandbox: Optional[dict[str, Any]] = None

    # --- Transport / advanced ---
    cli_path: Optional[Union[str, os.PathLike[str]]] = None
    extra_args: dict[str, Optional[str]] = field(default_factory=dict)
    stderr: Optional[Callable[[str], None]] = None
    max_buffer_size: Optional[int] = None


# Drop-in alias for ported claude_agent_sdk code.
ClaudeAgentOptions = HarnextAgentOptions


# --------------------------------------------------------------------------- #
# Content blocks
# --------------------------------------------------------------------------- #
@dataclass
class TextBlock:
    text: str


@dataclass
class ThinkingBlock:
    thinking: str


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: Any = None
    is_error: bool = False


ContentBlock = Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock]


# --------------------------------------------------------------------------- #
# Messages
# --------------------------------------------------------------------------- #
@dataclass
class SystemMessage:
    """A system event, e.g. the ``init`` envelope at session start."""

    subtype: str
    data: dict[str, Any]
    session_id: Optional[str] = None


@dataclass
class AssistantMessage:
    content: list[ContentBlock]
    model: Optional[str] = None
    usage: Optional[dict[str, Any]] = None
    stop_reason: Optional[str] = None
    session_id: Optional[str] = None


@dataclass
class UserMessage:
    """User-role message; in practice carries tool_result blocks."""

    content: list[ContentBlock]
    session_id: Optional[str] = None


@dataclass
class ResultMessage:
    subtype: str
    is_error: bool
    result: Optional[str]
    session_id: Optional[str]
    num_turns: int
    duration_ms: int
    total_cost_usd: Optional[float]
    usage: dict[str, Any]


Message = Union[SystemMessage, AssistantMessage, UserMessage, ResultMessage]
