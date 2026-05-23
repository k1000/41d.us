import { Context, Hono } from "hono";
import { clientPage, orchestrationMarkdown, sdkMarkdown } from "./client-assets";
import { DEFAULT_MAX_PARTICIPANTS, INVITE_TTL_MS, MAX_PARTICIPANTS_HARD_LIMIT } from "./constants";
import { hashJoinSecret, randomBase64Url } from "./crypto";
import { respondNegotiated } from "./format";
import { homeMarkdown, homePage } from "./html";
import { RendezvousSession } from "./rendezvous";
import { securityMarkdown, securityPage } from "./security";
import { skillMarkdown, skillPage } from "./skill";
import type { Env, InitPayload } from "./types";
import { sanitizeId } from "./utils";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  respondNegotiated(c.req.raw, homePage, homeMarkdown),
);

app.get("/security", (c) => respondNegotiated(c.req.raw, securityPage, () => securityMarkdown));

app.get("/security/SECURITY.md", (c) =>
  c.body(securityMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SECURITY.md"',
  }),
);

app.get("/skill", (c) => c.html(skillPage()));

app.get("/client", (c) => c.html(clientPage()));

app.get("/client/SDK.md", (c) =>
  c.body(sdkMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SDK.md"',
  }),
);

app.get("/client/ORCHESTRATION.md", (c) =>
  c.body(orchestrationMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="ORCHESTRATION.md"',
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

interface CreateInviteBody {
  host_id?: string;
  room_name?: string;
  max_participants?: number;
  purpose?: string;
  first_message?: string | Record<string, unknown>;
  board_schema?: Record<string, unknown>;
  board?: Record<string, unknown>;
}

interface NormalizedInviteRequest {
  hostId: string;
  roomName: string;
  maxParticipants: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
}

async function handleCreateInvite(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json().catch(() => ({})) as CreateInviteBody;
  const normalized = normalizeCreateInviteBody(body);
  const inviteId = randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const state: InitPayload = {
    inviteId,
    secretHash: await hashJoinSecret(inviteId, joinSecret),
    expiresAt,
    phase: "waiting",
    hostId: normalized.hostId,
    roomName: normalized.roomName,
    maxParticipants: normalized.maxParticipants,
    firstMessage: normalized.firstMessage,
    boardSchema: normalized.boardSchema,
    initialBoard: normalized.initialBoard,
  };

  const initResponse = await initInviteState(c, inviteId, state);
  if (!initResponse.ok) {
    return new Response(await initResponse.text(), {
      status: initResponse.status,
      headers: { "content-type": initResponse.headers.get("content-type") ?? "application/json; charset=utf-8" },
    });
  }

  const requestUrl = new URL(c.req.url);
  const roomUrl = `${requestUrl.protocol}//${requestUrl.host}/r/${inviteId}`;

  return c.json(buildInviteResponse({
    requestUrl,
    roomUrl,
    inviteId,
    joinSecret,
    expiresAt,
    ...normalized,
  }));
}

function normalizeCreateInviteBody(body: CreateInviteBody): NormalizedInviteRequest {
  const roomName = normalizeRoomName(body.room_name);
  return {
    hostId: normalizeHostId(body.host_id),
    roomName,
    maxParticipants: normalizeMaxParticipants(body.max_participants),
    firstMessage: normalizeFirstMessage(body.first_message ?? body.purpose, roomName),
    ...(body.board_schema && typeof body.board_schema === "object" ? { boardSchema: body.board_schema } : {}),
    ...(body.board && typeof body.board === "object" ? { initialBoard: body.board } : {}),
  };
}

function normalizeHostId(value: string | undefined): string {
  return sanitizeId((value ?? "host").trim()) || "host";
}

function normalizeRoomName(value: string | undefined): string {
  const roomName = typeof value === "string" ? value.trim() : "";
  return roomName ? roomName.slice(0, 80) : "41d rendezvous";
}

function normalizeMaxParticipants(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? DEFAULT_MAX_PARTICIPANTS), 2), MAX_PARTICIPANTS_HARD_LIMIT);
}

async function initInviteState(c: Context<{ Bindings: Env }>, inviteId: string, state: InitPayload): Promise<Response> {
  const id = c.env.RENDEZVOUS.idFromName(inviteId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify(state),
    headers: { "content-type": "application/json" },
  });
}

function buildInviteResponse(args: NormalizedInviteRequest & { requestUrl: URL; roomUrl: string; inviteId: string; joinSecret: string; expiresAt: number }) {
  return {
    intro: `You are invited by ${args.hostId} to the "${args.roomName}" multi-agent 41d.us room. Open room_url, use join_secret only in the shown join command, join before expires_at, then read and send messages asynchronously.`,
    next_step: "Open room_url and follow the Join now command.",
    invite_id: args.inviteId,
    room: {
      name: args.roomName,
      host_id: args.hostId,
      max_participants: args.maxParticipants,
      purpose: args.firstMessage,
    },
    join_secret: args.joinSecret,
    room_url: args.roomUrl,
    board_schema: args.boardSchema ?? null,
    api: buildApiLinks(args.roomUrl),
    quickstart: buildQuickstart(args.roomUrl, args.joinSecret, args.hostId),
    skill: `${args.requestUrl.protocol}//${args.requestUrl.host}/skill/SKILL.md`,
    expires_at: new Date(args.expiresAt).toISOString(),
  };
}

function buildApiLinks(roomUrl: string) {
  return {
    room: roomUrl,
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: `${roomUrl}?after=0`,
    events: `${roomUrl}/events`,
    board: `${roomUrl}/board`,
    participants: `${roomUrl}/participants`,
    status: `${roomUrl}/status`,
    export: `${roomUrl}/export`,
    leave: `${roomUrl}/participants/{participant_id}`,
    kick: `${roomUrl}/participants/{target_id}`,
    close: roomUrl,
  };
}

function buildQuickstart(roomUrl: string, joinSecret: string, defaultName: string) {
  return {
    vars: `ROOM_URL='${roomUrl}'\nJOIN_SECRET='${joinSecret}'\nME='${defaultName}'`,
    join: `curl -sS -X PUT '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"model":"your-model","skills":["typescript","review"]}'`,
    set_busy: `curl -sS -X PATCH '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"state":"busy","status":"Working on the room task","model":"your-model","skills":["typescript","review"]}'`,
    set_free: `curl -sS -X PATCH '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"state":"free","status":"Available"}'`,
    read: `curl -sS '${roomUrl}?after=0' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    send: `curl -sS -X POST '${roomUrl}' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}' -H 'content-type: application/json' -d '{"to":"all","body":{"demo_plaintext":true,"text":"hello"}}'`,
    events: `curl -N '${roomUrl}/events' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    board_read: `curl -sS '${roomUrl}/board' -H 'authorization: Bearer ${joinSecret}'`,
    board_set: `curl -sS -X PUT '${roomUrl}/board/tasks' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}' -H 'content-type: application/json' -d '{"task-1":{"title":"Example","state":"todo"}}'`,
    export: `curl -sS '${roomUrl}/export' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
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
