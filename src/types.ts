export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
}

type SessionPhase = "waiting" | "ready" | "closed";

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

type ParticipantState = "free" | "busy";

export interface Participant {
  id: string;
  joined_at: string;
  last_seen_at: string;
  state: ParticipantState;
  status: string;
  status_updated_at: string;
  model?: string;
  skills?: string[];
  left_at?: string;
}

export interface BoardEntry {
  value: unknown;
  updated_by: string;
  updated_at: string;
}

/** Payload sent to the DO's __init endpoint. Transient fields are consumed during init and never stored. */
export interface InitPayload {
  inviteId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  hostId: string;
  roomName: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  /** Consumed during init — seeded as the first RoomMessage, then discarded. */
  firstMessage?: Record<string, unknown>;
  /** Consumed during init — unwrapped into the board, then discarded. */
  initialBoard?: Record<string, unknown>;
}

export interface InviteState {
  inviteId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  hostId: string;
  roomName: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  nextSeq: number;
  participants: Record<string, Participant>;
  messages: RoomMessage[];
  board: Record<string, BoardEntry>;
}
