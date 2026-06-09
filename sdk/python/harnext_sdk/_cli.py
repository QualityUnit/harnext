"""Locate the harnext CLI and translate options into CLI arguments."""

from __future__ import annotations

import json
import os
import shutil
import sys
from typing import Optional

from ._errors import CLINotFoundError
from .types import HarnextAgentOptions, InputFormat, OutputFormat


def resolve_cli_invocation(cli_path: Optional[os.PathLike[str] | str]) -> list[str]:
    """Return the argv prefix that launches the harnext CLI.

    Resolution order:
      1. explicit ``cli_path`` option,
      2. ``HARNEXT_CLI_PATH`` environment variable,
      3. ``harnext`` on ``PATH``.

    A path ending in ``.js``/``.mjs`` is run with ``node``; one ending in
    ``.py`` is run with the current interpreter (used by the test stub);
    anything else is assumed directly executable.
    """
    candidate = cli_path or os.environ.get("HARNEXT_CLI_PATH")
    if candidate:
        path = os.fspath(candidate)
        suffix = os.path.splitext(path)[1].lower()
        if suffix in (".js", ".mjs"):
            return ["node", path]
        if suffix == ".py":
            return [sys.executable, path]
        return [path]

    found = shutil.which("harnext")
    if found:
        return [found]

    raise CLINotFoundError(
        "Could not find the harnext CLI. Install it (npm i -g harnext), or set "
        "the HARNEXT_CLI_PATH environment variable / cli_path option to the CLI "
        "entry point."
    )


def build_command(
    prompt: str,
    options: HarnextAgentOptions,
    *,
    output_format: OutputFormat = "stream-json",
    input_format: InputFormat = "text",
) -> list[str]:
    """Build the full argv for a one-shot ``harnext -p`` run."""
    argv = resolve_cli_invocation(options.cli_path)
    argv += ["-p", "--output-format", output_format]
    if input_format != "text":
        argv += ["--input-format", input_format]

    if options.model:
        argv += ["--model", options.model]
    if options.fallback_model:
        argv += ["--fallback-model", options.fallback_model]
    if options.provider:
        argv += ["--provider", options.provider]
    if options.thinking:
        argv += ["--thinking", options.thinking]

    if options.system_prompt is not None:
        argv += ["--system-prompt", options.system_prompt]
    if options.append_system_prompt is not None:
        argv += ["--append-system-prompt", options.append_system_prompt]

    if options.cwd is not None:
        argv += ["--cwd", os.fspath(options.cwd)]
    if options.permission_mode:
        argv += ["--permission-mode", options.permission_mode]
    if options.max_turns is not None:
        argv += ["--max-turns", str(options.max_turns)]

    for tool in options.allowed_tools or []:
        argv += ["--allowed-tools", tool]
    for tool in options.disallowed_tools or []:
        argv += ["--disallowed-tools", tool]
    for source in options.setting_sources or []:
        argv += ["--setting-sources", source]
    for directory in options.add_dirs or []:
        argv += ["--add-dir", os.fspath(directory)]

    if options.sandbox is not None:
        argv += ["--sandbox", json.dumps(options.sandbox)]

    for key, value in (options.extra_args or {}).items():
        flag = f"--{key}"
        if value is None:
            argv.append(flag)
        else:
            argv += [flag, value]

    # Text input: the prompt is the trailing positional argument.
    if input_format == "text":
        argv.append(prompt)

    return argv
