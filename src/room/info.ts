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
    cursor,
    message: "Joined. Read recent messages with GET room_url, read retained history with GET room_url?view=all, and send with POST room_url.",
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
