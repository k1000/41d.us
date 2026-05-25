export { RoomApiError } from "./errors";
export { buildRoomClient } from "./room-client";

import { buildRoomClient } from "./room-client";
import type { Invite, RoomClient, CreateRoomOptions } from "./room-client";
import { request } from "./transport";

export type { Invite, RoomClient, CreateRoomOptions };

type RoomAccess = Partial<Invite> & {
  access?: string;
  follow?: string;
  join_secret?: string;
};

function buildApiLinks(roomUrl: string): Invite["api"] {
  return {
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: roomUrl,
    read_all: `${roomUrl}/?view=all`,
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

export function buildMinimalInvite(roomUrlRaw: string, joinSecret: string): Invite {
  const roomUrl = roomUrlRaw.replace(/\/$/, "");
  const roomId = roomUrl.split("/").pop() ?? "";
  const origin = new URL(roomUrl).origin;
  return {
    intro: "",
    next_step: "",
    room_id: roomId,
    room: { name: "", purpose: "", host_id: "", max_participants: 16 },
    join_secret: joinSecret,
    room_url: roomUrl,
    api: buildApiLinks(roomUrl),
    skill: `${origin}/skill/SKILL.md`,
    expires_at: "",
  };
}

export function normalizeInvite(invite: RoomAccess): Invite {
  const roomUrl = invite.room_url ?? invite.access ?? invite.follow;
  if (!roomUrl || !invite.join_secret) throw new Error("invite must include access (or room_url) and join_secret");
  return invite.room_id && invite.api
    ? { ...invite, room_url: roomUrl, join_secret: invite.join_secret } as Invite
    : buildMinimalInvite(roomUrl, invite.join_secret);
}

export async function createRoom(
  baseUrl = "https://41d.us",
  options: CreateRoomOptions,
): Promise<Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      room_id: options.roomId,
      host_id: options.hostId,
      room_name: options.roomName,
      max_participants: options.maxParticipants,
      invite_ttl_ms: options.inviteTtlMs,
      purpose: options.purpose,
      first_message: options.firstMessage,
      board_schema: options.boardSchema,
      board: options.board,
    }),
  });
  if (!response.ok) throw new Error(`failed to create room: ${response.status}`);
  return normalizeInvite(await response.json() as RoomAccess);
}

export async function createRoomAndJoin(
  baseUrl = "https://41d.us",
  options: CreateRoomOptions,
  joinOptions: { model?: string; skills?: string[] } = {},
): Promise<RoomClient> {
  const invite = await createRoom(baseUrl, options);
  return joinRoom(invite, options.hostId ?? (invite.room.host_id || "agent"), joinOptions);
}

export async function joinRoom(
  inviteInput: RoomAccess,
  participantId: string,
  opts: { model?: string; skills?: string[] } = {},
): Promise<RoomClient> {
  const invite = normalizeInvite(inviteInput);
  const join = await request<{ ok: true; cursor: number }>(
    `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
    invite,
    { method: "PUT", body: Object.keys(opts).length ? opts : undefined },
  );
  const room = await buildRoomClient(invite, participantId, join.cursor);
  await room.announceKey();
  return room;
}

export async function resumeRoom(
  invite: RoomAccess,
  participantId: string,
): Promise<RoomClient> {
  return buildRoomClient(normalizeInvite(invite), participantId, 0);
}
