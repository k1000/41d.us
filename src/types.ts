export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
}

export type SessionPhase = "waiting" | "handshaking" | "ready" | "closed";

export interface InviteState {
  inviteId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  aConfirmed: boolean;
  bConfirmed: boolean;
}

export interface SocketAttachment {
  role?: "a" | "b";
  opened?: boolean;
  confirmed?: boolean;
}

export type ClientMessage =
  | { type: "open"; role: "a" | "b"; join_secret: string }
  | { type: "handshake"; payload: unknown }
  | { type: "confirmed" }
  | { type: "msg"; payload: unknown }
  | { type: "close" };

export type ServerMessage =
  | { type: "peer_joined" }
  | { type: "ready" }
  | { type: "peer_left" }
  | { type: "error"; error: string };
