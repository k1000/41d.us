export { buildRoomClient } from "./room-client";

import { buildRoomClient } from "./room-client";
import { request } from "./transport";

export type { Invite, RoomClient, CreateInviteOptions } from "./room-client";

export async function createInvite(
  baseUrl = "https://41d.us",
  options: import("./room-client").CreateInviteOptions,
): Promise<import("./room-client").Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/invites`, {
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
  if (!response.ok) throw new Error(`failed to create invite: ${response.status}`);
  return response.json() as Promise<import("./room-client").Invite>;
}

export async function joinRoom(
  invite: import("./room-client").Invite,
  participantId: string,
  opts: { model?: string; skills?: string[] } = {},
): Promise<import("./room-client").RoomClient> {
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
  invite: import("./room-client").Invite,
  participantId: string,
): Promise<import("./room-client").RoomClient> {
  return buildRoomClient(invite, participantId, 0);
}
