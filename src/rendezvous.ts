import { hashJoinSecret } from "./crypto";
import type { AgentRole, ClientMessage, Env, InviteState, ServerMessage, SocketAttachment } from "./types";

const STATE_KEY = "invite";

export class RendezvousSession {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      const body = (await request.json()) as InviteState;
      const existing = await this.getInvite();
      if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
      await this.state.storage.put(STATE_KEY, body);
      return json({ ok: true });
    }

    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (invite.phase === "closed") return new Response("invite closed", { status: 410 });
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return new Response("invite expired", { status: 410 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ opened: false, confirmed: false } satisfies SocketAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.sendError(ws, "binary messages are not supported in v1");
      return;
    }

    const message = parseMessage(raw);
    if (!message) {
      this.sendError(ws, "invalid json message");
      return;
    }

    const attachment = this.getAttachment(ws);
    const invite = await this.getInvite();
    if (!invite) {
      this.sendError(ws, "invite not found");
      ws.close(1008, "invite not found");
      return;
    }

    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      this.sendError(ws, "invite expired");
      ws.close(1008, "invite expired");
      return;
    }

    if (!attachment.opened) {
      if (message.type !== "open") {
        this.sendError(ws, "first message must be open");
        ws.close(1008, "first message must be open");
        return;
      }
      await this.open(ws, message, invite);
      return;
    }

    if (message.type === "open") {
      this.sendError(ws, "socket already opened");
      return;
    }

    if (message.type === "close") {
      ws.close(1000, "client requested close");
      return;
    }

    if (message.type === "confirmed") {
      await this.confirm(ws, invite);
      return;
    }

    if (message.type === "handshake") {
      this.relayToPeer(ws, message);
      return;
    }

    if (message.type === "msg") {
      const latest = await this.getInvite();
      if (latest?.phase !== "ready") {
        this.sendError(ws, "session is not ready");
        return;
      }
      this.relayToPeer(ws, message);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async open(ws: WebSocket, message: Extract<ClientMessage, { type: "open" }>, invite: InviteState): Promise<void> {
    if (message.role !== "a" && message.role !== "b") {
      this.sendError(ws, "invalid role");
      ws.close(1008, "invalid role");
      return;
    }

    const suppliedHash = await hashJoinSecret(invite.inviteId, message.join_secret);
    if (suppliedHash !== invite.secretHash) {
      this.sendError(ws, "invalid join secret");
      ws.close(1008, "invalid join secret");
      return;
    }

    if (this.findSocketByRole(message.role)) {
      this.sendError(ws, "role already connected");
      ws.close(1008, "role already connected");
      return;
    }

    const attachment: SocketAttachment = { role: message.role, opened: true, confirmed: false };
    ws.serializeAttachment(attachment);

    await this.state.storage.put(STATE_KEY, {
      ...invite,
      phase: "handshaking",
      aConfirmed: message.role === "a" ? false : invite.aConfirmed,
      bConfirmed: message.role === "b" ? false : invite.bConfirmed,
    } satisfies InviteState);

    const peer = this.findPeerSocket(message.role);
    if (peer) {
      this.send(ws, { type: "peer_joined" });
      this.send(peer, { type: "peer_joined" });
    }
  }

  private async confirm(ws: WebSocket, invite: InviteState): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment.role) {
      this.sendError(ws, "socket has no role");
      return;
    }

    const current = (await this.getInvite()) ?? invite;
    if (current.phase === "ready") return;

    ws.serializeAttachment({ ...attachment, confirmed: true } satisfies SocketAttachment);

    const updated: InviteState = {
      ...current,
      phase: "handshaking",
      aConfirmed: attachment.role === "a" ? true : current.aConfirmed,
      bConfirmed: attachment.role === "b" ? true : current.bConfirmed,
    };

    if (updated.aConfirmed && updated.bConfirmed && this.findSocketByRole("a") && this.findSocketByRole("b")) {
      updated.phase = "ready";
      await this.state.storage.put(STATE_KEY, updated);
      for (const socket of this.state.getWebSockets()) this.send(socket, { type: "ready" });
      return;
    }

    await this.state.storage.put(STATE_KEY, updated);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const invite = await this.getInvite();
    if (!invite) return;

    const attachment = this.getAttachment(ws);
    const peer = attachment.role ? this.findPeerSocket(attachment.role) : undefined;

    if (invite.phase === "ready" || invite.phase === "closed") {
      if (peer) {
        this.send(peer, { type: "peer_left" });
        peer.close(1000, "peer left");
      }
      await this.state.storage.deleteAll();
      return;
    }

    if (peer) {
      this.send(peer, { type: "peer_left" });
      const peerAttachment = this.getAttachment(peer);
      peer.serializeAttachment({ ...peerAttachment, confirmed: false } satisfies SocketAttachment);
    }

    await this.state.storage.put(STATE_KEY, {
      ...invite,
      phase: peer ? "handshaking" : "waiting",
      aConfirmed: false,
      bConfirmed: false,
    } satisfies InviteState);
  }

  private relayToPeer(ws: WebSocket, message: Exclude<ClientMessage, { type: "open" | "confirmed" | "close" }>): void {
    const role = this.getAttachment(ws).role;
    if (!role) {
      this.sendError(ws, "socket has no role");
      return;
    }

    const peer = this.findPeerSocket(role);
    if (!peer) {
      this.sendError(ws, "peer not connected");
      return;
    }

    if (message.type === "handshake") {
      this.send(peer, { type: "handshake", from: role, payload: message.payload });
      return;
    }

    this.send(peer, {
      type: "msg",
      id: message.id ?? crypto.randomUUID(),
      from: role,
      reply_to: message.reply_to ?? null,
      payload: message.payload,
    });
  }

  private findPeerSocket(role: AgentRole): WebSocket | undefined {
    return this.findSocketByRole(role === "a" ? "b" : "a");
  }

  private findSocketByRole(role: AgentRole): WebSocket | undefined {
    return this.state.getWebSockets().find((socket) => this.getAttachment(socket).role === role);
  }

  private getAttachment(ws: WebSocket): SocketAttachment {
    return (ws.deserializeAttachment() ?? {}) as SocketAttachment;
  }

  private async getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
