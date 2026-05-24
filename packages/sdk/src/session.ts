import { joinRoom, resumeRoom } from "./sdk";
import type { Invite, RoomClient } from "./sdk";

/** Build a deterministic session cache key from room and participant IDs. */
export function sessionKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

/**
 * Get or create a RoomClient session. Caches by room + participant.
 *
 * If the participant already exists on the server (HTTP 409), the function
 * falls back to {@link resumeRoom} and announces the local key again.
 *
 * @param sessions - The consumer-owned session cache map.
 * @param invite - The room invite.
 * @param participantId - Unique participant identifier.
 * @param options - Optional model/skills to publish on initial join.
 */
export async function getOrCreateSession(
  sessions: Map<string, RoomClient>,
  invite: Invite,
  participantId: string,
  options?: { model?: string; skills?: string[] },
): Promise<RoomClient> {
  const key = sessionKey(invite.room_id, participantId);
  let client = sessions.get(key);
  if (client) return client;

  try {
    client = await joinRoom(invite, participantId, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Any 409 — already joined, room full, etc. — try resuming.
    if (!msg.includes("409") && !msg.includes("already joined")) throw err;
    client = await resumeRoom(invite, participantId);
    await client.announceKey();
  }
  sessions.set(key, client);
  return client;
}

export function clearRoomSessions(
  sessions: Map<string, RoomClient>,
  roomId: string,
): void {
  for (const [key] of sessions) {
    if (key.startsWith(`${roomId}:`)) sessions.delete(key);
  }
}
