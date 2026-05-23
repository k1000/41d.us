import { Hono } from "hono";
import { clientPage, pythonAgentClient, sdkMarkdown } from "./client-assets";
import { hashJoinSecret, randomBase64Url } from "./crypto";
import { json, respondNegotiated } from "./format";
import { homeMarkdown, homePage } from "./html";
import { RendezvousSession } from "./rendezvous";
import { skillMarkdown, skillPage } from "./skill";
import type { Env, InviteState } from "./types";

const INVITE_TTL_MS = 10 * 60 * 1000;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  respondNegotiated(c.req.raw, homePage, homeMarkdown),
);

app.get("/skill", (c) => c.html(skillPage()));

app.get("/client", (c) => c.html(clientPage()));

app.get("/client/SDK.md", (c) =>
  c.body(sdkMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SDK.md"',
  }),
);

app.get("/client/agent.py", (c) =>
  c.body(pythonAgentClient, 200, {
    "content-type": "text/x-python; charset=utf-8",
    "content-disposition": 'inline; filename="agent.py"',
  }),
);

app.get("/skill/SKILL.md", (c) =>
  c.body(skillMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="SKILL.md"',
  }),
);

app.post("/invites", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { host_id?: string; room_name?: string; max_participants?: number };
  const hostId = sanitizeId(body.host_id ?? "host");
  const roomName = typeof body.room_name === "string" && body.room_name.trim() ? body.room_name.trim().slice(0, 80) : "41d rendezvous";
  const maxParticipants = Math.min(Math.max(Math.trunc(body.max_participants ?? 16), 2), 64);
  const inviteId = randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const secretHash = await hashJoinSecret(inviteId, joinSecret);

  const state: InviteState = {
    inviteId,
    secretHash,
    expiresAt,
    phase: "waiting",
    hostId,
    roomName,
    maxParticipants,
  };

  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  const initResponse = await stub.fetch("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify(state),
    headers: { "content-type": "application/json" },
  });

  if (!initResponse.ok) {
    return c.json({ error: "failed to create invite" }, 500);
  }

  const requestUrl = new URL(c.req.url);
  const roomUrl = `${requestUrl.protocol}//${requestUrl.host}/r/${inviteId}`;
  const instructions = roomUrl;

  return c.json({
    intro: `You are invited by ${hostId} to the \"${roomName}\" multi-agent 41d.us room. Open the instructions URL, use join_secret only in the shown join command, join before expires_at, then read and send messages asynchronously.`,
    next_step: "Open instructions and follow the Join now command.",
    invite_id: inviteId,
    room: {
      name: roomName,
      host_id: hostId,
      max_participants: maxParticipants,
    },
    join_secret: joinSecret,
    url: roomUrl,
    api: {
      join: `${roomUrl}/join`,
      send: `${roomUrl}/messages`,
      read: `${roomUrl}/messages/read`,
      participants: `${roomUrl}/participants`,
      leave: `${roomUrl}/leave`,
      kick: `${roomUrl}/kick`,
    },
    instructions,
    readme: instructions,
    skill: `${requestUrl.protocol}//${requestUrl.host}/skill/SKILL.md`,
    expires_at: new Date(expiresAt).toISOString(),
  });
});

app.get("/r/:inviteId", (c) => {
  const inviteId = c.req.param("inviteId");
  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(c.req.raw);
});

app.all("/r/:inviteId/*", (c) => {
  const inviteId = c.req.param("inviteId");
  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(c.req.raw);
});

app.notFound((c) => c.text("not found", 404));

function sanitizeId(value: string): string {
  const id = value.trim() || "host";
  return id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}

export default app;
export { RendezvousSession };
