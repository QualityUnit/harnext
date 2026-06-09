"""Minimal harnext Python SDK example.

Run with the harnext CLI installed (or HARNEXT_CLI_PATH set) and a provider key
in the environment (e.g. ANTHROPIC_API_KEY):

    python examples/quickstart.py
"""

import asyncio

from harnext_sdk import (
    AssistantMessage,
    HarnextAgentOptions,
    ResultMessage,
    TextBlock,
    query,
)


async def main() -> None:
    options = HarnextAgentOptions(
        allowed_tools=["Read", "Bash"],
        permission_mode="dontAsk",
        max_turns=10,
        setting_sources=["project"],
    )

    async for message in query(
        prompt="What files are in this directory? Use ls.",
        options=options,
    ):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print("assistant:", block.text)
        elif isinstance(message, ResultMessage):
            print("result:", message.result)
            print("turns:", message.num_turns, "cost:", message.total_cost_usd)


if __name__ == "__main__":
    asyncio.run(main())
