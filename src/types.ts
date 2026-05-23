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
  firstMessage?: Record<string, unknown>;
  nextSeq?: number;
  participants?: Record<string, Participant>;
  messages?: RoomMessage[];
}
