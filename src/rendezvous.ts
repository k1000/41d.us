import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import type { ClientMessage, Env, InviteState, Recipient, RoomMessage, ServerMessage, SocketAttachment } from "./types";

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
    if (url.pathname.endsWith("/leave") && request.method === "POST") return this.handleLeave(request, invite);

    if (request.headers.get("Upgrade") !== "websocket") {
      const joinUrl = websocketUrl(request);
      return respondNegotiated(
        request,
        () => inviteInstructionsPage(invite.inviteId, joinUrl),
        () => inviteInstructionsMarkdown(invite.inviteId, joinUrl),
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ opened: false } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return this.sendError(ws, "binary messages are not supported in v1");
    const message = parseMessage(raw);
    if (!message) return this.sendError(ws, "invalid json message");
    const invite = await this.getValidInvite();
    if (invite instanceof Response) {
      this.sendError(ws, await invite.text());
      ws.close(1008, "invalid invite");
      return;
    }

    const attachment = this.getAttachment(ws);
    if (!attachment.opened) {
      if (message.type !== "open") {
        this.sendError(ws, "first message must be open");
        ws.close(1008, "first message must be open");
        return;
      }
      await this.openSocket(ws, message, invite);
      return;
    }

    if (message.type === "close") return ws.close(1000, "client requested close");
    if (message.type === "confirmed" || message.type === "open") return;
    if (message.type === "handshake") return this.broadcastSocket(ws, { type: "handshake", payload: message.payload });
    if (message.type === "msg") return this.broadcastSocket(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const participantId = this.getAttachment(ws).participantId;
    if (!participantId) return;
    this.broadcastServer(ws, { type: "peer_left", participant_id: participantId, count: this.openedSockets().filter((s) => s !== ws).length });
    if (this.openedSockets().filter((s) => s !== ws).length === 0) await this.maybeDeleteEmptyRoom();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private async handleJoin(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string };
    const participantId = sanitizeParticipantId(body.participant_id ?? invite.hostId);
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    const participants = invite.participants ?? {};
    if (!participants[participantId] && Object.keys(participants).filter((id) => !participants[id].left_at).length >= (invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)) {
      return json({ error: "room is full", max_participants: invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS }, 409);
    }
    const now = new Date().toISOString();
    participants[participantId] = { id: participantId, joined_at: participants[participantId]?.joined_at ?? now, last_seen_at: now };
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, room: roomInfo(updated), participant_id: participantId, is_host: participantId === invite.hostId, cursor: invite.nextSeq ?? 0, message: "Joined. Read with POST /messages/read and send with POST /messages." });
  }

  private async handleSend(request: Request, invite: InviteState): Promise<Response> {
    const body = await request.json() as { admission_token?: string; join_secret?: string; participant_id?: string; to?: Recipient; body?: unknown; reply_to?: string | null; intent?: string; priority?: string };
    const participantId = sanitizeParticipantId(body.participant_id);
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
    const participantId = sanitizeParticipantId(body.participant_id);
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
    const participantId = sanitizeParticipantId(body.participant_id);
    const auth = await this.authorize(invite, body.admission_token ?? body.join_secret);
    if (auth) return auth;
    const participants = invite.participants ?? {};
    if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    await this.maybeDeleteEmptyRoom();
    return json({ ok: true });
  }

  private async openSocket(ws: WebSocket, message: Extract<ClientMessage, { type: "open" }>, invite: InviteState): Promise<void> {
    const token = message.admission_token ?? message.join_secret;
    const auth = await this.authorize(invite, token);
    if (auth) {
      this.sendError(ws, await auth.text());
      ws.close(1008, "auth failed");
      return;
    }
    const participantId = sanitizeParticipantId(message.participant_id ?? message.name ?? message.role ?? invite.hostId);
    ws.serializeAttachment({ participantId, opened: true } satisfies SocketAttachment);
    this.send(ws, { type: "ready", participant_id: participantId, count: this.openedSockets().length });
    this.broadcastServer(ws, { type: "peer_joined", participant_id: participantId, count: this.openedSockets().length });
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

  private broadcastSocket(ws: WebSocket, message: Exclude<ClientMessage, { type: "open" | "confirmed" | "close" }>): void {
    const from = this.getAttachment(ws).participantId;
    if (!from) return this.sendError(ws, "socket has no participant id");
    if (message.type === "handshake") return this.broadcastServer(ws, { type: "handshake", from, payload: message.payload });
    this.broadcastServer(ws, { type: "msg", id: message.id ?? crypto.randomUUID(), from, reply_to: message.reply_to ?? null, body: message.body ?? message.payload ?? {} });
  }

  private broadcastServer(sender: WebSocket, message: ServerMessage): void {
    for (const socket of this.openedSockets()) if (socket !== sender) this.send(socket, message);
  }

  private openedSockets(): WebSocket[] {
    return this.state.getWebSockets().filter((socket) => this.getAttachment(socket).opened);
  }

  private getAttachment(ws: WebSocket): SocketAttachment {
    return (ws.deserializeAttachment() ?? {}) as SocketAttachment;
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
    const hasActiveHttp = Object.values(invite.participants ?? {}).some((p) => !p.left_at);
    if (!hasActiveHttp && this.openedSockets().length === 0) await this.state.storage.deleteAll();
  }

  private sendError(ws: WebSocket, error: string): void {
    this.send(ws, { type: "error", error });
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }
}

function parseMessage(raw: string): ClientMessage | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ClientMessage>;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return undefined;
    return value as ClientMessage;
  } catch {
    return undefined;
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

function sanitizeParticipantId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return `agent-${crypto.randomUUID().slice(0, 8)}`;
  return id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
}

function websocketUrl(request: Request): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  return url.toString();
}
