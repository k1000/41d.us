import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import type { ClientMessage, Env, InviteState, ServerMessage, SocketAttachment } from "./types";

const STATE_KEY = "invite";
const MAX_PARTICIPANTS = 16;
const MAX_MESSAGE_BYTES = 65_536;
const KNOWN_MESSAGE_TYPES = new Set(["open", "handshake", "confirmed", "msg", "close"]);

export class RendezvousSession {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      const body = (await request.json()) as InviteState;
      const existing = await this.getInvite();
      if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
      await this.state.storage.put(STATE_KEY, body);
      // Schedule auto-cleanup at expiry time so unvisited invites don't persist forever.
      await this.state.storage.setAlarm(body.expiresAt);
      return json({ ok: true });
    }

    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (invite.phase === "closed") return new Response("invite closed", { status: 410 });
    if (Date.now() > invite.expiresAt) {
      await this.cleanup();
      return new Response("invite expired", { status: 410 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      const joinUrl = websocketUrl(request);
      const joinSecret = url.searchParams.get("secret") ?? undefined;
      return respondNegotiated(
        request,
        () => inviteInstructionsPage(invite.inviteId, joinUrl, joinSecret),
        () => inviteInstructionsMarkdown(invite.inviteId, joinUrl, joinSecret),
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ opened: false } satisfies SocketAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    // Fires at invite.expiresAt — delete state if no one has joined or the room is empty.
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      await this.state.storage.deleteAll();
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.sendError(ws, "binary messages are not supported in v1");
      return;
    }

    if (raw.length > MAX_MESSAGE_BYTES) {
      this.sendError(ws, "message too large");
      ws.close(1009, "message too large");
      return;
    }

    const message = parseMessage(raw);
    if (!message) {
      this.sendError(ws, "invalid json message");
      return;
    }

    const invite = await this.getInvite();
    if (!invite) {
      this.sendError(ws, "invite not found");
      ws.close(1008, "invite not found");
      return;
    }

    const attachment = this.getAttachment(ws);
    if (!attachment.opened) {
      if (message.type !== "open") {
        this.sendError(ws, "first message must be open");
        ws.close(1008, "first message must be open");
        return;
      }
      await this.open(ws, message, invite);
      return;
    }

    switch (message.type) {
      case "open":
        this.sendError(ws, "socket already opened");
        return;
      case "close":
        ws.close(1000, "client requested close");
        return;
      case "confirmed":
        return;
      case "handshake":
      case "msg":
        this.broadcast(ws, message);
        return;
      default:
        this.sendError(ws, `unknown message type: ${(message as { type: string }).type}`);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async open(ws: WebSocket, message: Extract<ClientMessage, { type: "open" }>, invite: InviteState): Promise<void> {
    if (typeof message.join_secret !== "string" || message.join_secret.length === 0) {
      this.sendError(ws, "join_secret is required");
      ws.close(1008, "join_secret is required");
      return;
    }

    if (Date.now() > invite.expiresAt) {
      await this.cleanup();
      this.sendError(ws, "invite expired");
      ws.close(1008, "invite expired");
      return;
    }

    const suppliedHash = await hashJoinSecret(invite.inviteId, message.join_secret);
    if (suppliedHash !== invite.secretHash) {
      this.sendError(ws, "invalid join secret");
      ws.close(1008, "invalid join secret");
      return;
    }

    const openedCount = this.openedSockets().length;
    if (openedCount >= MAX_PARTICIPANTS) {
      this.sendError(ws, "room is full");
      ws.close(1008, "room is full");
      return;
    }

    const participantId = message.participant_id ?? message.name ?? message.role ?? `p${openedCount + 1}`;
    ws.serializeAttachment({ participantId, opened: true } satisfies SocketAttachment);

    const updated: InviteState = { ...invite, phase: "ready" };
    await this.state.storage.put(STATE_KEY, updated);

    const count = openedCount + 1;
    this.send(ws, { type: "ready", participant_id: participantId, count });
    this.broadcastServer(ws, { type: "peer_joined", participant_id: participantId, count });
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const invite = await this.getInvite();
    if (!invite) return;

    const participantId = this.getAttachment(ws).participantId;
    const allSockets = this.state.getWebSockets();
    const remaining = allSockets.filter((socket) => socket !== ws && this.getAttachment(socket).opened);

    if (participantId) {
      this.broadcastServer(ws, { type: "peer_left", participant_id: participantId, count: remaining.length });
    }

    if (remaining.length === 0) {
      await this.cleanup();
    }
  }

  private broadcast(ws: WebSocket, message: Exclude<ClientMessage, { type: "open" | "confirmed" | "close" }>): void {
    const from = this.getAttachment(ws).participantId;
    if (!from) {
      this.sendError(ws, "socket has no participant id");
      return;
    }

    if (message.type === "handshake") {
      this.broadcastServer(ws, { type: "handshake", from, payload: message.payload });
      return;
    }

    this.broadcastServer(ws, {
      type: "msg",
      id: message.id ?? crypto.randomUUID(),
      from,
      reply_to: message.reply_to ?? null,
      payload: message.payload,
    });
  }

  private broadcastServer(sender: WebSocket, message: ServerMessage): void {
    for (const socket of this.openedSockets()) {
      if (socket !== sender) this.send(socket, message);
    }
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

  private async cleanup(): Promise<void> {
    await this.state.storage.deleteAll();
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
    if (!KNOWN_MESSAGE_TYPES.has(value.type)) return undefined;
    return value as ClientMessage;
  } catch {
    return undefined;
  }
}

function websocketUrl(request: Request): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  return url.toString();
}
