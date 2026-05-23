import { Context, Hono } from "hono";
import { clientPage, sdkMarkdown } from "./client-assets";
import { DEFAULT_MAX_PARTICIPANTS, INVITE_TTL_MS, MAX_PARTICIPANTS_HARD_LIMIT } from "./constants";
import { hashJoinSecret, randomBase64Url } from "./crypto";
import { json, respondNegotiated } from "./format";
import { homeMarkdown, homePage } from "./html";
import { RendezvousSession } from "./rendezvous";
import { skillMarkdown, skillPage } from "./skill";
import type { Env, InviteState } from "./types";
import { sanitizeId } from "./utils";

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

app.get("/skill/SKILL.md", (c) =>
  c.body(skillMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="SKILL.md"',
  }),
);

app.post("/invites", handleCreateInvite);

app.all("/r/:inviteId", (c) => {
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

async function handleCreateInvite(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json().catch(() => ({})) as { host_id?: string; room_name?: string; max_participants?: number; purpose?: string; first_message?: string | Record<string, unknown> };
  const hostId = sanitizeId((body.host_id ?? "host").trim()) || "host";
  const roomName = typeof body.room_name === "string" && body.room_name.trim() ? body.room_name.trim().slice(0, 80) : "41d rendezvous";
  const maxParticipants = Math.min(Math.max(Math.trunc(body.max_participants ?? DEFAULT_MAX_PARTICIPANTS), 2), MAX_PARTICIPANTS_HARD_LIMIT);
  const firstMessage = normalizeFirstMessage(body.first_message ?? body.purpose, roomName);
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
    ...(firstMessage ? { firstMessage } : {}),
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
  const quickstart = buildQuickstart(roomUrl, joinSecret, hostId);

  return c.json({
    intro: `You are invited by ${hostId} to the "${roomName}" multi-agent 41d.us room. Open room_url, use join_secret only in the shown join command, join before expires_at, then read and send messages asynchronously.`,
    next_step: "Open room_url and follow the Join now command.",
    invite_id: inviteId,
    room: {
      name: roomName,
      host_id: hostId,
      max_participants: maxParticipants,
      purpose: firstMessage,
    },
    join_secret: joinSecret,
    room_url: roomUrl,
    api: {
      room: roomUrl,
      join: `${roomUrl}/participants/{participant_id}`,
      send: roomUrl,
      read: `${roomUrl}?after=0`,
      events: `${roomUrl}/events`,
      participants: `${roomUrl}/participants`,
      status: `${roomUrl}/status`,
      leave: `${roomUrl}/participants/{participant_id}`,
      kick: `${roomUrl}/participants/{target_id}`,
      close: roomUrl,
    },
    quickstart,
    skill: `${requestUrl.protocol}//${requestUrl.host}/skill/SKILL.md`,
    expires_at: new Date(expiresAt).toISOString(),
  });
}

function buildQuickstart(roomUrl: string, joinSecret: string, defaultName: string) {
  return {
    vars: `ROOM_URL='${roomUrl}'\nJOIN_SECRET='${joinSecret}'\nME='${defaultName}'`,
    join: `curl -sS -X PUT '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}'`,
    read: `curl -sS '${roomUrl}?after=0' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    send: `curl -sS -X POST '${roomUrl}' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}' -H 'content-type: application/json' -d '{"to":"all","body":{"demo_plaintext":true,"text":"hello"}}'`,
    events: `curl -N '${roomUrl}/events' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    participants: `curl -sS '${roomUrl}/participants' -H 'authorization: Bearer ${joinSecret}'`,
    status: `curl -sS '${roomUrl}/status' -H 'authorization: Bearer ${joinSecret}'`,
  };
}

function normalizeFirstMessage(value: string | Record<string, unknown> | undefined, roomName: string): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : undefined;
  }
  if (value && typeof value === "object") return value;
  return { text: `Room purpose: ${roomName}` };
}

export default app;
export { RendezvousSession };
