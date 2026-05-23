export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
}

export type SessionPhase = "waiting" | "ready" | "closed";

export interface InviteState {
  inviteId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
}

export interface SocketAttachment {
  participantId?: string;
  opened?: boolean;
}

export type AgentRole = "a" | "b";

export type ClientMessage =
  | { type: "open"; role?: AgentRole; participant_id?: string; name?: string; join_secret: string }
  | { type: "handshake"; payload: unknown }
  | { type: "confirmed" }
  | { type: "msg"; id?: string; reply_to?: string | null; payload: unknown }
  | { type: "close" };

export type ServerMessage =
  | { type: "peer_joined"; participant_id?: string; count?: number }
  | { type: "ready"; participant_id?: string; count?: number }
  | { type: "peer_left"; participant_id?: string; count?: number }
  | { type: "error"; error: string }
  | { type: "handshake"; from: string; payload: unknown }
  | { type: "msg"; id: string; from: string; reply_to: string | null; payload: unknown };
