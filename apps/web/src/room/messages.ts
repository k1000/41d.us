import { MAX_BODY_BYTES, MAX_MESSAGES } from "../constants";
import { isEncryptedBody } from "@41d/sdk/crypto";
import { json } from "../format";
import type { InitPayload, InviteState, Recipient, RoomMessage } from "../types";
import { activeParticipants, isParticipantJoined } from "./participants";

const ENCODER = new TextEncoder();

interface ReadOptions {
  after: number;
  includeSelf: boolean;
  mode: "recent" | "all";
}

export function parseReadOptions(request: Request, body: Record<string, unknown>, invite: InviteState, participantId: string): ReadOptions {
  const url = new URL(request.url);
  const mode = body.all === true || url.searchParams.get("view") === "all" ? "all" : "recent";
  const explicitAfter = body.after ?? url.searchParams.get("after");
  const lastReadSeq = invite.participants[participantId]?.last_read_seq ?? 0;
  return {
    after: mode === "all" ? 0 : Number(explicitAfter ?? lastReadSeq),
    includeSelf: !!body.include_self || url.searchParams.get("include_self") === "true",
    mode,
  };
}

export function buildReadResponse(invite: InviteState, participantId: string, messages: RoomMessage[], options: ReadOptions) {
  return {
    participant_id: participantId,
    mode: options.mode,
    cursor: invite.nextSeq,
    oldest_seq: invite.messages[0]?.seq ?? 0,
    retention: { max_messages: MAX_MESSAGES },
    messages,
  };
}

export function createSentMessage(body: Record<string, unknown>, participantId: string, invite: InviteState): { message: RoomMessage; messages: RoomMessage[]; seq: number } | Response {
  if (ENCODER.encode(JSON.stringify(body.body ?? {})).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
  const to: Recipient = (body.to as Recipient) ?? "all";
  if (!validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
  const encryptionValidation = validateEncryptedProtocol(body, participantId, to, invite);
  if (encryptionValidation) return encryptionValidation;
  const seq = invite.nextSeq + 1;
  const message = createRoomMessage(body, participantId, to, seq);
  const messages = [...invite.messages, message].slice(-MAX_MESSAGES);
  return { message, messages, seq };
}

export function createRoomMessage(body: Record<string, unknown>, participantId: string, to: Recipient, seq: number): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq,
    from: participantId,
    to,
    reply_to: (body.reply_to as string) ?? null,
    intent: (body.intent as string) ?? "notify",
    priority: (body.priority as string) ?? "normal",
    body: (body.body as unknown) ?? {},
    created_at: new Date().toISOString(),
  };
}

export function createInitialMessage(body: InitPayload): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    from: body.hostId,
    to: "all",
    reply_to: null,
    intent: "room_purpose",
    priority: "normal",
    body: body.firstMessage,
    created_at: new Date().toISOString(),
  };
}

export function isReadableMessage(message: RoomMessage, participantId: string, options: ReadOptions): boolean {
  return message.seq > options.after && (options.includeSelf || message.from !== participantId) && visibleTo(message, participantId);
}

export function visibleTo(message: RoomMessage, participantId: string): boolean {
  if (message.to === "all") return true;
  if (Array.isArray(message.to)) return message.to.includes(participantId);
  return message.to === participantId;
}

function validRecipient(invite: InviteState, to: Recipient): boolean {
  if (to === "all") return true;
  const recipients = Array.isArray(to) ? to : [to];
  return recipients.every((id) => isParticipantJoined(invite.participants, id));
}

function isAllowedPlainProtocolMessage(body: Record<string, unknown>): boolean {
  return body.intent === "key.exchange";
}

function isOpaqueEncryptedBody(body: unknown): boolean {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.encrypted_payload === "string") return true;
  }
  return false;
}

function validateEncryptedProtocol(body: Record<string, unknown>, participantId: string, to: Recipient, invite: InviteState): Response | undefined {
  if (isAllowedPlainProtocolMessage(body)) return undefined;
  if (isOpaqueEncryptedBody(body.body)) return undefined;
  if (!isEncryptedBody(body.body)) {
    return json({
      error: "message body must be encrypted",
      hint: "Use /client/41d.js for send/read, or send an encrypted SDK body / encrypted_payload token.",
    }, 400);
  }

  const announced = announcedKeyParticipants(invite);
  if (!announced.has(participantId)) {
    return json({
      error: "sender has not announced encryption key",
      hint: "Join with the encrypted client or send intent=key.exchange before sending encrypted messages.",
    }, 409);
  }

  const recipients = recipientIdsFor(to, invite);
  const missingKeys = recipients.filter((id) => !announced.has(id));
  if (missingKeys.length > 0) {
    return json({
      error: "recipient encryption keys are missing",
      missing_participants: missingKeys,
      hint: "Every recipient, including the host for broadcast rooms, must join/announce its ECDH key before encrypted messages can be sent to it.",
    }, 409);
  }

  if (to === "all" || Array.isArray(to)) {
    const requiredWrappedKeys = [...new Set([...recipients, participantId])];
    const wrappedKeys = body.body.keys ?? {};
    const missingWrappedKeys = requiredWrappedKeys.filter((id) => !wrappedKeys[id]);
    if (missingWrappedKeys.length > 0) {
      return json({
        error: "encrypted message is missing wrapped recipient keys",
        missing_participants: missingWrappedKeys,
        hint: "Read/sync first so the client sees each participant's key.exchange message, then send again.",
      }, 409);
    }
  }

  return undefined;
}

function announcedKeyParticipants(invite: InviteState): Set<string> {
  return new Set(invite.messages
    .filter((message) => message.intent === "key.exchange" && typeof (message.body as { public_key?: unknown })?.public_key === "string")
    .map((message) => message.from));
}

function recipientIdsFor(to: Recipient, invite: InviteState): string[] {
  if (to === "all") return [...new Set([...activeParticipants(invite.participants).map((p) => p.id), invite.hostId])];
  return Array.isArray(to) ? [...new Set(to)] : [to];
}
