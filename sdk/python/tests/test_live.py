"""Live e2e against the real built harnext CLI.

Gated behind HARNEXT_LIVE_E2E=1 because it spawns the real agent and needs a
provider API key in the environment. Point HARNEXT_CLI_PATH at the built CLI
(packages/cli/dist/index.js) or have `harnext` on PATH.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from harnext_sdk import HarnextAgentOptions, ResultMessage, query

LIVE = os.environ.get("HARNEXT_LIVE_E2E") == "1"

# Default to the in-repo built CLI when the env var is not already set.
_REPO_CLI = Path(__file__).resolve().parents[3] / "packages" / "cli" / "dist" / "index.js"


pytestmark = pytest.mark.skipif(not LIVE, reason="set HARNEXT_LIVE_E2E=1 to run live e2e")


async def test_live_query_returns_result():
    cli_path = os.environ.get("HARNEXT_CLI_PATH") or (
        str(_REPO_CLI) if _REPO_CLI.exists() else None
    )
    options = HarnextAgentOptions(
        cli_path=cli_path,
        allowed_tools=["Read", "Bash"],
        permission_mode="dontAsk",
        max_turns=3,
    )
    results = [
        m
        async for m in query(prompt="Reply with exactly: pong", options=options)
        if isinstance(m, ResultMessage)
    ]
    assert results, "expected a terminal ResultMessage"
    assert results[-1].subtype in ("success", "error_max_turns")
