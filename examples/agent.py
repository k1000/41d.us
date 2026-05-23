#!/usr/bin/env python3
"""Shared 41d.us demo client for Agent A and Agent B.

Requires:
  python -m pip install websockets

Usage:
  python examples/agent.py create
  python examples/agent.py join <url> <join_secret> [a|b]

After both agents reach `ready`, type a line and press Enter to send it.
This demo labels typed text as ciphertext for protocol testing; real agents must
encrypt before sending.
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.request
import uuid
from typing import Any, Literal

import websockets

Role = Literal["a", "b"]


def create_invite(base_url: str = "https://41d.us") -> dict[str, Any]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}/invites", method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


async def run(url: str, join_secret: str, role: Role) -> None:
    ready = asyncio.Event()
    last_received_id: str | None = None

    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "open", "role": role, "join_secret": join_secret}))
        print(f"connected as Agent {role.upper()}")

        async def sender() -> None:
            nonlocal last_received_id
            await ready.wait()
            print("ready; type messages and press Enter to send")
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    return
                text = line.rstrip("\n")
                if not text:
                    continue
                if text in {"/q", "/quit", "/close"}:
                    await ws.send(json.dumps({"type": "close"}))
                    return
                await ws.send(json.dumps({
                    "type": "msg",
                    "id": str(uuid.uuid4()),
                    "reply_to": last_received_id,
                    "payload": {
                        "ciphertext": text,
                        "note": "plaintext demo payload; real clients must encrypt before sending",
                    },
                }))

        sender_task = asyncio.create_task(sender())

        try:
            async for raw in ws:
                event = json.loads(raw)
                print("event", event)

                if event["type"] == "peer_joined":
                    await ws.send(json.dumps({"type": "handshake", "payload": {"demo": f"agent-{role}-ephemeral-public-key"}}))
                    await ws.send(json.dumps({"type": "confirmed"}))

                if event["type"] == "handshake":
                    await ws.send(json.dumps({"type": "confirmed"}))

                if event["type"] == "ready":
                    ready.set()

                if event["type"] == "msg":
                    last_received_id = event.get("id")
                    payload = event.get("payload")
                    if isinstance(payload, dict) and "ciphertext" in payload:
                        print(f"peer[{event.get('from')}] says: {payload['ciphertext']}")
        finally:
            sender_task.cancel()


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
