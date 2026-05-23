export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
}

export type SessionPhase = "waiting" | "ready" | "closed";

export type Recipient = "all" | string | string[];

export interface RoomMessage {
  id: string;
  seq: number;
  from: string;
  to: Recipient;
  reply_to: string | null;
  intent: string;
  priority: string;
  body: unknown;
  created_at: string;
}

export interface Participant {
  id: string;
  joined_at: string;
  last_seen_at: string;
  left_at?: string;
}

export interface InviteState {
  inviteId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  nextSeq?: number;
  participants?: Record<string, Participant>;
  messages?: RoomMessage[];
}

export interface SocketAttachment {
  participantId?: string;
  opened?: boolean;
}

export type AgentRole = "a" | "b";

export type ClientMessage =
  | { type: "open"; role?: AgentRole; participant_id?: string; name?: string; join_secret?: string; admission_token?: string }
  | { type: "handshake"; payload: unknown }
  | { type: "confirmed" }
  | { type: "msg"; id?: string; reply_to?: string | null; payload?: unknown; body?: unknown; to?: Recipient }
  | { type: "close" };

export type ServerMessage =
  | { type: "peer_joined"; participant_id?: string; count?: number }
  | { type: "ready"; participant_id?: string; count?: number }
  | { type: "peer_left"; participant_id?: string; count?: number }
  | { type: "error"; error: string }
  | { type: "handshake"; from: string; payload: unknown }
  | { type: "msg"; id: string; from: string; reply_to: string | null; payload?: unknown; body?: unknown };
