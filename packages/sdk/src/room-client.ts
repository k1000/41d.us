import { createSdkCryptoSession } from "./sdk-crypto-session";
import { request } from "./transport";
import type {
  Recipient,
  RoomMessage,
  ParticipantsResponse,
  RoomStatusResponse,
  BoardResponse,
  RoomExportResponse,
  Participant,
} from "./types";

// ── Public types ────────────────────────────────────────────────

export interface CreateInviteOptions {
  roomId?: string;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  inviteTtlMs?: number;
  purpose?: string;
  firstMessage?: string | Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  board?: Record<string, unknown>;
}

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

export interface RoomClient {
  invite: Invite;
  participantId: string;
  cursor: number;
  announceKey(): Promise<void>;
  send(
    to: Recipient,
    body: unknown,
    options?: { replyTo?: string | null; intent?: string; priority?: string; plain?: boolean },
  ): Promise<{ ok: true; id: string; seq: number }>;
  read(options?: { includeSelf?: boolean; all?: boolean }): Promise<RoomMessage[]>;
  participants(): Promise<ParticipantsResponse>;
  updateStatus(state: "free" | "busy", status: string, options?: { model?: string; skills?: string[] }): Promise<{ ok: true; participant: Participant }>;
  board(): Promise<BoardResponse>;
  setBoardKey(key: string, value: unknown): Promise<{ ok: true; key: string; entry: BoardResponse["board"][string] }>;
  patchBoard(values: Record<string, unknown>): Promise<{ ok: true; updated: Record<string, BoardResponse["board"][string]>; board: BoardResponse["board"] }>;
  deleteBoardKey(key: string): Promise<{ ok: true; deleted: string }>;
  status(): Promise<RoomStatusResponse>;
  leave(): Promise<void>;
  kick(targetId: string): Promise<{ ok: true; kicked: string }>;
  close(): Promise<{ ok: true; closed: boolean }>;
  export(): Promise<RoomExportResponse>;
}

// ── Factory ─────────────────────────────────────────────────────

export async function buildRoomClient(
  invite: Invite,
  participantId: string,
  initialCursor: number,
): Promise<RoomClient> {
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
        body: { to: "all" as Recipient, intent: "key.exchange", priority: "normal", body: publicKeyBody },
      });
    },

    async send(to: Recipient, body: unknown, options = {}) {
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
      const result = await request<{ cursor: number; messages: RoomMessage[] }>(
        url.toString(), invite, { participantId },
      );
      cursor = result.cursor;
      await cryptoSession.processKeyExchange(result.messages);
      return Promise.all(
        result.messages.map((msg) =>
          cryptoSession.decryptMessageBody(msg).then(
            (body) => ({ ...msg, body } satisfies RoomMessage),
          ),
        ),
      );
    },

    async participants() {
      return request<ParticipantsResponse>(invite.api.participants, invite);
    },
    async updateStatus(state: "free" | "busy", status: string, opts = {}) {
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { state, status, ...opts } },
      );
    },
    async board() {
      return request<BoardResponse>(invite.api.board, invite);
    },
    async setBoardKey(key: string, value: unknown) {
      return request<{ ok: true; key: string; entry: BoardResponse["board"][string] }>(
        `${invite.room_url}/board/${encodeURIComponent(key)}`,
        invite,
        { method: "PUT", participantId, body: value },
      );
    },
    async patchBoard(values: Record<string, unknown>) {
      return request<{ ok: true; updated: Record<string, BoardResponse["board"][string]>; board: BoardResponse["board"] }>(
        invite.api.board, invite, { method: "PATCH", participantId, body: values },
      );
    },
    async deleteBoardKey(key: string) {
      return request<{ ok: true; deleted: string }>(
        `${invite.room_url}/board/${encodeURIComponent(key)}`,
        invite,
        { method: "DELETE", participantId },
      );
    },
    async status() {
      return request<RoomStatusResponse>(invite.api.status, invite);
    },
    async leave() {
      await request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, {
        method: "DELETE",
      });
    },
    async kick(targetId: string) {
      return request<{ ok: true; kicked: string }>(
        `${invite.room_url}/participants/${encodeURIComponent(targetId)}`,
        invite,
        { method: "DELETE", participantId },
      );
    },
    async close() {
      return request<{ ok: true; closed: boolean }>(invite.room_url, invite, {
        method: "DELETE",
        participantId,
      });
    },
    async export() {
      return request<RoomExportResponse>(`${invite.room_url}/export`, invite, { participantId });
    },
  };

  return client;
}
