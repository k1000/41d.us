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
    events: string;
    participants: string;
    status: string;
    leave: string;
    kick: string;
    close: string;
  };
  skill: string;
  expires_at: string;
}

export interface CreateInviteOptions {
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  purpose?: string;
}

export interface RoomClient {
  invite: Invite;
  participantId: string;
  cursor: number;
  send(to: Recipient, body: unknown, options?: { replyTo?: string | null; intent?: string; priority?: string }): Promise<{ ok: true; id: string; seq: number }>;
  read(options?: { includeSelf?: boolean }): Promise<RoomMessage[]>;
  participants(): Promise<unknown>;
  status(): Promise<unknown>;
  leave(): Promise<void>;
  kick(targetId: string): Promise<unknown>;
  close(): Promise<unknown>;
}

export async function createInvite(baseUrl = "https://41d.us", options: CreateInviteOptions = {}): Promise<Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host_id: options.hostId,
      room_name: options.roomName,
      max_participants: options.maxParticipants,
      purpose: options.purpose,
    }),
  });
  if (!response.ok) throw new Error(`failed to create invite: ${response.status}`);
  return (await response.json()) as Invite;
}

export async function joinRoom(invite: Invite, participantId: string): Promise<RoomClient> {
  const join = await request<{ ok: true; cursor: number }>(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, { method: "PUT" });
  let cursor = join.cursor;
  return {
    invite,
    participantId,
    cursor,
    async send(to, body, options = {}) {
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: {
          to,
          body,
          reply_to: options.replyTo ?? null,
          intent: options.intent ?? "notify",
          priority: options.priority ?? "normal",
        },
      });
    },
    async read(options = {}) {
      const url = new URL(invite.room_url);
      url.searchParams.set("after", String(cursor));
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      const result = await request<{ cursor: number; messages: RoomMessage[] }>(url.toString(), invite, { participantId });
      cursor = result.cursor;
      return result.messages;
    },
    async participants() {
      return request(invite.api.participants, invite);
    },
    async status() {
      return request(invite.api.status, invite);
    },
    async leave() {
      await request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, { method: "DELETE" });
    },
    async kick(targetId: string) {
      return request(`${invite.room_url}/participants/${encodeURIComponent(targetId)}`, invite, { method: "DELETE", participantId });
    },
    async close() {
      return request(invite.room_url, invite, { method: "DELETE", participantId });
    },
  };
}

async function request<T>(url: string, invite: Invite, options: { method?: string; participantId?: string; body?: Record<string, unknown> } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${invite.join_secret}` };
  if (options.participantId) headers["x-participant-id"] = options.participantId;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}
