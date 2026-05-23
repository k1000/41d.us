import type { AgentRole, ClientMessage, ServerMessage } from "./types";

export type { AgentRole };

export interface Invite {
  intro: string;
  next_step: string;
  invite_id: string;
  join_secret: string;
  url: string;
  instructions: string;
  readme: string;
  skill: string;
  expires_at: string;
}

export interface ConnectOptions {
  url: string;
  joinSecret: string;
  role?: AgentRole;
  participantId?: string;
  name?: string;
  WebSocketImpl?: typeof WebSocket;
}

export interface SendEncryptedOptions {
  id?: string;
  replyTo?: string | null;
}

export type RendezvousEvent = ServerMessage | { type: "closed" };

export async function createInvite(baseUrl = "https://41d.us"): Promise<Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/invites`, { method: "POST" });
  if (!response.ok) throw new Error(`failed to create invite: ${response.status}`);
  return (await response.json()) as Invite;
}

export async function connectRendezvous(options: ConnectOptions): Promise<RendezvousClient> {
  const WebSocketCtor = options.WebSocketImpl ?? WebSocket;
  const ws = new WebSocketCtor(options.url);
  const client = new RendezvousClient(ws);

  await client.waitOpen();
  client.sendRaw({
    type: "open",
    role: options.role,
    participant_id: options.participantId,
    name: options.name,
    join_secret: options.joinSecret,
  });

  return client;
}

export class RendezvousClient {
  private readonly handlers = new Set<(event: RendezvousEvent) => void>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(private readonly ws: WebSocket) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", () => {
      this.rejectReady(new Error("rendezvous closed before ready"));
      this.emit({ type: "closed" });
    });
    this.ws.addEventListener("error", () => {
      this.rejectReady(new Error("rendezvous websocket error"));
      this.emit({ type: "error", error: "websocket error" });
    });
  }

  on(handler: (event: RendezvousEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  waitReady(): Promise<void> {
    return this.readyPromise;
  }

  sendHandshake(payload: unknown): void {
    this.sendRaw({ type: "handshake", payload });
  }

  confirm(): void {
    this.sendRaw({ type: "confirmed" });
  }

  sendEncrypted(payload: unknown, options: SendEncryptedOptions = {}): void {
    this.sendRaw({ type: "msg", id: options.id, reply_to: options.replyTo ?? null, payload });
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.sendRaw({ type: "close" });
    this.ws.close();
  }

  async waitOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      throw new Error("websocket is already closed");
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
        this.ws.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("websocket connection failed"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("websocket closed before opening"));
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
      this.ws.addEventListener("close", onClose);
    });
  }

  sendRaw(message: ClientMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("websocket is not open");
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.emit({ type: "error", error: "binary messages are not supported" });
      return;
    }

    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      this.emit({ type: "error", error: "invalid json from rendezvous" });
      return;
    }

    if (message.type === "ready") this.resolveReady();
    this.emit(message as RendezvousEvent);
  }

  private emit(event: RendezvousEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
