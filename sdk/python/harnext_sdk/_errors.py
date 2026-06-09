"""Exceptions raised by the harnext Python SDK."""

from __future__ import annotations


class HarnextSDKError(Exception):
    """Base class for all SDK errors."""


class CLINotFoundError(HarnextSDKError):
    """The harnext CLI executable could not be located."""


class ProcessError(HarnextSDKError):
    """The CLI subprocess exited with a non-zero status and no result message."""

    def __init__(self, message: str, *, exit_code: int | None = None, stderr: str = "") -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr = stderr


class MessageParseError(HarnextSDKError):
    """A line emitted by the CLI could not be parsed as a known message."""

    def __init__(self, message: str, *, line: str = "") -> None:
        super().__init__(message)
        self.line = line
