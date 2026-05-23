import {
  decryptWithKey,
  deriveSelfKey,
  deriveSharedKey,
  encryptWithKey,
  exportPublicKey,
  generateECDHKeyPair,
  generateMessageKey,
  importPublicKey,
  isEncryptedBody,
  unwrapKey,
  wrapKeyForRecipient,
} from "./crypto";
import type { EncryptedBody } from "./crypto";
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
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  purpose?: string;
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
   * Read messages since last cursor. Encrypted messages are automatically
   * decrypted. Key exchange messages are processed to build the peer key
   * directory.
   */
  read(options?: { includeSelf?: boolean }): Promise<RoomMessage[]>;

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

export async function joinRoom(invite: Invite, participantId: string, options: { model?: string; skills?: string[] } = {}): Promise<RoomClient> {
  const join = await request<{ ok: true; cursor: number }>(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, { method: "PUT", body: Object.keys(options).length ? options : undefined });
  let cursor = join.cursor;

  // Generate ECDH keypair for this session
  const keyPair = await generateECDHKeyPair();
  const selfKey = await deriveSelfKey(keyPair);

  // Peer public keys: participantId → CryptoKey
  const peerKeys = new Map<string, CryptoKey>();

  // Derived shared keys: participantId → CryptoKey (AES-256-GCM)
  const sharedKeys = new Map<string, CryptoKey>();

  /** Lazily derive a shared key for a peer when we first encounter their public key. */
  async function ensureSharedKey(peerId: string): Promise<CryptoKey | undefined> {
    if (sharedKeys.has(peerId)) return sharedKeys.get(peerId)!;
    const peerPub = peerKeys.get(peerId);
    if (!peerPub) return undefined;
    const derived = await deriveSharedKey(keyPair.privateKey, peerPub);
    sharedKeys.set(peerId, derived);
    return derived;
  }

  /** Process key exchange messages to collect peer public keys. */
  async function processKeyExchange(messages: RoomMessage[]): Promise<void> {
    for (const msg of messages) {
      if (msg.intent !== "key.exchange" || msg.from === participantId) continue;
      if (peerKeys.has(msg.from)) continue;
      const body = msg.body as { public_key?: string };
      if (!body.public_key) continue;
      peerKeys.set(msg.from, await importPublicKey(body.public_key));
    }
  }

  /** Encrypt a plain body for the given recipients. */
  async function encryptForSend(plainBody: unknown, to: Recipient): Promise<EncryptedBody> {
    const recipientIds = to === "all"
      ? [...peerKeys.keys()]
      : (Array.isArray(to) ? to : [to]);

    const plaintext = JSON.stringify(plainBody);

    // Direct message to a single recipient (not self)
    if (recipientIds.length === 1 && recipientIds[0] !== participantId) {
      const sharedKey = await ensureSharedKey(recipientIds[0]);
      if (!sharedKey) throw new Error(`No public key from ${recipientIds[0]}. Wait for them to announceKey() and sync by reading.`);
      const { ciphertext, iv } = await encryptWithKey(sharedKey, plaintext);
      return { encrypted: true, ciphertext, iv };
    }

    // Broadcast or multi-recipient: generate a message key, encrypt body with it,
    // then wrap the message key for each recipient (including self).
    const messageKey = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(messageKey, plaintext);
    const keys: Record<string, { encrypted_key: string; iv: string }> = {};

    for (const recipientId of recipientIds) {
      if (recipientId === participantId) {
        // Wrap for self using self-derived key
        keys[participantId] = await wrapKeyForRecipient(messageKey, selfKey);
      } else {
        const sharedKey = await ensureSharedKey(recipientId);
        if (!sharedKey) throw new Error(`No public key from ${recipientId}. Wait for them to announceKey() and sync by reading.`);
        keys[recipientId] = await wrapKeyForRecipient(messageKey, sharedKey);
      }
    }

    // Always include self so we can read our own messages
    if (!keys[participantId]) {
      keys[participantId] = await wrapKeyForRecipient(messageKey, selfKey);
    }

    return { encrypted: true, ciphertext, iv, keys };
  }

  /** Decrypt a message body if it's encrypted. Returns the original body if plaintext. */
  async function decryptMessageBody(msg: RoomMessage): Promise<unknown> {
    const body = msg.body;
    if (!isEncryptedBody(body)) return body;

    const { ciphertext, iv, keys } = body;

    // Broadcast: unwrap our message key, then decrypt
    if (keys && keys[participantId]) {
      const unwrapSharedKey = msg.from === participantId ? selfKey : await ensureSharedKey(msg.from);
      if (!unwrapSharedKey) return body; // can't decrypt, pass through
      const messageKey = await unwrapKey(keys[participantId].encrypted_key, keys[participantId].iv, unwrapSharedKey);
      return JSON.parse(await decryptWithKey(messageKey, ciphertext, iv));
    }

    // Direct message: decrypt with shared key from sender
    if (!keys) {
      const sharedKey = msg.from === participantId ? selfKey : await ensureSharedKey(msg.from);
      if (!sharedKey) return body; // can't decrypt, pass through
      return JSON.parse(await decryptWithKey(sharedKey, ciphertext, iv));
    }

    // keys present but we're not in them — message wasn't for us
    return body;
  }

  return {
    invite,
    participantId,
    cursor,

    async announceKey() {
      const publicKey = await exportPublicKey(keyPair.publicKey);
      // Also register our own key so we can derive self-shared-key for broadcasts
      peerKeys.set(participantId, keyPair.publicKey);
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: {
          to: "all" as Recipient,
          intent: "key.exchange",
          priority: "normal",
          body: { public_key: publicKey },
        },
      });
    },

    async send(to, body, options = {}) {
      const isKeyExchange = options.intent === "key.exchange" || options.plain;
      const sendBody = isKeyExchange ? body : await encryptForSend(body, to);
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
      url.searchParams.set("after", String(cursor));
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      const result = await request<{ cursor: number; messages: RoomMessage[] }>(url.toString(), invite, { participantId });
      cursor = result.cursor;

      // Process any key exchange messages to learn peer public keys
      await processKeyExchange(result.messages);

      // Decrypt encrypted messages
      return Promise.all(result.messages.map(async (msg) => ({
        ...msg,
        body: await decryptMessageBody(msg),
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
}

async function request<T>(url: string, invite: Invite, options: { method?: string; participantId?: string; body?: unknown } = {}): Promise<T> {
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
