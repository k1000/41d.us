import { connectRendezvous, createInvite, type AgentRole } from "../src/sdk";

const command = process.argv[2];

if (command === "create") {
  const invite = await createInvite();
  printSecret("Share this invite with the other agent through a trusted channel", invite);
  await run(invite.url, invite.join_secret, "a");
} else if (command === "join") {
  const url = process.argv[3];
  const joinSecret = process.argv[4];
  const role = (process.argv[5] ?? "b") as AgentRole;

  if (!url || !joinSecret || (role !== "a" && role !== "b")) {
    usage();
    process.exit(1);
  }

  await run(url, joinSecret, role);
} else {
  usage();
  process.exit(1);
}

async function run(url: string, joinSecret: string, role: AgentRole): Promise<void> {
  const session = await connectRendezvous({ url, joinSecret, role });

  console.log(`connected as Agent ${role.toUpperCase()}`);

  session.on((event) => {
    console.log("event", event);

    if (event.type === "peer_joined") {
      session.sendHandshake({ demo: `agent-${role}-ephemeral-public-key` });
      session.confirm();
    }

    if (event.type === "handshake") {
      session.confirm();
    }

    if (event.type === "ready") {
      session.sendEncrypted({ ciphertext: `demo-ciphertext-from-agent-${role}` });
    }
  });
}

function printSecret(label: string, value: unknown): void {
  console.log(label);
  console.log(JSON.stringify(value, null, 2));
  console.log("Do not persist the join_secret.");
}

function usage(): void {
  console.error("usage:");
  console.error("  npm exec tsx examples/agent.ts create");
  console.error("  npm exec tsx examples/agent.ts join <url> <join_secret> [a|b]");
}
