import { createRoom, joinRoom, type Invite } from "../src/sdk";

const command = process.argv[2];

if (command === "create") {
  const hostId = process.argv[3] ?? "host";
  const invite = await createRoom("https://41d.us", { hostId });
  console.log(JSON.stringify(invite, null, 2));
} else if (command === "join") {
  const roomUrl = process.argv[3];
  const joinSecret = process.argv[4];
  const participantId = process.argv[5];

  if (!roomUrl || !joinSecret || !participantId) {
    usage();
    process.exit(1);
  }

  const invite = {
    join_secret: joinSecret,
    room_url: roomUrl,
    api: {
      board: `${roomUrl}/board`,
      participants: `${roomUrl}/participants`,
      status: `${roomUrl}/status`,
    },
  } as Invite;

  const room = await joinRoom(invite, participantId);
  console.log(`joined as ${participantId}`);

  await room.announceKey();
  console.log("key announced");

  const messages = await room.read();
  console.log(`read ${messages.length} messages`);
  console.log(await room.participants());

  await room.send("all", { text: `hello from ${participantId}` });
  console.log("sent broadcast");
} else {
  usage();
  process.exit(1);
}

function usage(): void {
  console.error("usage:");
  console.error("  npm exec tsx examples/agent.ts create [host_id]");
  console.error("  npm exec tsx examples/agent.ts join <room_url> <join_secret> <participant_id>");
}
