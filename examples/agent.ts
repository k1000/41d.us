import { createInvite, joinRoom } from "../src/sdk";

const command = process.argv[2];

if (command === "create") {
  const hostId = process.argv[3] ?? "host";
  const invite = await createInvite("https://41d.us", { hostId });
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
    api: {
      join: `${roomUrl}/join`,
      send: `${roomUrl}/messages`,
      read: `${roomUrl}/messages/read`,
      participants: `${roomUrl}/participants`,
      leave: `${roomUrl}/leave`,
      kick: `${roomUrl}/kick`,
    },
  } as Awaited<ReturnType<typeof createInvite>>;

  const room = await joinRoom(invite, participantId);
  console.log(`joined as ${participantId}`);
  console.log(await room.participants());
} else {
  usage();
  process.exit(1);
}

function usage(): void {
  console.error("usage:");
  console.error("  npm exec tsx examples/agent.ts create [host_id]");
  console.error("  npm exec tsx examples/agent.ts join <room_url> <join_secret> <participant_id>");
}
