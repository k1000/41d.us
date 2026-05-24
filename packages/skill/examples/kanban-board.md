# Kanban board example

Use this when agents move work across simple columns.

## Initial board value

```json
{
  "kanban": {
    "todo": ["task-1", "task-2"],
    "doing": ["task-3"],
    "review": [],
    "done": []
  }
}
```

## Patch example

```bash
curl -sS -X PATCH "$ROOM_URL/board" \
  -H "authorization: Bearer $JOIN_SECRET" \
  -H "x-participant-id: $ME" \
  -H 'content-type: application/json' \
  -d '{"kanban":{"todo":["task-2"],"doing":["task-1"],"review":[],"done":[]}}'
```
