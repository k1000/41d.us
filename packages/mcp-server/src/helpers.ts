import type { Invite, RoomClient } from "@41d/sdk";
import { getOrCreateSession } from "@41d/sdk/session";

// ── Session store ───────────────────────────────────────────────

/** Key: `${roomId}:${participantId}` → RoomClient */
export const sessions = new Map<string, RoomClient>();

// ── Parsing helpers ─────────────────────────────────────────────

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

export async function anonGet(url: string, secret: string, label: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  if (!response.ok) throw new Error(`${label}: ${response.status} ${await response.text()}`);
  return response.json();
}

export function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function clientFor(invite: Invite, participantId: string): Promise<RoomClient> {
  return getOrCreateSession(sessions, invite, participantId);
}
