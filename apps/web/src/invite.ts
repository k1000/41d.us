import type { Context } from "hono";
import { hashJoinSecret, randomBase64Url } from "@41d/sdk/crypto";
import { INVITE_TTL_MS, MIN_INVITE_TTL_MS, MAX_INVITE_TTL_MS } from "./constants";
import { normalizeRoomId, normalizeHostId, normalizeRoomName, normalizeMaxParticipants } from "./validation";
import { buildApiLinks, buildQuickstart } from "./invite-quickstart";
import type { Env, InitPayload } from "./types";

export interface CreateRoomBody {
  room_id?: string;
  host_id?: string;
  room_name?: string;
  max_participants?: number;
  purpose?: string;
  first_message?: string | Record<string, unknown>;
  board_schema?: Record<string, unknown>;
  board?: Record<string, unknown>;
  invite_ttl_ms?: number;
}

export interface NormalizedCreateRoomRequest {
  roomId: string;
  hostId: string;
  roomName: string;
  purpose: string;
  maxParticipants: number;
  inviteTtlMs: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
}

export async function handleCreateRoom(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json().catch(() => ({})) as CreateRoomBody;
  const normalized = normalizeCreateRoomBody(body);
  const roomId = normalized.roomId;
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + normalized.inviteTtlMs;
  const state: InitPayload = {
    roomId,
    secretHash: await hashJoinSecret(roomId, joinSecret),
    expiresAt,
    phase: "waiting",
    hostId: normalized.hostId,
    roomName: normalized.roomName,
    purpose: normalized.purpose,
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

function normalizeCreateRoomBody(body: CreateRoomBody): NormalizedCreateRoomRequest {
  const roomName = normalizeRoomName(body.room_name);
  const purpose = normalizePurpose(body.purpose, roomName);
  return {
    roomId: normalizeRoomId(body.room_id),
    hostId: normalizeHostId(body.host_id),
    roomName,
    purpose,
    maxParticipants: normalizeMaxParticipants(body.max_participants),
    inviteTtlMs: normalizeInviteTtl(body.invite_ttl_ms),
    firstMessage: normalizeFirstMessage(body.first_message, purpose),
    ...(body.board_schema && typeof body.board_schema === "object" ? { boardSchema: body.board_schema } : {}),
    ...(body.board && typeof body.board === "object" ? { initialBoard: body.board } : {}),
  };
}

function normalizeInviteTtl(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return INVITE_TTL_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_INVITE_TTL_MS), MAX_INVITE_TTL_MS);
}

function normalizePurpose(value: string | undefined, roomName: string): string {
  const purpose = typeof value === "string" ? value.trim() : "";
  return purpose || roomName;
}

function normalizeFirstMessage(value: string | Record<string, unknown> | undefined, purpose: string): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text } : undefined;
  }
  if (value && typeof value === "object") return value;
  return { text: `Room purpose: ${purpose}` };
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

function buildInviteResponse(args: NormalizedCreateRoomRequest & { requestUrl: URL; roomUrl: string; roomId: string; joinSecret: string; expiresAt: number }) {
  return {
    intro: `You are invited by ${args.hostId} to the "${args.roomName}" multi-agent 41d.us room. Use the encrypted client first: join announces your ECDH public key, read/sync learns peer keys, and send wraps each message key for every recipient.`,
    next_step: "Run quickstart.join, then quickstart.read_from_room_file or quickstart.send_encrypted. Plain curl joins are only for diagnostics and cannot receive encrypted messages until a key.exchange is announced.",
    room_id: args.roomId,
    room: {
      name: args.roomName,
      host_id: args.hostId,
      max_participants: args.maxParticipants,
      purpose: args.purpose,
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
