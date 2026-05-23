import { DEFAULT_MAX_PARTICIPANTS, MAX_BODY_BYTES, MAX_MESSAGES } from "./constants";
import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import type { Env, InviteState, Participant, Recipient, RoomMessage } from "./types";
import { sanitizeId } from "./utils";

const STATE_KEY = "invite";

export class RendezvousSession {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      const body = (await request.json()) as InviteState;
      const existing = await this.getInvite();
      if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
      const firstMessage = body.firstMessage ? [{
        id: crypto.randomUUID(),
        seq: 1,
        from: body.hostId ?? "host",
        to: "all" as const,
        reply_to: null,
        intent: "room_purpose",
        priority: "normal",
        body: body.firstMessage,
        created_at: new Date().toISOString(),
      }] : [];
      await this.state.storage.put(STATE_KEY, { ...body, nextSeq: firstMessage.length, participants: {}, messages: firstMessage } satisfies InviteState);
      return json({ ok: true });
    }

    const invite = await this.getValidInvite();
    if (invite instanceof Response) return invite;

    if (url.pathname.endsWith("/join") && request.method === "POST") return this.handleJoin(request, invite);
    if (url.pathname.endsWith("/messages") && request.method === "POST") return this.handleSend(request, invite);
    if (url.pathname.endsWith("/messages/read") && request.method === "POST") return this.handleRead(request, invite);
    if (url.pathname.endsWith("/participants") && request.method === "POST") return this.handleParticipants(request, invite);
    if (url.pathname.endsWith("/status") && request.method === "POST") return this.handleStatus(request, invite);
    if (url.pathname.endsWith("/kick") && request.method === "POST") return this.handleKick(request, invite);
    if (url.pathname.endsWith("/close") && request.method === "POST") return this.handleClose(request, invite);
    if (url.pathname.endsWith("/leave") && request.method === "POST") return this.handleLeave(request, invite);

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket transport has been removed. Use the HTTP async mailbox endpoints.", { status: 410 });
    }

    const roomUrl = httpRoomUrl(request);
    return respondNegotiated(
      request,
      () => inviteInstructionsPage(invite.inviteId, roomUrl),
      () => inviteInstructionsMarkdown(invite.inviteId, roomUrl),
    );
  }

  // ── Auth helpers ──────────────────────────────────────────────

  private async authenticate(request: Request, invite: InviteState): Promise<Record<string, unknown> | Response> {
    const body = await request.json() as Record<string, unknown>;
    const token = (body.admission_token ?? body.join_secret) as string | undefined;
    if (!token) return json({ error: "admission_token is required" }, 401);
    const tokenHash = await hashJoinSecret(invite.inviteId, token);
    if (tokenHash !== invite.secretHash) return json({ error: "invalid admission_token" }, 403);
    return body;
  }

  /**
   * Authenticate and require a valid participant_id.
   * Returns body + participantId, or an error Response.
   */
  private async authenticateParticipant(request: Request, invite: InviteState): Promise<{ body: Record<string, unknown>; participantId: string } | Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(body.participant_id);
    if (participantId instanceof Response) return participantId;
    return { body, participantId };
  }

  // ── Handlers ──────────────────────────────────────────────────

  private async handleJoin(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId } = auth;

    const participants = invite.participants ?? {};
    if (!participants[participantId] && this.activeCount(participants) >= (invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)) {
      return json({ error: "room is full", max_participants: invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS }, 409);
    }
    if (participants[participantId] && !participants[participantId].left_at) return json({ error: "participant_id already joined" }, 409);
    const now = new Date().toISOString();
    participants[participantId] = { id: participantId, joined_at: now, last_seen_at: now };
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, room: roomInfo(updated), participant_id: participantId, is_host: participantId === invite.hostId, cursor: invite.nextSeq ?? 0, message: "Joined. Read with POST /messages/read and send with POST /messages." });
  }

  private async handleSend(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;

    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    if (new TextEncoder().encode(JSON.stringify(body.body ?? {})).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
    const to: Recipient = (body.to as Recipient) ?? "all";
    if (!this.validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
    const seq = (invite.nextSeq ?? 0) + 1;
    const message: RoomMessage = {
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
    const messages = [...(invite.messages ?? []), message].slice(-MAX_MESSAGES);
    await this.state.storage.put(STATE_KEY, { ...invite, nextSeq: seq, messages } satisfies InviteState);
    return json({ ok: true, id: message.id, seq });
  }

  private async handleRead(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;

    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const after = Number(body.after ?? 0);
    const includeSelf = !!body.include_self;
    const messages = (invite.messages ?? []).filter((msg) => msg.seq > after && (includeSelf || msg.from !== participantId) && this.visibleTo(msg, participantId));
    const participants = invite.participants ?? {};
    participants[participantId] = { ...participants[participantId], last_seen_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    return json({
      participant_id: participantId,
      cursor: invite.nextSeq ?? 0,
      oldest_seq: (invite.messages ?? [])[0]?.seq ?? 0,
      retention: { max_messages: MAX_MESSAGES },
      messages,
    });
  }

  private async handleParticipants(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    return json({ room: roomInfo(invite), participants: this.activeParticipants(invite) });
  }

  private async handleStatus(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    return json({
      ...this.buildStatus(invite),
      closed: invite.phase === "closed",
    });
  }

  private async handleLeave(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId } = auth;

    const participants = { ...invite.participants };
    if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    await this.maybeDeleteEmptyRoom();
    return json({ ok: true });
  }

  private async handleKick(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId: hostId } = auth;

    const targetResult = requireParticipantId(body.target_id);
    if (targetResult instanceof Response) return json({ error: "target_id is required" }, 400);
    const targetId = targetResult as string;

    if (hostId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);

    const participants = { ...invite.participants };
    if (!participants[targetId] || participants[targetId].left_at) return json({ error: "target participant is not active" }, 404);
    participants[targetId] = { ...participants[targetId], left_at: new Date().toISOString() };
    const updated = { ...invite, participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }

  private async handleClose(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId: hostId } = auth;

    if (hostId !== invite.hostId) return json({ error: "only host can close room" }, 403);
    await this.state.storage.put(STATE_KEY, { ...invite, phase: "closed" } satisfies InviteState);
    return json({ ok: true, closed: true });
  }

  // ── Domain helpers ────────────────────────────────────────────

  private activeCount(participants: Record<string, Participant>): number {
    return Object.values(participants).filter((p) => !p.left_at).length;
  }

  private activeParticipants(invite: InviteState): Participant[] {
    return Object.values(invite.participants ?? {}).filter((p) => !p.left_at);
  }

  private buildStatus(invite: InviteState) {
    return {
      room: roomInfo(invite),
      participants: this.activeParticipants(invite),
      message_count: invite.messages?.length ?? 0,
      last_seq: invite.nextSeq ?? 0,
      oldest_seq: (invite.messages ?? [])[0]?.seq ?? 0,
      expires_at: new Date(invite.expiresAt).toISOString(),
    };
  }

  private isJoined(invite: InviteState, participantId: string): boolean {
    const participant = invite.participants?.[participantId];
    return !!participant && !participant.left_at;
  }

  private validRecipient(invite: InviteState, to: Recipient): boolean {
    if (to === "all") return true;
    const recipients = Array.isArray(to) ? to : [to];
    return recipients.every((id) => this.isJoined(invite, id));
  }

  private visibleTo(message: RoomMessage, participantId: string): boolean {
    if (message.to === "all") return true;
    if (Array.isArray(message.to)) return message.to.includes(participantId);
    return message.to === participantId;
  }

  // ── Storage ────────────────────────────────────────────────────

  private async getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
  }

  private async getValidInvite(): Promise<InviteState | Response> {
    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (invite.phase === "closed") return new Response("room closed", { status: 410 });
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return new Response("invite expired", { status: 410 });
    }
    return invite;
  }

  private async maybeDeleteEmptyRoom(): Promise<void> {
    const invite = await this.getInvite();
    if (!invite) return;
    if (!Object.values(invite.participants ?? {}).some((p) => !p.left_at)) {
      await this.state.storage.deleteAll();
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────

function roomInfo(invite: InviteState) {
  return {
    invite_id: invite.inviteId,
    name: invite.roomName ?? "41d rendezvous",
    host_id: invite.hostId ?? "host",
    max_participants: invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
  };
}

function requireParticipantId(value: unknown): string | Response {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return json({ error: "participant_id is required" }, 400);
  return sanitizeId(id);
}

function httpRoomUrl(request: Request): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.search = "";
  return url.toString();
}
