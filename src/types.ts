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

export type AgentRole = "a" | "b";

export type ClientMessage =
  | { type: "open"; role: AgentRole; join_secret: string }
  | { type: "handshake"; payload: unknown }
  | { type: "confirmed" }
  | { type: "msg"; id?: string; reply_to?: string | null; payload: unknown }
  | { type: "close" };

export type ServerMessage =
  | { type: "peer_joined" }
  | { type: "ready" }
  | { type: "peer_left" }
  | { type: "error"; error: string }
  | { type: "handshake"; from: AgentRole; payload: unknown }
  | { type: "msg"; id: string; from: AgentRole; reply_to: string | null; payload: unknown };
