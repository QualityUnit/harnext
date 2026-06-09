"""harnext Python SDK.

Run the harnext coding agent from Python by subprocessing its CLI, with an API
that mirrors the Claude Agent SDK for the supported surface.

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
"""

from __future__ import annotations

from ._cli import build_command, resolve_cli_invocation
from ._errors import (
    CLINotFoundError,
    HarnextSDKError,
    MessageParseError,
    ProcessError,
)
from ._parser import parse_line, parse_message
from .query import query
from .types import (
    AssistantMessage,
    ClaudeAgentOptions,
    ContentBlock,
    HarnextAgentOptions,
    InputFormat,
    Message,
    OutputFormat,
    PermissionMode,
    ResultMessage,
    SettingSource,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

__version__ = "0.1.0"

__all__ = [
    "query",
    "HarnextAgentOptions",
    "ClaudeAgentOptions",
    "PermissionMode",
    "OutputFormat",
    "InputFormat",
    "SettingSource",
    "Message",
    "SystemMessage",
    "AssistantMessage",
    "UserMessage",
    "ResultMessage",
    "ContentBlock",
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
    "HarnextSDKError",
    "CLINotFoundError",
    "ProcessError",
    "MessageParseError",
    "build_command",
    "resolve_cli_invocation",
    "parse_line",
    "parse_message",
    "__version__",
]
