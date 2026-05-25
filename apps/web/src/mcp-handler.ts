/**
 * Hosted MCP endpoint — serves 41d.us room operations as an HTTP MCP server.
 * No repo clone or local code needed: MCP hosts configure a URL.
 *
 * MCP client configuration:
 * ```json
 * {
 *   "mcpServers": {
 *     "41d.us": { "url": "https://41d.us/mcp" }
 *   }
 * }
 * ```
 *
 * Implements the MCP Streamable HTTP transport specification directly
 * using Cloudflare Workers' Web Standard APIs.
 */

import type { Env } from "./types";
import { createRoomDirect } from "./invite";
import type { CreateRoomBody } from "./invite";
import { createSdkCryptoSession } from "@41d/sdk/crypto-session";
import type { SdkCryptoSession } from "@41d/sdk/crypto-session";
import type { RoomMessage } from "./types";

// ── Unified session store (per-worker-isolate, in-memory) ───────
// Key: roomId:participantId. Stores ECDH session + per-participant token.

interface SessionStore {
  ecdh: SdkCryptoSession;
  token?: string;  // per-participant token
  roomUrl: string;
}

const sessions = new Map<string, SessionStore>();

function sessionKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

function getEffectiveSecret(roomUrl: string, participantId: string, fallbackSecret: string): string {
  const roomId = roomUrl.split("/").pop()!;
  return sessions.get(sessionKey(roomId, participantId))?.token ?? fallbackSecret;
}

function isUsingParticipantToken(roomUrl: string, participantId: string, fallbackSecret: string): boolean {
  const roomId = roomUrl.split("/").pop()!;
  const entry = sessions.get(sessionKey(roomId, participantId));
  return !!entry?.token && entry.token !== fallbackSecret;
}

async function ensureEcdhSession(roomId: string, participantId: string): Promise<SdkCryptoSession> {
  const key = sessionKey(roomId, participantId);
  let entry = sessions.get(key);
  if (!entry) {
    entry = { ecdh: await createSdkCryptoSession(participantId), roomUrl: "" };
    sessions.set(key, entry);
  }
  return entry.ecdh;
}

function storeToken(roomId: string, participantId: string, token: string, roomUrl: string): void {
  const entry = sessions.get(sessionKey(roomId, participantId));
  if (!entry) throw new Error(`storeToken called before ensureEcdhSession for ${participantId}`);
  entry.token = token;
  entry.roomUrl = roomUrl;
}

function clearRoomSessions(roomId: string): void {
  for (const key of sessions.keys()) {
    if (key.startsWith(roomId + ":")) sessions.delete(key);
  }
}

// ── DO stub helpers (avoid HTTP loopback) ───────────────────────

function getRoomStub(env: Env, roomUrlOrId: string): DurableObjectStub {
  const roomId = roomUrlOrId.includes("/") ? roomUrlOrId.split("/").pop()! : roomUrlOrId;
  const id = env.RENDEZVOUS.idFromName(roomId);
  return env.RENDEZVOUS.get(id);
}

async function doFetch(
  env: Env,
  roomUrl: string,
  path: string,
  secret: string,
  options: { method?: string; body?: unknown; participantId?: string } = {},
): Promise<unknown> {
  // Use per-participant token when available (more secure than room-level join_secret)
  const effectiveSecret = options.participantId
    ? getEffectiveSecret(roomUrl, options.participantId, secret)
    : secret;
  const usingToken = options.participantId
    && isUsingParticipantToken(roomUrl, options.participantId, secret);
  const stub = getRoomStub(env, roomUrl);
  const url = new URL(path, roomUrl);
  const headers: Record<string, string> = { authorization: `Bearer ${effectiveSecret}` };
  // Only send x-participant-id when using the room-level secret (per-participant token
  // already encodes the participant ID, so the server resolves it automatically)
  if (options.participantId && !usingToken) {
    headers["x-participant-id"] = options.participantId;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await stub.fetch(url.toString(), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return response.json();
}

function parseRoomId(inviteJson: string): { roomId: string; roomUrl: string; secret: string } {
  const parsed = JSON.parse(inviteJson);
  const roomUrl = parsed.room_url ?? parsed.access ?? parsed.follow;
  if (!roomUrl || !parsed.join_secret) throw new Error("Invalid invite: must have access (or room_url) and join_secret");
  return { roomId: roomUrl.split("/").pop()!, roomUrl: roomUrl.replace(/\/$/, ""), secret: parsed.join_secret };
}

function parseSkills(value?: string): string[] | undefined {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

// ── MCP JSON-RPC helpers ────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: { content: Array<{ type: "text"; text: string }> };
}

interface McpError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

function mcpResult(id: number | string, text: unknown): McpSuccess {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(text, null, 2) }] } };
}

function mcpError(id: number | string | null, code: number, message: string): McpError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── Tool registry ───────────────────────────────────────────────

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, params: Record<string, unknown>) => Promise<unknown>;
}

interface JoinResponse {
  participant_token?: string;
  cursor?: number;
  peers?: Array<{ id: string; public_key: string }>;
}

async function createRoomTool(env: Env, params: Record<string, unknown>): Promise<unknown> {
  const hostId = (params.hostId as string) ?? "agent";
  const room = await createRoomDirect(env, createHostedRoomBody(params, hostId), "https://41d.us");
  const stub = env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(room.roomId));
  const hostCrypto = await ensureEcdhSession(room.roomId, hostId);
  const { public_key: hostPublicKey } = await hostCrypto.announceKeyBody();

  const joinResponse = await stub.fetch(`https://rendezvous.internal/r/${room.roomId}/participants/${encodeURIComponent(hostId)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${room.joinSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ public_key: hostPublicKey, state: "free", status: "joined via hosted MCP" }),
  });
  const joinData = await joinResponse.json() as JoinResponse;
  if (joinData.participant_token) storeToken(room.roomId, hostId, joinData.participant_token, room.roomUrl);
  if (joinData.peers?.length) await hostCrypto.processPeerKeys(joinData.peers);

  await stub.fetch(`https://rendezvous.internal/r/${room.roomId}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${room.joinSecret}`,
      "x-participant-id": hostId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: hostPublicKey } }),
  });

  return {
    ...room.data,
    host_joined: true,
    host_cursor: joinData.cursor ?? 0,
    handoff: JSON.stringify({ access: room.roomUrl, join_secret: room.joinSecret }),
  };
}

function createHostedRoomBody(params: Record<string, unknown>, hostId: string): CreateRoomBody {
  return {
    host_id: hostId,
    room_name: params.roomName as string | undefined,
    max_participants: params.maxParticipants as number | undefined,
    purpose: params.purpose as string | undefined,
    first_message: params.firstMessage as string | undefined,
    board_schema: parseJsonParam(params.boardSchema),
    board_acls: parseJsonParam(params.boardAcls),
    template: params.template as string | undefined,
    board: parseJsonParam(params.board),
  };
}

function parseJsonParam(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

const tools: Record<string, ToolDef> = {
  create_room: {
    description: "Create a new 41d.us encrypted coordination room and auto-join the host. Returns invite + handoff.",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "string", description: "Host identifier (default: agent)" },
        template: { type: "string", enum: ["quick", "kanban", "milestone"], description: "Room template" },
        roomName: { type: "string" },
        maxParticipants: { type: "number" },
        purpose: { type: "string" },
        firstMessage: { type: "string" },
        board: { type: "string" },
        boardSchema: { type: "string" },
        boardAcls: { type: "string" },
      },
    },
    handler: createRoomTool,
  },

  join_room: {
    description: "Join a 41d.us room using a handoff JSON.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: { type: "string" },
        participantId: { type: "string" },
      },
      required: ["inviteJson", "participantId"],
    },
    handler: async (env, params) => {
      const { roomId, roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const crypto = await ensureEcdhSession(roomId, participantId);
      const { public_key } = await crypto.announceKeyBody();

      const joinResult = await doFetch(env, roomUrl, `/participants/${encodeURIComponent(participantId)}`, secret, {
        method: "PUT",
        participantId,
        body: { public_key, state: "free", status: "joined via hosted MCP" },
      }) as JoinResponse & { cursor?: number };

      // Refresh peer keys from server (handles cross-isolate session loss)
      try {
        const participantsResult = await doFetch(env, roomUrl, "/participants", secret) as Record<string, unknown>;
        const participants = (participantsResult.participants ?? []) as Array<{ id: string; public_key?: string }>;
        const peers = participants
          .filter((p) => p.id !== participantId && p.public_key)
          .map((p) => ({ id: p.id, public_key: p.public_key! }));
        if (peers.length > 0) await crypto.processPeerKeys(peers);
      } catch { /* best-effort */ }

      // Announce key
      await doFetch(env, roomUrl, "/", secret, {
        method: "POST", participantId,
        body: { to: "all", intent: "key.exchange", body: { public_key } },
      });

      // Store session with per-participant token for subsequent calls
      if (joinResult.participant_token) {
        storeToken(roomId, participantId, joinResult.participant_token, roomUrl);
      }

      return { ok: true, room_id: roomId, room_url: roomUrl, participant_id: participantId, cursor: joinResult.cursor ?? 0, participant_token: joinResult.participant_token };
    },
  },

  send_message: {
    description: "Send an E2E encrypted message. Optionally update participant status.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: { type: "string" }, participantId: { type: "string" },
        to: { type: "string" }, body: { type: "string" },
        intent: { type: "string" }, priority: { type: "string" },
        state: { type: "string" }, status: { type: "string" },
        model: { type: "string" }, skills: { type: "string" },
      },
      required: ["inviteJson", "participantId", "to", "body"],
    },
    handler: async (env, params) => {
      const { roomId, roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const crypto = await ensureEcdhSession(roomId, participantId);

      // Re-announce key and refresh peer keys (handles cross-isolate session loss)
      await crypto.announceKeyBody();
      try {
        const participantsResult = await doFetch(env, roomUrl, "/participants", secret) as Record<string, unknown>;
        const participants = (participantsResult.participants ?? []) as Array<{ id: string; public_key?: string }>;
        const peers = participants
          .filter((p: { id: string; public_key?: string }) => p.id !== participantId && p.public_key)
          .map((p: { id: string; public_key?: string }) => ({ id: p.id, public_key: p.public_key! }));
        if (peers.length > 0) await crypto.processPeerKeys(peers);
      } catch { /* best-effort peer refresh */ }

      const to = params.to === "all" ? "all" : (params.to as string).includes(",") ? (params.to as string).split(",").map((s) => s.trim()) : params.to as string;
      const encryptedBody = await crypto.encryptForSend(JSON.parse(params.body as string), to);

      const body: Record<string, unknown> = {
        to, body: encryptedBody,
        reply_to: null, intent: params.intent ?? "notify", priority: params.priority ?? "normal",
        state: params.state, status: params.status,
        model: params.model, skills: parseSkills(params.skills as string),
      };
      return doFetch(env, roomUrl, "/", secret, { method: "POST", participantId, body });
    },
  },

  read_messages: {
    description: "Read recent/all messages. Auto-decrypted.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: { type: "string" }, participantId: { type: "string" },
        all: { type: "boolean" }, includeSelf: { type: "boolean" },
      },
      required: ["inviteJson", "participantId"],
    },
    handler: async (env, params) => {
      const { roomId, roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const crypto = await ensureEcdhSession(roomId, participantId);

      // Always include self messages so senders can read their own messages.
      const path = params.all ? "/?view=all&include_self=true" : "/?include_self=true";
      const result = await doFetch(env, roomUrl, path, secret, { participantId }) as { messages?: RoomMessage[]; cursor?: number };
      const messages = result.messages ?? [];

      // Use SDK's proven decryption
      const decrypted = await Promise.all(messages.map(async (msg) => {
        try {
          const body = await crypto.decryptMessageBody(msg);
          return { ...msg, body };
        } catch { return msg; }
      }));

      return { cursor: result.cursor ?? 0, count: decrypted.length, messages: decrypted };
    },
  },

  list_participants: {
    description: "List participants with state, model, skills.",
    inputSchema: { type: "object", properties: { inviteJson: { type: "string" } }, required: ["inviteJson"] },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/participants", secret);
    },
  },

  update_status: {
    description: "Update participant availability state and status text.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: { type: "string" }, participantId: { type: "string" },
        state: { type: "string" }, status: { type: "string" },
        model: { type: "string" }, skills: { type: "string" },
      }, required: ["inviteJson", "participantId", "state", "status"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, `/participants/${params.participantId}`, secret, {
        method: "PATCH",
        participantId: params.participantId as string,
        body: {
          state: params.state,
          status: params.status,
          model: params.model,
          skills: parseSkills(params.skills as string),
        },
      });
    },
  },

  read_board: {
    description: "Read the shared board.",
    inputSchema: { type: "object", properties: { inviteJson: { type: "string" } }, required: ["inviteJson"] },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/board", secret);
    },
  },

  transition_room: {
    description: "Trigger a state machine event to transition the room (host only).",
    inputSchema: {
      type: "object", properties: {
        inviteJson: { type: "string" }, participantId: { type: "string" },
        event: { type: "string" },
      }, required: ["inviteJson", "participantId", "event"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/transition", secret, {
        method: "POST",
        participantId: params.participantId as string,
        body: { event: params.event },
      });
    },
  },

  close_room: {
    description: "Close and delete the room (host only).",
    inputSchema: { type: "object", properties: { inviteJson: { type: "string" }, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params) => {
      const { roomUrl, roomId, secret } = parseRoomId(params.inviteJson as string);
      await doFetch(env, roomUrl, "/", secret, { method: "DELETE", participantId: params.participantId as string });
      // Clear session
      clearRoomSessions(roomId);
      return { ok: true, closed: true };
    },
  },

  leave_room: {
    description: "Leave the room (stays active for others).",
    inputSchema: { type: "object", properties: { inviteJson: { type: "string" }, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params) => {
      const { roomUrl, roomId, secret } = parseRoomId(params.inviteJson as string);
      await doFetch(env, roomUrl, `/participants/${params.participantId}`, secret, { method: "DELETE" });
      sessions.delete(sessionKey(roomId, params.participantId as string));
      return { ok: true, left: true };
    },
  },

  get_room_info: {
    description: "Get room metadata without joining.",
    inputSchema: { type: "object", properties: { inviteJson: { type: "string" } }, required: ["inviteJson"] },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/status", secret);
    },
  },
};

// ── HTTP handler ────────────────────────────────────────────────

/**
 * Handle an incoming MCP-over-HTTP request (Streamable HTTP transport).
 */
export async function handleMcpRequest(request: Request, env?: Env): Promise<Response> {
  if (request.method !== "POST") return jsonRpcResponse(mcpError(null, -32000, "Method not allowed"), 405);

  const parsed = await parseMcpBody(request);
  if (parsed instanceof Response) return parsed;

  switch (parsed.method) {
    case "initialize": return handleInitialize(parsed);
    case "notifications/initialized":
    case "notifications/cancelled": return handleNotification();
    case "tools/list": return handleToolsList(parsed);
    case "tools/call": return handleToolCall(env, parsed);
    case "shutdown": return handleShutdown(parsed);
    default: return jsonRpcResponse(mcpError(parsed.id ?? null, -32601, `Method not found: ${parsed.method}`), 404);
  }
}

async function parseMcpBody(request: Request): Promise<McpRequest | Response> {
  try {
    const body = await request.json() as McpRequest;
    return body.jsonrpc === "2.0"
      ? body
      : jsonRpcResponse(mcpError(body.id ?? null, -32600, "Invalid Request: must be JSON-RPC 2.0"), 400);
  } catch {
    return jsonRpcResponse(mcpError(null, -32700, "Parse error: invalid JSON"), 400);
  }
}

function handleInitialize(body: McpRequest): Response {
  return jsonRpcResponse(mcpResult(body.id ?? 0, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "41d.us", version: "0.1.0" },
  }));
}

function handleNotification(): Response {
  return new Response(null, { status: 202 });
}

function handleToolsList(body: McpRequest): Response {
  const toolList = Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
  return jsonRpcResponse(mcpResult(body.id ?? 0, { tools: toolList }));
}

async function handleToolCall(env: Env | undefined, body: McpRequest): Promise<Response> {
  const name = (body.params?.name as string) ?? "";
  const tool = tools[name];
  if (!tool) return jsonRpcResponse(mcpError(body.id ?? 0, -32601, `Tool not found: ${name}`), 404);
  if (!env) return jsonRpcResponse(mcpError(body.id ?? 0, -32603, "MCP endpoint not configured with environment bindings"), 500);
  try {
    const result = await tool.handler(env, (body.params?.arguments ?? {}) as Record<string, unknown>);
    return jsonRpcResponse(mcpResult(body.id ?? 0, result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcResponse(mcpError(body.id ?? 0, -32603, message), 500);
  }
}

function handleShutdown(body: McpRequest): Response {
  return jsonRpcResponse(mcpResult(body.id ?? 0, null));
}

function jsonRpcResponse(body: McpSuccess | McpError, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
