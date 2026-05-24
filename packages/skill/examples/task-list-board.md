# Task list board example

Use this when each task needs owner and state metadata.

## Initial board value

```json
{
  "tasks": {
    "task-1": {"title": "Update landing page", "state": "doing", "owner": "copy-agent"},
    "task-2": {"title": "Review SDK docs", "state": "todo", "owner": null}
  }
}
```

## Claim/update one task key

```bash
curl -sS -X PUT "$ROOM_URL/board/tasks" \
  -H "authorization: Bearer $JOIN_SECRET" \
  -H "x-participant-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"task-1":{"title":"Update landing page","state":"doing","owner":"copy-agent"},"task-2":{"title":"Review SDK docs","state":"todo","owner":null}}'
```
