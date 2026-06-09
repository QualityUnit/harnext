"""Async subprocess transport: spawn the harnext CLI, stream its NDJSON stdout."""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator, Callable, Optional

from ._errors import ProcessError

_DEFAULT_BUFFER_LIMIT = 10 * 1024 * 1024  # 10 MiB per stdout line


class SubprocessCLITransport:
    """Spawns the CLI and yields decoded stdout lines.

    Use as an async context manager::

        transport = SubprocessCLITransport(command=argv, cwd=cwd)
        async with transport:
            async for line in transport.read_lines():
                ...
    """

    def __init__(
        self,
        *,
        command: list[str],
        cwd: Optional[os.PathLike[str] | str] = None,
        env: Optional[dict[str, str]] = None,
        stderr_callback: Optional[Callable[[str], None]] = None,
        buffer_limit: Optional[int] = None,
    ) -> None:
        self._command = command
        self._cwd = os.fspath(cwd) if cwd is not None else None
        self._env = env
        self._stderr_callback = stderr_callback
        self._buffer_limit = buffer_limit or _DEFAULT_BUFFER_LIMIT
        self._process: Optional[asyncio.subprocess.Process] = None
        self._stderr_task: Optional[asyncio.Task[None]] = None
        self._stderr_lines: list[str] = []
        self._saw_result = False

    async def __aenter__(self) -> "SubprocessCLITransport":
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
            env=self._env,
            limit=self._buffer_limit,
        )
        self._stderr_task = asyncio.ensure_future(self._drain_stderr())
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        process = self._process
        if process is None:
            return

        if exc_type is not None and process.returncode is None:
            # The consumer bailed out early — terminate the child.
            try:
                process.terminate()
            except ProcessLookupError:
                pass

        await process.wait()
        if self._stderr_task is not None:
            await self._stderr_task

        # Surface a hard failure only when the CLI exited non-zero *and* never
        # produced a result envelope (which already carries error details).
        if exc_type is None and process.returncode not in (0, None) and not self._saw_result:
            stderr_text = "\n".join(self._stderr_lines)
            raise ProcessError(
                f"harnext CLI exited with code {process.returncode}.",
                exit_code=process.returncode,
                stderr=stderr_text,
            )

    async def _drain_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        async for raw in self._process.stderr:
            text = raw.decode("utf-8", errors="replace").rstrip("\n")
            self._stderr_lines.append(text)
            if self._stderr_callback is not None:
                self._stderr_callback(text)

    async def read_lines(self) -> AsyncIterator[str]:
        """Yield each stdout line (without the trailing newline)."""
        assert self._process is not None and self._process.stdout is not None
        async for raw in self._process.stdout:
            yield raw.decode("utf-8", errors="replace").rstrip("\n")

    def mark_result_seen(self) -> None:
        """Record that a result envelope arrived (suppresses exit-code errors)."""
        self._saw_result = True
