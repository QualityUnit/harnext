"""CLI version detection and best-effort auto-upgrade.

When the SDK drives the globally-installed ``harnext`` CLI (resolved from
``PATH``, not an explicit ``cli_path``), :func:`ensure_cli_version` checks that
the CLI is at least the SDK's version. If the CLI is behind, the SDK runs
``npm install -g harnext@<sdk_version>`` once per process so the two stay in
lockstep.

This is best-effort: any failure (no npm, offline, permissions) emits a warning
and the existing CLI is used. It is skipped entirely when:
  - ``cli_path`` or ``HARNEXT_CLI_PATH`` is set (custom / dev builds we must not
    npm-upgrade),
  - ``auto_update_cli=False`` on the options, or
  - the ``HARNEXT_NO_CLI_AUTOUPDATE`` environment variable is set.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
from typing import Optional

from ._cli import resolve_cli_invocation
from .types import HarnextAgentOptions

_VERSION_RE = re.compile(r"(\d+(?:\.\d+)*)")

# Run the check at most once per (CLI, sdk version) per process.
_checked: set[str] = set()
_lock: Optional[asyncio.Lock] = None


def parse_version(text: str) -> tuple[int, ...]:
    """Extract the leading numeric version (e.g. ``1.3.2``) as an int tuple."""
    if not text:
        return ()
    match = _VERSION_RE.search(text.strip())
    if not match:
        return ()
    return tuple(int(part) for part in match.group(1).split("."))


def is_behind(cli_version: str, sdk_version: str) -> bool:
    """True when the CLI version is strictly older than the SDK version."""
    cli = parse_version(cli_version)
    sdk = parse_version(sdk_version)
    if not cli or not sdk:
        return False
    return cli < sdk


def _sdk_version() -> str:
    # Imported lazily: __init__ defines __version__ after importing this module.
    from . import __version__

    return __version__


def _auto_update_enabled(options: HarnextAgentOptions) -> bool:
    if os.environ.get("HARNEXT_NO_CLI_AUTOUPDATE"):
        return False
    return getattr(options, "auto_update_cli", True)


def _emit(options: HarnextAgentOptions, message: str) -> None:
    if options.stderr is not None:
        options.stderr(message)
    else:
        print(f"[harnext-sdk] {message}", file=sys.stderr)


async def _run(cmd: list[str]) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    code = proc.returncode if proc.returncode is not None else -1
    return code, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def _cli_version(base: list[str]) -> Optional[str]:
    try:
        code, out, _ = await _run([*base, "--version"])
    except (OSError, ValueError):
        return None
    if code != 0:
        return None
    text = out.strip()
    return text or None


async def _upgrade(version: str, options: HarnextAgentOptions) -> bool:
    npm = shutil.which("npm")
    if npm is None:
        _emit(
            options,
            f"harnext CLI is older than the SDK ({version}) but npm was not found; "
            "skipping auto-upgrade. Upgrade the CLI manually.",
        )
        return False
    _emit(options, f"Upgrading harnext CLI to {version} (npm install -g harnext@{version})…")
    try:
        code, _out, err = await _run([npm, "install", "-g", f"harnext@{version}"])
    except OSError as exc:
        _emit(options, f"harnext CLI auto-upgrade failed: {exc}")
        return False
    if code != 0:
        _emit(options, f"harnext CLI auto-upgrade failed (npm exit {code}). {err.strip()[:300]}")
        return False
    _emit(options, f"harnext CLI upgraded to {version}.")
    return True


async def ensure_cli_version(options: HarnextAgentOptions) -> None:
    """Check the global CLI version and auto-upgrade it if it's behind the SDK."""
    # Only manage the PATH-resolved global CLI; never touch a custom/dev binary.
    if options.cli_path is not None or os.environ.get("HARNEXT_CLI_PATH"):
        return
    if not _auto_update_enabled(options):
        return
    try:
        base = resolve_cli_invocation(None)
    except Exception:
        # CLI not found; let query() surface the real, actionable error.
        return

    sdk_version = _sdk_version()
    key = f"{' '.join(base)}|{sdk_version}"

    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:
        if key in _checked:
            return
        # Attempt at most once per process, even if the steps below fail.
        _checked.add(key)

        cli_version = await _cli_version(base)
        if cli_version is None:
            return
        if is_behind(cli_version, sdk_version):
            await _upgrade(sdk_version, options)
