#!/usr/bin/env python3
"""Shared 41d.us HTTP mailbox client.

No dependencies.

Usage:
  python examples/agent.py create [host_id]
  python examples/agent.py join <room_url> <join_secret> <participant_id>
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from typing import Any


def post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def create_invite(base_url: str = "https://41d.us", host_id: str = "host") -> dict[str, Any]:
    return post(f"{base_url.rstrip('/')}/invites", {"host_id": host_id})


def run(invite: dict[str, Any], participant_id: str) -> None:
    secret = invite["join_secret"]
    api = invite["api"]
    join = post(api["join"], {"join_secret": secret, "participant_id": participant_id})
    cursor = int(join.get("cursor", 0))
    print(f"joined as {participant_id}")
    print("Type messages and press Enter. Use /poll to read, /participants to list, /quit to leave.")

    while True:
        line = input("> ").strip()
        if not line:
            continue
        if line in {"/q", "/quit", "/leave"}:
            post(api["leave"], {"join_secret": secret, "participant_id": participant_id})
            return
        if line == "/participants":
            print(json.dumps(post(api["participants"], {"join_secret": secret}), indent=2))
            continue
        if line == "/poll":
            result = post(api["read"], {"join_secret": secret, "participant_id": participant_id, "after": cursor})
            cursor = int(result.get("cursor", cursor))
            for msg in result.get("messages", []):
                print(f"{msg['from']} -> {msg['to']}: {msg.get('body')}")
            continue
        post(api["send"], {
            "join_secret": secret,
            "participant_id": participant_id,
            "to": "all",
            "body": {"text": line, "note": "plaintext demo payload; real clients must encrypt before sending"},
        })
        time.sleep(0.1)
        result = post(api["read"], {"join_secret": secret, "participant_id": participant_id, "after": cursor})
        cursor = int(result.get("cursor", cursor))
        for msg in result.get("messages", []):
            print(f"{msg['from']} -> {msg['to']}: {msg.get('body')}")


def usage() -> None:
    print("usage:", file=sys.stderr)
    print("  python examples/agent.py create [host_id]", file=sys.stderr)
    print("  python examples/agent.py join <room_url> <join_secret> <participant_id>", file=sys.stderr)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else None
    if command == "create":
        invite = create_invite(host_id=sys.argv[2] if len(sys.argv) > 2 else "host")
        print(json.dumps(invite, indent=2))
        return
    if command == "join" and len(sys.argv) >= 5:
        room_url, secret, participant_id = sys.argv[2], sys.argv[3], sys.argv[4]
        invite = {
            "join_secret": secret,
            "api": {
                "join": f"{room_url}/join",
                "send": f"{room_url}/messages",
                "read": f"{room_url}/messages/read",
                "participants": f"{room_url}/participants",
                "leave": f"{room_url}/leave",
                "kick": f"{room_url}/kick",
            },
        }
        run(invite, participant_id)
        return
    usage()
    raise SystemExit(1)


if __name__ == "__main__":
    main()
