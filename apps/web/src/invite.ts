import type { Context } from "hono";
import { hashJoinSecret, randomBase64Url } from "@41d/sdk/crypto";
import { INVITE_TTL_MS, MIN_INVITE_TTL_MS, MAX_INVITE_TTL_MS } from "./constants";
import { normalizeRoomId, normalizeHostId, normalizeRoomName, normalizeMaxParticipants } from "./validation";
import { applyTemplate } from "./room/templates";
import type { Env, InitPayload } from "./types";

export interface CreateRoomBody {
  template?: string;
  room_id?: string;
  host_id?: string;
  host_public_key?: string;
  host_model?: string;
  room_name?: string;
  max_participants?: number;
  purpose?: string;
  first_message?: string | Record<string, unknown>;
  board_schema?: Record<string, unknown>;
  board_acls?: Record<string, unknown>;
  states?: Record<string, unknown>;
  board?: Record<string, unknown>;
  invite_ttl_ms?: number;
  /** Optional identity hints for the invited agent, included in the response. */
  suggested_id?: string;
  suggested_model?: string;
  suggested_skills?: string[];
}

export interface NormalizedCreateRoomRequest {
  roomId: string;
  hostId: string;
  roomName: string;
  purpose: string;
  maxParticipants: number;
  inviteTtlMs: number;
  initialPhase: string;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  boardAcls?: Record<string, unknown>;
  roomStates?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
  hostPublicKey?: string;
  hostModel?: string;
}

/**
 * Create a room and return the invite data. Used by both the Hono handler
 * and the hosted MCP endpoint (avoids mock Hono context).
 */
export async function createRoomDirect(
  env: Env,
  body: CreateRoomBody,
  baseUrl: string,
): Promise<{
  data: Record<string, unknown>;
  joinSecret: string;
  roomId: string;
  roomUrl: string;
  hostJoined: boolean;
}> {
  const normalized = normalizeCreateRoomBody(body);
  const roomId = normalized.roomId;
  const joinSecret = randomBase64Url(32);
  const expiresAt = Date.now() + normalized.inviteTtlMs;
  const hostJoined = !!normalized.hostPublicKey;
  const state: InitPayload = {
    roomId,
    secretHash: await hashJoinSecret(roomId, joinSecret),
    expiresAt,
    phase: normalized.initialPhase,
    hostId: normalized.hostId,
    roomName: normalized.roomName,
    purpose: normalized.purpose,
    maxParticipants: normalized.maxParticipants,
    firstMessage: normalized.firstMessage,
    boardSchema: normalized.boardSchema,
    roomStates: normalized.roomStates as Record<string, import("./types").RoomStateConfig> | undefined,
    boardAcls: normalized.boardAcls as import("./types").BoardAcls | undefined,
    initialBoard: normalized.initialBoard,
    hostPublicKey: normalized.hostPublicKey,
    hostModel: normalized.hostModel,
  };

  const id = env.RENDEZVOUS.idFromName(roomId);
  const stub = env.RENDEZVOUS.get(id);
  const initResponse = await stub.fetch("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify(state),
    headers: { "content-type": "application/json" },
  });
  if (!initResponse.ok) {
    throw new Error(`failed to create room: ${initResponse.status} ${await initResponse.text()}`);
  }

  const origin = new URL(baseUrl).origin;
  const roomUrl = `${origin}/r/${roomId}`;
  const data: Record<string, unknown> = {
    access: roomUrl,
    join_secret: joinSecret,
    room_name: normalized.roomName,
    purpose: normalized.purpose,
    host_id: normalized.hostId,
    expires_at: new Date(expiresAt).toISOString(),
    host_joined: hostJoined,
    ...(hostJoined ? { cursor: normalized.firstMessage ? 1 : 0 } : {}),
    ...(body.suggested_id ? { suggested_id: body.suggested_id } : {}),
    ...(body.suggested_model ? { suggested_model: body.suggested_model } : {}),
    ...(body.suggested_skills ? { suggested_skills: body.suggested_skills } : {}),
  };
  return { data, joinSecret, roomId, roomUrl, hostJoined };
}

export async function handleCreateRoom(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json().catch(() => ({})) as CreateRoomBody;
  try {
    const { data } = await createRoomDirect(c.env, body, c.req.url);
    return c.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Try to extract status code from error message (e.g. "failed to create room: 409 ...")
    const statusMatch = message.match(/failed to create room: (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

function normalizeCreateRoomBody(body: CreateRoomBody): NormalizedCreateRoomRequest {
  // Apply template defaults, overlay explicit body fields.
  const tpl = applyTemplate(body.template, {
    room_name: body.room_name,
    board: recordOrUndefined(body.board),
    board_acls: recordOrUndefined(body.board_acls),
    states: recordOrUndefined(body.states),
  });

  const roomName = normalizeRoomName(tpl.room_name);
  const purpose = normalizePurpose(body.purpose, roomName);
  return {
    roomId: normalizeRoomId(body.room_id),
    hostId: normalizeHostId(body.host_id),
    roomName,
    purpose,
    maxParticipants: normalizeMaxParticipants(body.max_participants),
    inviteTtlMs: normalizeInviteTtl(body.invite_ttl_ms),
    firstMessage: normalizeFirstMessage(body.first_message, purpose) ?? tpl.first_message,
    initialPhase: tpl.initial_phase,
    boardAcls: tpl.board_acls as Record<string, unknown>,
    roomStates: tpl.states as unknown as Record<string, unknown>,
    initialBoard: tpl.board,
    ...(body.board_schema && typeof body.board_schema === "object" ? { boardSchema: body.board_schema } : {}),
    ...normalizeHostHints(body),
  };
}

function normalizeHostHints(body: CreateRoomBody): Pick<NormalizedCreateRoomRequest, "hostPublicKey" | "hostModel"> {
  return {
    hostPublicKey: body.host_public_key ? body.host_public_key.slice(0, 256) : undefined,
    hostModel: body.host_model ? body.host_model.slice(0, 120) : undefined,
  };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
