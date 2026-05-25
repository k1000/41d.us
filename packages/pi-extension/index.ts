import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRoom } from "@41d/sdk";
import { getOrCreateSession } from "@41d/sdk/session";
import type { Invite, RoomClient } from "@41d/sdk";

// ── Session cache ──────────────────────────────────────────────

const sessions = new Map<string, RoomClient>();

// ── Invite loading ──────────────────────────────────────────────

function loadInviteFromArg(ref: string): Invite {
  const text = ref.trim().startsWith("{")
    ? ref
    : readFileSync(ref, "utf8");
  const invite = JSON.parse(text) as Invite;
  if (!invite.room_url || !invite.join_secret || !invite.room_id || !invite.api) {
    throw new Error("invalid invite: must contain room_url, join_secret, room_id, and api");
  }
  return invite;
}

interface ParsedArgs {
  cmd: string;
  roomUrlOrInvite?: string;
  joinSecret?: string;
  me?: string;
  rest: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const cmd = args[0];
  if (!cmd) return { cmd: "", rest: args };

  // env-based: single env-friendly commands like `send all '{"text":"hello"}'`
  const envReady = !!(process.env.ROOM_URL && process.env.JOIN_SECRET && process.env.ME);
  const isEnvShape =
    (cmd === "send" && args.length <= 3) ||
    (["join", "read", "inbox", "doctor"].includes(cmd) && args.length === 1);
  if (envReady && isEnvShape) {
    return {
      cmd,
      roomUrlOrInvite: process.env.ROOM_URL,
      joinSecret: process.env.JOIN_SECRET,
      me: process.env.ME,
      rest: args.slice(1),
    };
  }

  // room-url form: cmd room_url join_secret me [rest...]
  if (args[1] && /^https?:/.test(args[1])) {
    return { cmd, roomUrlOrInvite: args[1], joinSecret: args[2], me: args[3], rest: args.slice(4) };
  }

  // invite-file form: cmd inviteRef me [rest...] or cmd inviteRef (for send where to/body follow)
  if (args[1]) {
    return { cmd, roomUrlOrInvite: args[1], joinSecret: undefined, me: args[2], rest: args.slice(3) };
  }

  return { cmd, rest: args.slice(1) };
}

function resolveInvite(parsed: ParsedArgs): Invite {
  if (parsed.roomUrlOrInvite && parsed.joinSecret && parsed.me) {
    // room-url form: we need to construct a minimal invite. For create, no invite needed.
    if (parsed.cmd === "create") throw new Error("create does not use room-url form");
    // Construct a minimal invite from room-url + join-secret
    const roomUrl = parsed.roomUrlOrInvite.replace(/\/$/, "");
    const roomId = roomUrl.split("/").pop() ?? "";
    const origin = new URL(roomUrl).origin;
    return {
      intro: "",
      next_step: "",
      room_id: roomId,
      room: { name: "", purpose: "", host_id: "", max_participants: 16 },
      join_secret: parsed.joinSecret,
      room_url: roomUrl,
      api: {
        join: `${roomUrl}/participants/{participant_id}`,
        send: roomUrl,
        read: roomUrl,
        read_all: `${origin}/r/${roomId}/?view=all`,
        events: `${roomUrl}/events`,
        board: `${roomUrl}/board`,
        participants: `${roomUrl}/participants`,
        status: `${roomUrl}/status`,
        export: `${roomUrl}/export`,
        leave: `${roomUrl}/participants/{participant_id}`,
        kick: `${roomUrl}/participants/{target_id}`,
        close: roomUrl,
      },
      skill: `${origin}/skill/SKILL.md`,
      expires_at: "",
    };
  }
  // invite-file or inline-JSON form
  if (parsed.roomUrlOrInvite) {
    return loadInviteFromArg(parsed.roomUrlOrInvite);
  }
  throw new Error("missing invite reference. Provide room_url + join_secret + me, an invite file, or inline JSON.");
}

// ── Command handlers ───────────────────────────────────────────

async function handleCreate(parsed: ParsedArgs): Promise<string> {
  const baseUrl = (parsed.roomUrlOrInvite || process.env.BASE_URL || "https://41d.us").replace(/\/$/, "");
  const options = parsed.rest[0] ? JSON.parse(parsed.rest[0]) : {};
  const invite = await createRoom(baseUrl, {
    hostId: options.host_id,
    roomName: options.room_name,
    maxParticipants: options.max_participants,
    inviteTtlMs: options.invite_ttl_ms,
    purpose: options.purpose,
    board: options.board ? JSON.parse(options.board) : undefined,
    boardSchema: options.board_schema ? JSON.parse(options.board_schema) : undefined,
  });
  return JSON.stringify(invite, null, 2);
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
  const to = toRaw === "all" ? "all" : toRaw.includes(",") ? toRaw.split(",").map((s) => s.trim()) : toRaw.trim();

  const result = await client.send(to, JSON.parse(bodyJson));
  return JSON.stringify(result, null, 2);
}

async function handleDoctor(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("doctor needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await getOrCreateSession(sessions, invite, parsed.me);

  const participants = await client.participants();
  const joined = participants.participants.some((p) => p.id === parsed.me);
  const messages = await client.read({ all: true, includeSelf: true });
  // After SDK decryption, a body still carrying `encrypted: true` means we couldn't decrypt it.
  const undecrypted = messages.filter((m) => {
    const body = m.body as Record<string, unknown> | null;
    return body !== null && typeof body === "object" && body.encrypted === true;
  }).length;

  return JSON.stringify({
    ok: joined,
    participant_id: parsed.me,
    joined,
    cursor: client.cursor,
    room_id: invite.room_id,
    known_peers: messages
      .filter((m) => m.intent === "key.exchange" && m.from !== parsed.me)
      .map((m) => m.from),
    encrypted_messages_undecrypted: undecrypted,
  }, null, 2);
}

// ── Main dispatcher ────────────────────────────────────────────

async function run41d(args: string[]): Promise<string> {
  const parsed = parseArgs(args);
  const cmd = parsed.cmd;

  switch (cmd) {
    case "create":
      return handleCreate(parsed);
    case "join":
      return handleJoin(parsed);
    case "send":
      return handleSend(parsed);
    case "read":
    case "inbox": {
      if (!parsed.me) throw new Error("read needs: participant_id");
      const invite = resolveInvite(parsed);
      const client = await getOrCreateSession(sessions, invite, parsed.me);
      const messages = await client.read({ all: cmd === "inbox", includeSelf: true });
      return JSON.stringify(messages, null, 2);
    }
    case "doctor":
      return handleDoctor(parsed);
    default:
      throw new Error(`unknown command: ${cmd}. Usage: create|join|send|read|inbox|doctor`);
  }
}

// ── Extension registration ─────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("41d", {
    description: "41d.us encrypted room helper: create, join, doctor, send, read",
    handler: async (args, ctx) => {
      const argv = splitArgs(args || "");
      if (argv.length === 0) {
        ctx.ui.notify("Usage: /41d <create|join|doctor|send|read> ...", "info");
        return;
      }
      try {
        const output = await run41d(argv);
        ctx.ui.notify(output.slice(0, 4000), "info");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`41d error: ${msg}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "41d",
    label: "41d.us",
    description: "Use the 41d.us encrypted room helper. Args match /client/41d.js, e.g. ['read','docs-review.json','agent-b'] or ['send','docs-review.json','agent-b','all','{\"text\":\"hello\"}'].",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: "Arguments for 41d.js: create|join|doctor|send|read ..." }),
    }),
    async execute(_toolCallId, params) {
      try {
        const output = await run41d(params.args);
        return {
          content: [{ type: "text", text: output }],
          details: { args: params.args },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  });
}

// ── Arg parsing helpers ────────────────────────────────────────

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    args.push(unescapeArg(match[1] ?? match[2] ?? match[3] ?? ""));
  }
  return args;
}

function unescapeArg(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1");
}
