import { json } from "../format";
import type { InviteState, Participant } from "../types";
import { sanitizeId } from "../constants";

interface ParticipantProfile {
  state?: "free" | "busy";
  status?: string;
  model?: string;
  skills?: string[];
}

export function validateParticipantCanJoin(participants: Record<string, Participant>, participantId: string, maxParticipants: number): Response | undefined {
  if (participants[participantId] && !participants[participantId].left_at) {
    return json({ error: "participant_id already joined" }, 409);
  }
  if (!participants[participantId] && activeParticipants(participants).length >= maxParticipants) {
    return json({ error: "room is full", max_participants: maxParticipants }, 409);
  }
  return undefined;
}

export function activeParticipants(participants: Record<string, Participant>): Participant[] {
  return Object.values(participants).filter((p) => !p.left_at);
}

export function isParticipantJoined(participants: Record<string, Participant>, participantId: string): boolean {
  const participant = participants[participantId];
  return !!participant && !participant.left_at;
}

export function parseParticipantProfile(body: Record<string, unknown>): ParticipantProfile | Response {
  const state = normalizeParticipantState(body.state);
  if (state instanceof Response) return state;
  const status = normalizeParticipantStatus(body.status);
  if (status instanceof Response) return status;
  const model = normalizeParticipantModel(body.model);
  if (model instanceof Response) return model;
  const skills = normalizeParticipantSkills(body.skills);
  if (skills instanceof Response) return skills;
  return { state, status, model, skills };
}

export function createJoinedParticipant(participantId: string, profile: ParticipantProfile): Participant {
  const now = new Date().toISOString();
  return {
    id: participantId,
    joined_at: now,
    last_seen_at: now,
    last_read_seq: 0,
    state: "free",
    status: "joined",
    status_updated_at: now,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.skills ? { skills: profile.skills } : {}),
  };
}

function updateParticipantProfile(participant: Participant, profile: ParticipantProfile): Participant {
  const now = new Date().toISOString();
  return {
    ...participant,
    state: profile.state ?? participant.state ?? "free",
    status: profile.status ?? participant.status ?? "joined",
    status_updated_at: now,
    last_seen_at: now,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.skills !== undefined ? { skills: profile.skills } : {}),
  };
}

export function withUpdatedParticipant(invite: InviteState, participantId: string, profile: ParticipantProfile): InviteState {
  const participants = { ...invite.participants };
  participants[participantId] = updateParticipantProfile(participants[participantId], profile);
  return { ...invite, participants } satisfies InviteState;
}

export function withReadReceipt(invite: InviteState, participantId: string, seq: number): InviteState {
  const participant = invite.participants[participantId];
  if (!participant) return invite;
  const now = new Date().toISOString();
  const participants = { ...invite.participants };
  participants[participantId] = {
    ...participant,
    last_seen_at: now,
    last_read_seq: Math.max(participant.last_read_seq, seq),
  };
  return { ...invite, participants } satisfies InviteState;
}

export function withLeftParticipant(invite: InviteState, participantId: string): InviteState {
  const participants = { ...invite.participants };
  if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
  return { ...invite, participants } satisfies InviteState;
}

export function withKickedParticipant(invite: InviteState, hostId: string, targetId: string): InviteState | Response {
  if (hostId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
  if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);
  if (!isParticipantJoined(invite.participants, targetId)) return json({ error: "target participant is not active" }, 404);
  return withLeftParticipant(invite, targetId);
}

export function requireParticipantId(value: unknown): string | Response {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return json({ error: "participant_id is required" }, 400);
  return sanitizeId(id);
}

function normalizeParticipantState(value: unknown): "free" | "busy" | undefined | Response {
  if (value === undefined) return undefined;
  if (value === "free" || value === "busy") return value;
  return json({ error: "state must be 'free' or 'busy'" }, 400);
}

function normalizeParticipantStatus(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "status must be a string" }, 400);
  return value.trim().slice(0, 240);
}

function normalizeParticipantModel(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "model must be a string" }, 400);
  const model = value.trim().slice(0, 120);
  return model || undefined;
}

function normalizeParticipantSkills(value: unknown): string[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return json({ error: "skills must be an array of strings" }, 400);
  const skills = value
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 32);
  return [...new Set(skills)];
}
