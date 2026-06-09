#!/usr/bin/env python3
"""A fake harnext CLI for subprocess e2e tests.

Ignores most arguments and emits a fixed stream-json transcript so we can verify
the SDK's transport + parser end to end without a real model. If the env var
``STUB_ARGV_OUT`` is set, the received argv is written there as JSON so tests can
also assert the option->flag mapping that reached the process.
"""

import json
import os
import sys

ENVELOPES = [
    {
        "type": "system",
        "subtype": "init",
        "session_id": "sess-1",
        "model": "stub-model",
        "cwd": ".",
        "tools": ["Read", "Bash"],
        "permissionMode": "dontAsk",
    },
    {
        "type": "assistant",
        "session_id": "sess-1",
        "message": {
            "role": "assistant",
            "model": "stub-model",
            "content": [
                {"type": "text", "text": "Listing files"},
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
            ],
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        },
    },
    {
        "type": "user",
        "session_id": "sess-1",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "content": "file1\nfile2",
                    "is_error": False,
                }
            ],
        },
    },
    {
        "type": "assistant",
        "session_id": "sess-1",
        "message": {
            "role": "assistant",
            "model": "stub-model",
            "content": [{"type": "text", "text": "There are 2 files."}],
            "usage": {
                "input_tokens": 20,
                "output_tokens": 8,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
            },
        },
    },
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "There are 2 files.",
        "session_id": "sess-1",
        "num_turns": 2,
        "duration_ms": 42,
        "total_cost_usd": 0.001,
        "usage": {
            "input_tokens": 30,
            "output_tokens": 13,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        },
    },
]


def main() -> int:
    argv_out = os.environ.get("STUB_ARGV_OUT")
    if argv_out:
        with open(argv_out, "w", encoding="utf-8") as handle:
            json.dump(sys.argv[1:], handle)

    out = sys.stdout
    for envelope in ENVELOPES:
        out.write(json.dumps(envelope) + "\n")
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
