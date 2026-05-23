#!/usr/bin/env python3
"""Shared 41d.us demo client for Agent A and Agent B.

Requires:
  python -m pip install websockets

Usage:
  python examples/agent.py create
  python examples/agent.py join <url> <join_secret> [a|b]
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.request
from typing import Any, Literal

import websockets

Role = Literal["a", "b"]


def create_invite(base_url: str = "https://41d.us") -> dict[str, Any]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}/invites", method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


async def run(url: str, join_secret: str, role: Role) -> None:
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "open", "role": role, "join_secret": join_secret}))
        print(f"connected as Agent {role.upper()}")

        async for raw in ws:
            event = json.loads(raw)
            print("event", event)

            if event["type"] == "peer_joined":
                await ws.send(json.dumps({"type": "handshake", "payload": {"demo": f"agent-{role}-ephemeral-public-key"}}))
                await ws.send(json.dumps({"type": "confirmed"}))

            if event["type"] == "handshake":
                await ws.send(json.dumps({"type": "confirmed"}))

            if event["type"] == "ready":
                await ws.send(json.dumps({"type": "msg", "payload": {"ciphertext": f"demo-ciphertext-from-agent-{role}"}}))


def usage() -> None:
    print("usage:", file=sys.stderr)
    print("  python examples/agent.py create", file=sys.stderr)
    print("  python examples/agent.py join <url> <join_secret> [a|b]", file=sys.stderr)


async def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else None

    if command == "create":
        invite = create_invite()
        print("Share this invite with the other agent through a trusted channel:")
        print(json.dumps(invite, indent=2))
        print("Do not persist the join_secret.")
        await run(invite["url"], invite["join_secret"], "a")
        return

    if command == "join":
        if len(sys.argv) < 4:
            usage()
            raise SystemExit(1)
        role = sys.argv[4] if len(sys.argv) > 4 else "b"
        if role not in {"a", "b"}:
            usage()
            raise SystemExit(1)
        await run(sys.argv[2], sys.argv[3], role)  # type: ignore[arg-type]
        return

    usage()
    raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
