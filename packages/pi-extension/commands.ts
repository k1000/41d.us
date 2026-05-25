import { readFileSync } from "node:fs";
import { buildMinimalInvite, createRoom, normalizeInvite } from "@41d/sdk";
import { getOrCreateSession } from "@41d/sdk/session";
import type { Invite, RoomClient } from "@41d/sdk";
import { parseArgs, type ParsedArgs } from "./args";

const sessions = new Map<string, RoomClient>();

function loadInviteFromArg(ref: string): Invite {
  const text = ref.trim().startsWith("{") ? ref : readFileSync(ref, "utf8");
  return normalizeInvite(JSON.parse(text));
}

function resolveInvite(parsed: ParsedArgs): Invite {
  if (isRoomUrlForm(parsed)) return buildMinimalInvite(parsed.roomUrlOrInvite, parsed.joinSecret);
  if (parsed.roomUrlOrInvite) return loadInviteFromArg(parsed.roomUrlOrInvite);
  throw new Error("missing invite reference. Provide room_url + join_secret + me, an invite file, or inline JSON.");
}

function isRoomUrlForm(parsed: ParsedArgs): parsed is ParsedArgs & { roomUrlOrInvite: string; joinSecret: string; me: string } {
  rejectCreateRoomUrlForm(parsed);
  return hasRoomUrlCredentials(parsed);
}

function rejectCreateRoomUrlForm(parsed: ParsedArgs): void {
  if (parsed.cmd === "create" && parsed.joinSecret) throw new Error("create does not use room-url form");
}

function hasRoomUrlCredentials(parsed: ParsedArgs): boolean {
  return !!(parsed.roomUrlOrInvite && parsed.joinSecret && parsed.me);
}

function parseOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

async function handleCreate(parsed: ParsedArgs): Promise<string> {
  const options = parsed.rest[0] ? JSON.parse(parsed.rest[0]) : {};
  const invite = await createRoom(createBaseUrl(parsed), {
    hostId: options.host_id,
    roomName: options.room_name,
    maxParticipants: options.max_participants,
    inviteTtlMs: options.invite_ttl_ms,
    purpose: options.purpose,
    board: parseOptionalObject(options.board),
    boardSchema: parseOptionalObject(options.board_schema),
  });
  return JSON.stringify(invite, null, 2);
}

function createBaseUrl(parsed: ParsedArgs): string {
  return (parsed.roomUrlOrInvite || process.env.BASE_URL || "https://41d.us").replace(/\/$/, "");
}

async function handleJoin(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("join needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await getOrCreateSession(sessions, invite, parsed.me);
  return JSON.stringify({
    ok: true,
    participant_id: parsed.me,
    room_id: invite.room_id,
    room_url: invite.room_url,
    cursor: client.cursor,
  }, null, 2);
}

async function handleSend(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("send needs: participant_id <to> <json_body>");
  const invite = resolveInvite(parsed);
  const client = await getOrCreateSession(sessions, invite, parsed.me);

  const [toRaw, bodyJson] = parsed.rest;
  if (!toRaw || !bodyJson) throw new Error('send needs: <to> <json_body> (e.g. all \'{"text":"hello"}\')');
  const result = await client.send(parseRecipient(toRaw), JSON.parse(bodyJson));
  return JSON.stringify(result, null, 2);
}

async function handleDoctor(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("doctor needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await getOrCreateSession(sessions, invite, parsed.me);

  const participants = await client.participants();
  const messages = await client.read({ all: true, includeSelf: true });
  return JSON.stringify({
    ok: participants.participants.some((p) => p.id === parsed.me),
    participant_id: parsed.me,
    joined: participants.participants.some((p) => p.id === parsed.me),
    cursor: client.cursor,
    room_id: invite.room_id,
    known_peers: knownPeers(messages, parsed.me),
    encrypted_messages_undecrypted: messages.filter(isUndecrypted).length,
  }, null, 2);
}

function parseRecipient(raw: string): "all" | string | string[] {
  if (raw === "all") return "all";
  return raw.includes(",") ? raw.split(",").map((s) => s.trim()) : raw.trim();
}

function knownPeers(messages: Awaited<ReturnType<RoomClient["read"]>>, me: string): string[] {
  return messages.filter((m) => m.intent === "key.exchange" && m.from !== me).map((m) => m.from);
}

function isUndecrypted(message: Awaited<ReturnType<RoomClient["read"]>>[number]): boolean {
  const body = message.body as Record<string, unknown> | null;
  return body !== null && typeof body === "object" && body.encrypted === true;
}

async function handleRead(parsed: ParsedArgs, all: boolean): Promise<string> {
  if (!parsed.me) throw new Error("read needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await getOrCreateSession(sessions, invite, parsed.me);
  const messages = await client.read({ all, includeSelf: true });
  return JSON.stringify(messages, null, 2);
}

const COMMANDS: Record<string, (parsed: ParsedArgs) => Promise<string>> = {
  create: handleCreate,
  join: handleJoin,
  send: handleSend,
  read: (parsed) => handleRead(parsed, false),
  inbox: (parsed) => handleRead(parsed, true),
  doctor: handleDoctor,
};

export async function run41d(args: string[]): Promise<string> {
  const parsed = parseArgs(args);
  const handler = COMMANDS[parsed.cmd];
  if (!handler) throw new Error(`unknown command: ${parsed.cmd}. Usage: create|join|send|read|inbox|doctor`);
  return handler(parsed);
}
