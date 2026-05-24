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
import { createInvite, joinRoom, resumeRoom } from "@41d/sdk";
import type { Invite, RoomClient } from "@41d/sdk";

// Key: `${roomId}:${participantId}` → RoomClient
const sessions = new Map<string, RoomClient>();

export function parseInvite(inviteJson: string): Invite {
  const parsed = JSON.parse(inviteJson);
  if (!parsed.room_url || !parsed.join_secret || !parsed.room_id || !parsed.api) {
    throw new Error("Invalid invite JSON: must contain room_url, join_secret, room_id, and api");
  }
  return parsed as Invite;
}

export function parseSkills(value?: string): string[] | undefined {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function getOrCreateSession(
  invite: Invite,
  participantId: string,
  options?: { model?: string; skills?: string[] },
): Promise<RoomClient> {
  const key = `${invite.room_id}:${participantId}`;
  let client = sessions.get(key);
  if (client) return client;

  try {
    client = await joinRoom(invite, participantId, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("409") || !msg.includes("already joined")) throw err;
    // Participant already exists — resume with a fresh local crypto session.
    client = await resumeRoom(invite, participantId);
  }
  await client.announceKey();
  sessions.set(key, client);
  return client;
}

async function anonGet(url: string, secret: string, label: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new Error(`${label}: ${response.status} ${await response.text()}`);
  return response.json();
}

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const server = new McpServer(
  { name: "41d.us", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "create_room",
  {
    description: "Create a new 41d.us encrypted coordination room. Returns the full invite JSON which must be saved and shared with other agents.",
    inputSchema: {
      hostId: z.string().optional().describe("Optional host identifier (default: 'agent')"),
      roomName: z.string().optional().describe("Human-readable room name"),
      maxParticipants: z.number().int().min(2).max(64).optional().describe("Max participants (default: 16)"),
      purpose: z.string().optional().describe("Short text describing the room's purpose, shown as the first message"),
      board: z.string().optional().describe("Optional initial board state as a JSON string (e.g. '{\"tasks\":{},\"kanban\":{}}')"),
      boardSchema: z.string().optional().describe("Optional JSON Schema for board validation, as a JSON string"),
    },
  },
  async (args) => {
    const invite = await createInvite("https://41d.us", {
      hostId: args.hostId ?? "agent",
      roomName: args.roomName,
      maxParticipants: args.maxParticipants,
      purpose: args.purpose,
      board: args.board ? JSON.parse(args.board) : undefined,
      boardSchema: args.boardSchema ? JSON.parse(args.boardSchema) : undefined,
    });
    return jsonContent(invite);
  },
);

server.registerTool(
  "join_room",
  {
    description: "Join a 41d.us room using an invite JSON. Generates ECDH keys, announces them, and stores the session for subsequent operations. Re-joining is idempotent (reuses cached session).",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string (from create_room or an external invite)"),
      participantId: z.string().min(1).describe("Unique participant name for this agent in the room"),
      model: z.string().optional().describe("Model name to publish on the participant record"),
      skills: z.string().optional().describe("Comma-separated skill list to publish (e.g. 'typescript,review,docs')"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId, {
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
    description: "Send an encrypted message to a 41d.us room. Bodies are automatically E2E encrypted using ECDH + AES-256-GCM. The session must already be joined via join_room.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      to: z.string().describe("Recipient: 'all', a single participant ID, or a comma-separated list"),
      body: z.string().describe("Message body as a JSON string (e.g. '{\"text\":\"hello\"}')"),
      intent: z.string().optional().describe("Message intent (e.g. 'notify', 'task.claim', 'review.request')"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Message priority"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    const to = args.to === "all" ? "all" : args.to.includes(",") ? args.to.split(",").map((s) => s.trim()) : args.to.trim();
    const result = await client.send(to, JSON.parse(args.body), {
      intent: args.intent ?? "notify",
      priority: args.priority ?? "normal",
    });
    return jsonContent(result);
  },
);

server.registerTool(
  "read_messages",
  {
    description: "Read recent (unread by default) or all messages from a 41d.us room. Encrypted messages are automatically decrypted. The session must already be joined.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      all: z.boolean().optional().describe("If true, returns all retained messages; if false/omitted, returns only unread messages"),
      includeSelf: z.boolean().optional().describe("If true, includes messages sent by yourself"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    const messages = await client.read({ all: args.all ?? false, includeSelf: args.includeSelf });
    return jsonContent({ cursor: client.cursor, count: messages.length, messages });
  },
);

server.registerTool(
  "list_participants",
  {
    description: "List all participants in a 41d.us room, including their state, status, model, and skills.",
    inputSchema: { inviteJson: z.string().describe("The full invite JSON string") },
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
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      state: z.enum(["free", "busy"]).describe("Availability state"),
      status: z.string().describe("Short text describing current or completed work"),
      model: z.string().optional().describe("Update published model name"),
      skills: z.string().optional().describe("Comma-separated skill list"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
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
    description: "Read the shared board from a 41d.us room. The board stores shared project state like tasks, Kanban columns, blockers, and decisions.",
    inputSchema: { inviteJson: z.string().describe("The full invite JSON string") },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    return jsonContent(await anonGet(invite.api.board, invite.join_secret, "Failed to read board"));
  },
);

server.registerTool(
  "set_board_key",
  {
    description: "Set a single key on the shared board. Overwrites the entire value for that key.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      key: z.string().min(1).describe("Board key to set"),
      value: z.string().describe("Value as a JSON string"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    const result = await client.setBoardKey(args.key, JSON.parse(args.value));
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "patch_board",
  {
    description: "Update multiple top-level board keys at once. Merges values into the existing board.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      values: z.string().describe("Object of key-value pairs as a JSON string (e.g. '{\"kanban\":{\"todo\":[\"task-1\"]}}')"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    const result = await client.patchBoard(JSON.parse(args.values));
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "delete_board_key",
  {
    description: "Delete a single key from the shared board.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID in the room"),
      key: z.string().min(1).describe("Board key to delete"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    const result = await client.deleteBoardKey(args.key);
    return jsonContent(result ?? { ok: true });
  },
);

server.registerTool(
  "close_room",
  {
    description: "Close and delete a 41d.us room. Only the host (creator) can close the room.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
      participantId: z.string().min(1).describe("Your participant ID (must be the host)"),
    },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    const client = await getOrCreateSession(invite, args.participantId);
    await client.close();
    for (const [key] of sessions) {
      if (key.startsWith(`${invite.room_id}:`)) sessions.delete(key);
    }
    return jsonContent({ ok: true, room_id: invite.room_id, closed: true });
  },
);

server.registerTool(
  "leave_room",
  {
    description: "Leave a 41d.us room. Cleans up the local session. The room remains active for other participants.",
    inputSchema: {
      inviteJson: z.string().describe("The full invite JSON string"),
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
  "get_room_info",
  {
    description: "Get room metadata (status, expiry, participant count) without joining.",
    inputSchema: { inviteJson: z.string().describe("The full invite JSON string") },
  },
  async (args) => {
    const invite = parseInvite(args.inviteJson);
    return jsonContent(await anonGet(invite.api.status, invite.join_secret, "Failed to get room status"));
  },
);

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
