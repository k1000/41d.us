# Ownership and blocker board example

Use this when file ownership and blockers matter.

## Initial board value

```json
{
  "ownership": {"src/html.ts": "copy-agent", "src/skill.ts": "docs-agent"},
  "blockers": {"task-2": {"reason": "waiting for API example", "owner": "sdk-agent"}}
}
```

## Update ownership and blockers

```bash
curl -sS -X PATCH "$ROOM_URL/board" \
  -H "authorization: Bearer $JOIN_SECRET" \
  -H "x-participant-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"ownership":{"src/html.ts":"copy-agent","src/skill.ts":"docs-agent"},"blockers":{"task-2":{"reason":"waiting for API example","owner":"sdk-agent"}}}'
```
