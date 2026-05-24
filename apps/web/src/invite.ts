import type { Context } from "hono";
import { hashJoinSecret, randomBase64Url } from "../../../packages/sdk/src/crypto";
import { sanitizeId, DEFAULT_MAX_PARTICIPANTS, MAX_PARTICIPANTS_HARD_LIMIT, INVITE_TTL_MS } from "./constants";
import type { Env, InitPayload } from "./types";

export interface CreateInviteBody {
  room_id?: string;
  host_id?: string;
  room_name?: string;
  max_participants?: number;
  purpose?: string;
  first_message?: string | Record<string, unknown>;
  board_schema?: Record<string, unknown>;
  board?: Record<string, unknown>;
}

export interface NormalizedInviteRequest {
  roomId: string;
  hostId: string;
  roomName: string;
  maxParticipants: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
}

export async function handleCreateInvite(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json().catch(() => ({})) as CreateInviteBody;
  const normalized = normalizeCreateInviteBody(body);
  const roomId = normalized.roomId;
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const state: InitPayload = {
    roomId,
    secretHash: await hashJoinSecret(roomId, joinSecret),
    expiresAt,
    phase: "waiting",
    hostId: normalized.hostId,
    roomName: normalized.roomName,
    maxParticipants: normalized.maxParticipants,
    firstMessage: normalized.firstMessage,
    boardSchema: normalized.boardSchema,
    initialBoard: normalized.initialBoard,
  };

  const initResponse = await initInviteState(c, roomId, state);
  if (!initResponse.ok) {
    return new Response(await initResponse.text(), {
      status: initResponse.status,
      headers: { "content-type": initResponse.headers.get("content-type") ?? "application/json; charset=utf-8" },
    });
  }

  const requestUrl = new URL(c.req.url);
  const roomUrl = `${requestUrl.protocol}//${requestUrl.host}/r/${roomId}`;

  return c.json(buildInviteResponse({
    requestUrl,
    roomUrl,
    joinSecret,
    expiresAt,
    ...normalized,
  }));
}

function normalizeCreateInviteBody(body: CreateInviteBody): NormalizedInviteRequest {
  const roomName = normalizeRoomName(body.room_name);
  return {
    roomId: normalizeRoomId(body.room_id),
    hostId: normalizeHostId(body.host_id),
    roomName,
    maxParticipants: normalizeMaxParticipants(body.max_participants),
    firstMessage: normalizeFirstMessage(body.first_message ?? body.purpose, roomName),
    ...(body.board_schema && typeof body.board_schema === "object" ? { boardSchema: body.board_schema } : {}),
    ...(body.board && typeof body.board === "object" ? { initialBoard: body.board } : {}),
  };
}

function normalizeRoomId(value: string | undefined): string {
  const proposed = typeof value === "string" ? sanitizeId(value.trim()) : "";
  return proposed || randomBase64Url(16);
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

function normalizeFirstMessage(value: string | Record<string, unknown> | undefined, roomName: string): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : undefined;
  }
  if (value && typeof value === "object") return value;
  return { text: `Room purpose: ${roomName}` };
}

async function initInviteState(c: Context<{ Bindings: Env }>, roomId: string, state: InitPayload): Promise<Response> {
  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify(state),
    headers: { "content-type": "application/json" },
  });
}

function buildInviteResponse(args: NormalizedInviteRequest & { requestUrl: URL; roomUrl: string; roomId: string; joinSecret: string; expiresAt: number }) {
  return {
    intro: `You are invited by ${args.hostId} to the "${args.roomName}" multi-agent 41d.us room. Open room_url, use join_secret only in the shown join command, join before expires_at, then read and send messages asynchronously.`,
    next_step: "Open room_url and follow the Join now command.",
    room_id: args.roomId,
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
    quickstart: buildQuickstart(args.roomUrl, args.joinSecret, args.hostId, args.roomName),
    skill: `${args.requestUrl.protocol}//${args.requestUrl.host}/skill/SKILL.md`,
    expires_at: new Date(args.expiresAt).toISOString(),
  };
}

function buildApiLinks(roomUrl: string) {
  const origin = new URL(roomUrl).origin;
  return {
    room: roomUrl,
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: roomUrl,
    read_all: `${origin}/r/{room_id}?view=all`,
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

function buildQuickstart(roomUrl: string, joinSecret: string, defaultName: string, roomName = "room") {
  const origin = new URL(roomUrl).origin;
  const clientScriptUrl = `${origin}/client/41d.js`;
  const cryptoShUrl = `${origin}/client/crypto.sh`;
  const roomFile = `${sanitizeId(roomName) || "room"}.json`;
  return {
    vars: `ROOM_URL='${roomUrl}'\nJOIN_SECRET='${joinSecret}'\nME='${defaultName}'`,
    join: `curl -sS -X PUT '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"model":"your-model","skills":["typescript","review"]}'`,
    create_room_file: `curl -fsSL '${clientScriptUrl}' | node - create '${origin}' '{"host_id":"${defaultName}","room_name":"${roomName}"}' > ${roomFile}`,
    join_encrypted_client: `curl -fsSL '${clientScriptUrl}' | node - join '${roomUrl}' '${joinSecret}' '${defaultName}'`,
    join_from_room_file: `curl -fsSL '${clientScriptUrl}' | node - join ${roomFile} '${defaultName}'`,
    set_busy: `curl -sS -X PATCH '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"state":"busy","status":"Working on the room task","model":"your-model","skills":["typescript","review"]}'`,
    set_free: `curl -sS -X PATCH '${roomUrl}/participants/${encodeURIComponent(defaultName)}' -H 'authorization: Bearer ${joinSecret}' -H 'content-type: application/json' -d '{"state":"free","status":"Available"}'`,
    read_recent: `curl -sS '${roomUrl}' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    read_all: `curl -sS '${roomUrl}?view=all' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    send_encrypted: `curl -fsSL '${clientScriptUrl}' | node - send '${roomUrl}' '${joinSecret}' '${defaultName}' all '{"text":"hello"}'`,
    send_from_room_file: `curl -fsSL '${clientScriptUrl}' | node - send ${roomFile} '${defaultName}' all '{"text":"hello"}'`,
    read_from_room_file: `curl -fsSL '${clientScriptUrl}' | node - read ${roomFile} '${defaultName}'`,
    doctor_from_room_file: `curl -fsSL '${clientScriptUrl}' | node - doctor ${roomFile} '${defaultName}'`,
    send_local_encrypted_payload: `TOKEN=$(curl -fsSL '${cryptoShUrl}' | bash -s -- enc "$PAYLOAD_PASSPHRASE" '{"text":"hello"}'); curl -sS -X POST '${roomUrl}' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}' -H 'content-type: application/json' -d '{"to":"all","body":{"encrypted_payload":"'"$TOKEN"'"}}'`,
    events: `curl -N '${roomUrl}/events' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    board_read: `curl -sS '${roomUrl}/board' -H 'authorization: Bearer ${joinSecret}'`,
    board_set: `curl -sS -X PUT '${roomUrl}/board/tasks' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}' -H 'content-type: application/json' -d '{"task-1":{"title":"Example","state":"todo"}}'`,
    export: `curl -sS '${roomUrl}/export' -H 'authorization: Bearer ${joinSecret}' -H 'x-participant-id: ${defaultName}'`,
    participants: `curl -sS '${roomUrl}/participants' -H 'authorization: Bearer ${joinSecret}'`,
    status: `curl -sS '${roomUrl}/status' -H 'authorization: Bearer ${joinSecret}'`,
  };
}
