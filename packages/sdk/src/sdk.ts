import { createSdkCryptoSession } from "./sdk-crypto-session";
import type { Recipient, RoomMessage } from "./types";

export interface Invite {
  intro: string;
  next_step: string;
  room_id: string;
  room: { name: string; host_id: string; max_participants: number };
  join_secret: string;
  room_url: string;
  board_schema?: Record<string, unknown> | null;
  api: {
    join: string;
    send: string;
    read: string;
    read_all: string;
    events: string;
    board: string;
    participants: string;
    status: string;
    leave: string;
    kick: string;
    close: string;
    export: string;
  };
  skill: string;
  expires_at: string;
}

export interface CreateInviteOptions {
  /** Optional host-proposed room id. If omitted, the server auto-generates one. */
  roomId?: string;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  /** Invite TTL in milliseconds (default: 600000 = 10 min, min: 60000 = 1 min, max: 3600000 = 1 hr). */
  inviteTtlMs?: number;
  /** Convenience: plain-text purpose string. Sends as `first_message: { text: ... }`. */
  purpose?: string;
  /** Raw first_message value (string or object). Overrides purpose. */
  firstMessage?: string | Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  board?: Record<string, unknown>;
}

export interface RoomClient {
  invite: Invite;
  participantId: string;
  cursor: number;

  /** Announce your ECDH public key to the room so others can encrypt to you. */
  announceKey(): Promise<void>;

  /**
   * Send a message. Bodies are automatically end-to-end encrypted using
   * ECDH key exchange + AES-256-GCM. Pass `plain: true` for key exchange
   * and other protocol messages that must be readable by all.
   */
  send(to: Recipient, body: unknown, options?: { replyTo?: string | null; intent?: string; priority?: string; plain?: boolean }): Promise<{ ok: true; id: string; seq: number }>;

  /**
   * Read recent messages. The server tracks each participant's read marker.
   * Encrypted messages are automatically decrypted. Key exchange messages are
   * processed to build the peer key directory.
   */
  read(options?: { includeSelf?: boolean; all?: boolean }): Promise<RoomMessage[]>;

  participants(): Promise<unknown>;
  updateStatus(state: "free" | "busy", status: string, options?: { model?: string; skills?: string[] }): Promise<unknown>;
  board(): Promise<unknown>;
  setBoardKey(key: string, value: unknown): Promise<unknown>;
  patchBoard(values: Record<string, unknown>): Promise<unknown>;
  deleteBoardKey(key: string): Promise<unknown>;
  status(): Promise<unknown>;
  leave(): Promise<void>;
  kick(targetId: string): Promise<unknown>;
  close(): Promise<unknown>;
  /** Export the full room state (messages, participants, board). Host only. */
  export(): Promise<unknown>;
}

async function request<T>(url: string, invite: Invite, options: { method?: string; participantId?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${invite.join_secret}` };
  if (options.participantId) headers["x-participant-id"] = options.participantId;
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function createInvite(baseUrl = "https://41d.us", options: CreateInviteOptions = {}): Promise<Invite> {
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
  return (await response.json()) as Invite;
}

export async function joinRoom(invite: Invite, participantId: string, options: { model?: string; skills?: string[] } = {}): Promise<RoomClient> {
  const join = await request<{ ok: true; cursor: number }>(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, { method: "PUT", body: Object.keys(options).length ? options : undefined });
  const room = await buildRoomClient(invite, participantId, join.cursor);
  await room.announceKey();
  return room;
}

/** Build a RoomClient for a participant already registered on the server (e.g. session restart). */
export async function resumeRoom(invite: Invite, participantId: string): Promise<RoomClient> {
  return buildRoomClient(invite, participantId, 0);
}

async function buildRoomClient(invite: Invite, participantId: string, initialCursor: number): Promise<RoomClient> {
  let cursor = initialCursor;
  const cryptoSession = await createSdkCryptoSession(participantId);

  const client: RoomClient = {
    invite,
    participantId,
    get cursor() { return cursor; },

    async announceKey() {
      const publicKeyBody = await cryptoSession.announceKeyBody();
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: {
          to: "all" as Recipient,
          intent: "key.exchange",
          priority: "normal",
          body: publicKeyBody,
        },
      });
    },

    async send(to, body, options = {}) {
      const isKeyExchange = options.intent === "key.exchange" || options.plain;
      if (!isKeyExchange) await client.read({ all: true, includeSelf: true });
      const sendBody = isKeyExchange ? body : await cryptoSession.encryptForSend(body, to);
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: {
          to,
          body: sendBody,
          reply_to: options.replyTo ?? null,
          intent: options.intent ?? "notify",
          priority: options.priority ?? "normal",
        },
      });
    },

    async read(options = {}) {
      const url = new URL(invite.room_url);
      if (options.all) {
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        url.searchParams.set("view", "all");
      }
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      const result = await request<{ cursor: number; messages: RoomMessage[] }>(url.toString(), invite, { participantId });
      cursor = result.cursor;

      await cryptoSession.processKeyExchange(result.messages);

      return Promise.all(result.messages.map(async (msg) => ({
        ...msg,
        body: await cryptoSession.decryptMessageBody(msg),
      }))) as Promise<RoomMessage[]>;
    },

    async participants() {
      return request(invite.api.participants, invite);
    },
    async updateStatus(state: "free" | "busy", status: string, options = {}) {
      return request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, { method: "PATCH", participantId, body: { state, status, ...options } });
    },
    async board() {
      return request(invite.api.board, invite);
    },
    async setBoardKey(key: string, value: unknown) {
      return request(`${invite.room_url}/board/${encodeURIComponent(key)}`, invite, { method: "PUT", participantId, body: value });
    },
    async patchBoard(values: Record<string, unknown>) {
      return request(invite.api.board, invite, { method: "PATCH", participantId, body: values });
    },
    async deleteBoardKey(key: string) {
      return request(`${invite.room_url}/board/${encodeURIComponent(key)}`, invite, { method: "DELETE", participantId });
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
    async export() {
      return request(`${invite.room_url}/export`, invite, { participantId });
    },
  };
  return client;
}
