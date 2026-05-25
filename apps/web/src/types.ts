import type { BoardEntry, Participant, RoomMessage, SessionPhase } from "@41d/sdk/types";
export type { BoardEntry, Participant, RoomMessage, SessionPhase } from "@41d/sdk/types";
export type { Recipient } from "@41d/sdk/types";

export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
}

/** Payload sent to the DO's __init endpoint. Transient fields are consumed during init and never stored. */
export interface InitPayload {
  roomId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  hostId: string;
  roomName: string;
  purpose: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  /** Consumed during init — seeded as the first RoomMessage, then discarded. */
  firstMessage?: Record<string, unknown>;
  /** Consumed during init — unwrapped into the board, then discarded. */
  initialBoard?: Record<string, unknown>;
}

export interface InviteState {
  roomId: string;
  secretHash: string;
  expiresAt: number;
  phase: SessionPhase;
  hostId: string;
  roomName: string;
  purpose: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  nextSeq: number;
  participants: Record<string, Participant>;
  messages: RoomMessage[];
  board: Record<string, BoardEntry>;
}
