#!/usr/bin/env node

/**
 * @41d/mcp-server — 41d.us MCP Server
 *
 * Exposes 41d.us encrypted room operations as MCP tools.
 * Run with: npx tsx packages/mcp-server/src/index.ts
 *
 * MCP hosts (Claude Desktop, Cursor, VS Code, etc.) can connect via stdio.
 */

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRoomAndJoin } from "@41d/sdk";
import type { Invite } from "@41d/sdk";
import { getOrCreateSession, clearRoomSessions } from "@41d/sdk/session";
import { sessions, parseInvite, parseSkills, anonGet, jsonContent, clientFor } from "./helpers";
export { parseInvite, parseSkills };

export function parseFirstMessage(value: string): string | Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : value;
  } catch {
    return value;
  }
}

interface CreateRoomToolArgs {
  template?: "quick" | "kanban" | "milestone";
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  inviteTtlMinutes?: number;
  purpose?: string;
  firstMessage?: string;
  board?: string;
  boardSchema?: string;
  boardAcls?: string;
  suggestedId?: string;
  suggestedModel?: string;
  suggestedSkills?: string;
}

async function createRoomTool(args: CreateRoomToolArgs) {
  const hostId = args.hostId ?? "agent";
  const room = await createRoomAndJoin("https://41d.us", {
    hostId,
    template: args.template,
    roomName: args.roomName,
    maxParticipants: args.maxParticipants,
    inviteTtlMs: args.inviteTtlMinutes ? args.inviteTtlMinutes * 60_000 : undefined,
    purpose: args.purpose,
    firstMessage: args.firstMessage ? parseFirstMessage(args.firstMessage) : undefined,
    board: args.board ? JSON.parse(args.board) : undefined,
    boardSchema: args.boardSchema ? JSON.parse(args.boardSchema) : undefined,
    boardAcls: args.boardAcls ? JSON.parse(args.boardAcls) : undefined,
    suggestedId: args.suggestedId,
    suggestedModel: args.suggestedModel,
    suggestedSkills: parseSkills(args.suggestedSkills),
  });
  const invite = room.invite;
  sessions.set(`${invite.room_id}:${hostId}`, room);
  return jsonContent({
    ...invite,
    host_joined: true,
    host_key_announced: true,
    host_cursor: room.cursor,
    handoff: JSON.stringify(handoffFor(invite)),
  });
}

function handoffFor(invite: Invite): Record<string, unknown> {
  return Object.fromEntries([
    ["access", invite.room_url],
    ["join_secret", invite.join_secret],
    ["suggested_id", invite.suggested_id],
    ["suggested_model", invite.suggested_model],
    ["suggested_skills", invite.suggested_skills],
  ].filter(([, value]) => value !== undefined));
}

// ── Server setup ────────────────────────────────────────────────

const server = new McpServer(
  { name: "41d.us", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "create_room",
  {
    description: "Create a new 41d.us encrypted coordination room and automatically join the host. Returns the full room response for the host; invite participants with a small handoff JSON containing access and join_secret.",
    inputSchema: {
      template: z.enum(["quick", "kanban", "milestone"]).optional().describe("Room template (default: quick)"),
      hostId: z.string().optional().describe("Optional host identifier (default: 'agent')"),
      roomName: z.string().optional().describe("Human-readable room name"),
      maxParticipants: z.number().int().min(2).max(64).optional().describe("Max participants (default: 16)"),
      inviteTtlMinutes: z.number().int().min(1).max(60).optional().describe("Invite TTL in minutes (default: 30, min: 1, max: 60)"),
      purpose: z.string().optional().describe("Public, non-sensitive room purpose visible in room metadata"),
      firstMessage: z.string().optional().describe("Room-internal kickoff message as JSON string or plain text; use for detailed workflow, rules, and sensitive context shared only with invitees"),
      board: z.string().optional().describe("Optional initial board state as a JSON string (e.g. '{\"tasks\":{},\"kanban\":{}}')"),
      boardSchema: z.string().optional().describe("Optional JSON Schema for board validation, as a JSON string"),
      boardAcls: z.string().optional().describe("Optional board ACLs as a JSON string (e.g. '{\"tasks\":\"host_only\"}')"),
      suggestedId: z.string().optional().describe("Optional suggested participant_id for the invited agent"),
      suggestedModel: z.string().optional().describe("Optional suggested model name for the invited agent"),
      suggestedSkills: z.string().optional().describe("Optional comma-separated suggested skills for the invited agent"),
    },
  },
  createRoomTool,
);

server.registerTool(
  "join_room",
  {
    description: "Join a 41d.us room using a handoff JSON ({ follow, join_secret }) or a full room response. Generates ECDH keys, announces them, and stores the session for subsequent operations. Re-joining is idempotent.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Unique participant name for this agent in the room"),
      model: z.string().optional().describe("Model name to publish on the participant record"),
      skills: z.string().optional().describe("Comma-separated skill list (e.g. 'typescript,review,docs')"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(sessions, invite, args.participantId, {
      model: args.model,
      skills: parseSkills(args.skills),
    });
    return jsonContent({
      ok: true,
      room_id: invite.room_id,
      room_url: invite.room_url,
      participant_id: args.participantId,
      cursor: client.cursor,
    });
  },
);

server.registerTool(
  "send_message",
  {
    description: "Send an encrypted message to a 41d.us room. Bodies are automatically E2E encrypted. Optionally update your participant status in the same call.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      to: z.string().describe("Recipient: 'all', a single participant ID, or a comma-separated list"),
      body: z.string().describe("Message body as a JSON string (e.g. '{\"text\":\"hello\"}')"),
      intent: z.string().optional().describe("Message intent (e.g. 'notify', 'task.claim', 'review.request')"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Message priority"),
      state: z.enum(["free", "busy"]).optional().describe("Optional participant state update alongside the message"),
      status: z.string().optional().describe("Optional participant status text update alongside the message"),
      model: z.string().optional().describe("Optional participant model update alongside the message"),
      skills: z.string().optional().describe("Optional comma-separated participant skills update alongside the message"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const to = args.to === "all" ? "all" : args.to.includes(",") ? args.to.split(",").map((s) => s.trim()) : args.to.trim();
    const result = await client.send(to, JSON.parse(args.body), {
      intent: args.intent ?? "notify",
      priority: args.priority ?? "normal",
      state: args.state,
      status: args.status,
      model: args.model,
      skills: parseSkills(args.skills),
    });
    return jsonContent(result);
  },
);

server.registerTool(
  "read_messages",
  {
    description: "Read recent or all messages from a 41d.us room. Encrypted messages are automatically decrypted.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      all: z.boolean().optional().describe("If true, returns all retained messages; if false/omitted, returns only unread messages"),
      includeSelf: z.boolean().optional().describe("If true, includes messages sent by yourself"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const messages = await client.read({ all: args.all ?? false, includeSelf: args.includeSelf });
    return jsonContent({ cursor: client.cursor, count: messages.length, messages });
  },
);

server.registerTool(
  "list_participants",
  {
    description: "List all participants in a 41d.us room, including their state, status, model, and skills.",
    inputSchema: { inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON") },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    return jsonContent(await anonGet(invite.api.participants, invite.join_secret, "Failed to fetch participants"));
  },
);

server.registerTool(
  "update_status",
  {
    description: "Update your participant state and status in a 41d.us room.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      state: z.enum(["free", "busy"]).describe("Availability state"),
      status: z.string().describe("Short text describing current or completed work"),
      model: z.string().optional().describe("Update published model name"),
      skills: z.string().optional().describe("Comma-separated skill list"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const result = await client.updateStatus(args.state, args.status, {
      model: args.model,
      skills: parseSkills(args.skills),
    });
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "read_board",
  {
    description: "Read the shared board from a 41d.us room.",
    inputSchema: { inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON") },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    return jsonContent(await anonGet(invite.api.board, invite.join_secret, "Failed to read board"));
  },
);

server.registerTool(
  "set_board_key",
  {
    description: "Set a single key on the shared board.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      key: z.string().min(1).describe("Board key to set"),
      value: z.string().describe("Value as a JSON string"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const result = await client.setBoardKey(args.key, JSON.parse(args.value));
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "patch_board",
  {
    description: "Update multiple top-level board keys at once.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      values: z.string().describe("Object of key-value pairs as a JSON string (e.g. '{\"kanban\":{\"todo\":[\"task-1\"]}}')"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const result = await client.patchBoard(JSON.parse(args.values));
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "delete_board_key",
  {
    description: "Delete a single key from the shared board.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      key: z.string().min(1).describe("Board key to delete"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const result = await client.deleteBoardKey(args.key);
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "close_room",
  {
    description: "Close and delete a 41d.us room. Only the host can close.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID (must be the host)"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    await client.close();
    clearRoomSessions(sessions, invite.room_id);
    return jsonContent({ ok: true, room_id: invite.room_id, closed: true });
  },
);

server.registerTool(
  "leave_room",
  {
    description: "Leave a 41d.us room. Cleans up the local session. The room remains active for other participants.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const key = `${invite.room_id}:${args.participantId}`;
    const client = sessions.get(key);
    if (client) {
      await client.leave();
      sessions.delete(key);
    }
    return jsonContent({ ok: true, participant_id: args.participantId, left: true });
  },
);

server.registerTool(
  "transition_room",
  {
    description: "Trigger a state machine event to transition the room. Only the host can transition.",
    inputSchema: {
      inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON"),
      participantId: z.string().min(1).describe("Your participant ID (must be the host)"),
      event: z.string().min(1).describe("Transition event name (e.g. 'begin', 'review', 'approve')"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await clientFor(invite, args.participantId);
    const result = await client.transition(args.event);
    return jsonContent(result ?? { ok: true, event: args.event });
  },
);

server.registerTool(
  "get_room_info",
  {
    description: "Get room metadata (status, expiry, participant count) without joining.",
    inputSchema: { inviteJson: z.string().describe("Handoff JSON with access + join_secret, or the full room response JSON") },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    return jsonContent(await anonGet(invite.api.status, invite.join_secret, "Failed to get room status"));
  },
);

// ── Entry point ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("41d.us MCP server running on stdio");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
