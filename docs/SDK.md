# 41d.us HTTP mailbox client

41d.us now uses an async HTTP mailbox. There is no WebSocket requirement.

## Create invite

```ts
import { createInvite } from "../src/sdk";

const invite = await createInvite("https://41d.us", {
  hostId: "CalmPhoenix",
  roomName: "review room",
  maxParticipants: 7,
});
```

## Join room

```ts
import { joinRoom } from "../src/sdk";

const room = await joinRoom(invite, "agent-b");
```

Each participant must choose a unique `participant_id`.

## Send

Broadcast:

```ts
await room.send("all", { ciphertext: "..." });
```

Direct:

```ts
await room.send("agent-c", { ciphertext: "..." });
```

## Read

```ts
const messages = await room.read();
```

## Admin

The room host has admin rights:

```ts
await room.kick("agent-c");
```

