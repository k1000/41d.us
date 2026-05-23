import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import type { Env, InviteState, Recipient, RoomMessage } from "./types";

const STATE_KEY = "invite";
const DEFAULT_MAX_PARTICIPANTS = 16;
const MAX_MESSAGES = 200;
const MAX_BODY_BYTES = 16 * 1024;

export class RendezvousSession {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      const body = (await request.json()) as InviteState;
      const existing = await this.getInvite();
      if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
      await this.state.storage.put(STATE_KEY, { ...body, nextSeq: 0, participants: {}, messages: [] } satisfies InviteState);
      return json({ ok: true });
    }

    const invite = await this.getValidInvite();
    if (invite instanceof Response) return invite;

    if (url.pathname.endsWith("/join") && request.method === "POST") return this.handleJoin(request, invite);
    if (url.pathname.endsWith("/messages") && request.method === "POST") return this.handleSend(request, invite);
    if (url.pathname.endsWith("/messages/read") && request.method === "POST") return this.handleRead(request, invite);
    if (url.pathname.endsWith("/participants") && request.method === "POST") return this.handleParticipants(request, invite);
    if (url.pathname.endsWith("/kick") && request.method === "POST") return this.handleKick(request, invite);
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

  private async handleJoin(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string };
    const participantResult = requireParticipantId(body.participant_id);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult;
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    const participants = invite.participants ?? {};
    if (!participants[participantId] && Object.keys(participants).filter((id) => !participants[id].left_at).length >= (invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)) {
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
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string; to?: Recipient; body?: unknown; reply_to?: string | null; intent?: string; priority?: string };
    const participantResult = requireParticipantId(body.participant_id);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult;
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    if (JSON.stringify(body.body ?? {}).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
    const to = body.to ?? "all";
    if (!this.validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
    const seq = (invite.nextSeq ?? 0) + 1;
    const message: RoomMessage = {
      id: crypto.randomUUID(),
      seq,
      from: participantId,
      to,
      reply_to: body.reply_to ?? null,
      intent: body.intent ?? "notify",
      priority: body.priority ?? "normal",
      body: body.body ?? {},
      created_at: new Date().toISOString(),
    };
    const messages = [...(invite.messages ?? []), message].slice(-MAX_MESSAGES);
    await this.state.storage.put(STATE_KEY, { ...invite, nextSeq: seq, messages } satisfies InviteState);
    return json({ ok: true, id: message.id, seq });
  }

  private async handleRead(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string; after?: number; include_self?: boolean };
    const participantResult = requireParticipantId(body.participant_id);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult;
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const after = Number(body.after ?? 0);
    const messages = (invite.messages ?? []).filter((msg) => msg.seq > after && (body.include_self || msg.from !== participantId) && this.visibleTo(msg, participantId));
    const participants = invite.participants ?? {};
    participants[participantId] = { ...participants[participantId], last_seen_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    return json({ participant_id: participantId, cursor: invite.nextSeq ?? 0, messages });
  }

  private async handleParticipants(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string };
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    return json({ room: roomInfo(invite), participants: Object.values(invite.participants ?? {}).filter((p) => !p.left_at) });
  }

  private async handleLeave(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string };
    const participantResult = requireParticipantId(body.participant_id);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult;
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    const participants = invite.participants ?? {};
    if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    await this.maybeDeleteEmptyRoom();
    return json({ ok: true });
  }

  private async handleKick(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string; target_id?: string };
    const hostResult = requireParticipantId(body.participant_id);
    if (hostResult instanceof Response) return hostResult;
    const hostId = hostResult;
    const targetResult = requireParticipantId(body.target_id);
    if (targetResult instanceof Response) return json({ error: "target_id is required" }, 400);
    const targetId = targetResult;
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    if (hostId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);

    const participants = invite.participants ?? {};
    if (!participants[targetId] || participants[targetId].left_at) return json({ error: "target participant is not active" }, 404);
    participants[targetId] = { ...participants[targetId], left_at: new Date().toISOString() };
    const updated = { ...invite, participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }

  private async authorize(invite: InviteState, token: string | undefined): Promise<Response | undefined> {
    if (!token) return json({ error: "admission_token is required" }, 401);
    const tokenHash = await hashJoinSecret(invite.inviteId, token);
    if (tokenHash !== invite.secretHash) return json({ error: "invalid admission_token" }, 403);
    return undefined;
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

  private async getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
  }

  private async getValidInvite(): Promise<InviteState | Response> {
    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return new Response("invite expired", { status: 410 });
    }
    return invite;
  }

  private async maybeDeleteEmptyRoom(): Promise<void> {
    const invite = await this.getInvite();
    if (!invite) return;
    const hasActiveParticipants = Object.values(invite.participants ?? {}).some((p) => !p.left_at);
    if (!hasActiveParticipants) await this.state.storage.deleteAll();
  }
}

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
  return sanitizeParticipantId(id);
}

function sanitizeParticipantId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}

function httpRoomUrl(request: Request): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.search = "";
  return url.toString();
}
