import type { InviteState } from "../types";
import { activeParticipants } from "./participants";

export function roomInfo(invite: InviteState) {
  return {
    room_id: invite.roomId,
    name: invite.roomName,
    host_id: invite.hostId,
    max_participants: invite.maxParticipants,
  };
}

export function joinResponse(invite: InviteState, participantId: string, cursor: number) {
  return {
    ok: true,
    room: roomInfo(invite),
    participant_id: participantId,
    is_host: participantId === invite.hostId,
    host_id: invite.hostId,
    cursor,
    next: {
      announce_key: "Send a POST with intent=key.exchange and your ECDH public_key to announce your encryption key.",
      sync: "Call GET room_url (or room.read()) to learn peer keys and fetch messages. The helper/SDK does this for you.",
      send: "Use the encrypted helper or SDK to send E2E encrypted messages (AES-256-GCM).",
    },
    message: `Joined room "${invite.roomName}" as ${participantId}. Host is ${invite.hostId}. Announce your encryption key, sync to learn peer keys, then send encrypted messages.`,
  };
}

export function roomStatus(invite: InviteState) {
  return {
    room: roomInfo(invite),
    participants: activeParticipants(invite.participants),
    message_count: invite.messages.length,
    last_seq: invite.nextSeq,
    oldest_seq: invite.messages[0]?.seq ?? 0,
    expires_at: new Date(invite.expiresAt).toISOString(),
  };
}

export function roomExport(invite: InviteState) {
  return {
    room: roomInfo(invite),
    phase: invite.phase,
    participants: invite.participants,
    messages: invite.messages,
    board: invite.board,
    board_schema: invite.boardSchema ?? null,
    next_seq: invite.nextSeq,
    expires_at: new Date(invite.expiresAt).toISOString(),
  };
}
