"""The ``query()`` entry point: run harnext once and stream parsed messages."""

from __future__ import annotations

import os
from typing import AsyncIterator, Optional

from ._cli import build_command
from ._parser import parse_line
from ._transport import SubprocessCLITransport
from ._version import ensure_cli_version
from .types import HarnextAgentOptions, Message, ResultMessage


def _merge_env(options: HarnextAgentOptions) -> Optional[dict[str, str]]:
    # Inherit the full environment by default (so provider API keys flow
    # through). When the caller supplies env vars, layer them on top.
    if not options.env:
        return None
    return {**os.environ, **options.env}


async def query(
    *,
    prompt: str,
    options: Optional[HarnextAgentOptions] = None,
) -> AsyncIterator[Message]:
    """Run a one-shot harnext task and yield messages as they arrive.

    Mirrors ``claude_agent_sdk.query``: spawns the harnext CLI as a subprocess
    with ``--output-format stream-json`` and yields
    :class:`~harnext_sdk.types.SystemMessage`,
    :class:`~harnext_sdk.types.AssistantMessage`,
    :class:`~harnext_sdk.types.UserMessage`, and a terminal
    :class:`~harnext_sdk.types.ResultMessage`.

    Example::

        async for message in query(
            prompt="List the files here",
            options=HarnextAgentOptions(allowed_tools=["Read", "Bash"]),
        ):
            if isinstance(message, ResultMessage):
                print(message.result)
    """
    opts = options or HarnextAgentOptions()

    # Keep the global CLI in lockstep with the SDK (best-effort, once/process).
    await ensure_cli_version(opts)

    command = build_command(prompt, opts)

    transport = SubprocessCLITransport(
        command=command,
        cwd=opts.cwd,
        env=_merge_env(opts),
        stderr_callback=opts.stderr,
        buffer_limit=opts.max_buffer_size,
    )

    async with transport:
        async for line in transport.read_lines():
            message = parse_line(line)
            if message is None:
                continue
            if isinstance(message, ResultMessage):
                transport.mark_result_seen()
            yield message
