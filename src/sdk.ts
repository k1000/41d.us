import type { Recipient, RoomMessage } from "./types";

export interface Invite {
  intro: string;
  next_step: string;
  invite_id: string;
  room: { name: string; host_id: string; max_participants: number };
  join_secret: string;
  room_url: string;
  api: {
    join: string;
    send: string;
    read: string;
    participants: string;
    leave: string;
    kick: string;
  };
  skill: string;
  expires_at: string;
}

export interface CreateInviteOptions {
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
}

export interface RoomClient {
  invite: Invite;
  participantId: string;
  cursor: number;
  send(to: Recipient, body: unknown, options?: { replyTo?: string | null; intent?: string; priority?: string }): Promise<{ ok: true; id: string; seq: number }>;
  read(options?: { includeSelf?: boolean }): Promise<RoomMessage[]>;
  participants(): Promise<unknown>;
  leave(): Promise<void>;
  kick(targetId: string): Promise<unknown>;
}

export async function createInvite(baseUrl = "https://41d.us", options: CreateInviteOptions = {}): Promise<Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host_id: options.hostId,
      room_name: options.roomName,
      max_participants: options.maxParticipants,
    }),
  });
  if (!response.ok) throw new Error(`failed to create invite: ${response.status}`);
  return (await response.json()) as Invite;
}

export async function joinRoom(invite: Invite, participantId: string): Promise<RoomClient> {
  const join = await post<{ ok: true; cursor: number }>(invite.api.join, invite, { participant_id: participantId });
  let cursor = join.cursor;
  return {
    invite,
    participantId,
    cursor,
    async send(to, body, options = {}) {
      return post(invite.api.send, invite, {
        participant_id: participantId,
        to,
        body,
        reply_to: options.replyTo ?? null,
        intent: options.intent ?? "notify",
        priority: options.priority ?? "normal",
      });
    },
    async read(options = {}) {
      const result = await post<{ cursor: number; messages: RoomMessage[] }>(invite.api.read, invite, {
        participant_id: participantId,
        after: cursor,
        include_self: options.includeSelf ?? false,
      });
      cursor = result.cursor;
      return result.messages;
    },
    async participants() {
      return post(invite.api.participants, invite, {});
    },
    async leave() {
      await post(invite.api.leave, invite, { participant_id: participantId });
    },
    async kick(targetId: string) {
      return post(invite.api.kick, invite, { participant_id: participantId, target_id: targetId });
    },
  };
}

async function post<T>(url: string, invite: Invite, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ join_secret: invite.join_secret, ...body }),
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
