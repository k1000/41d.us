import { json, type GuardResult } from "../format";
import type { InviteState, Participant } from "../types";
import { normalizeState, normalizeStatus, normalizeModel, normalizeSkills } from "../validation";

interface ParticipantProfile {
  state?: "free" | "busy";
  status?: string;
  model?: string;
  skills?: string[];
}

export function validateParticipantCanJoin(participants: Record<string, Participant>, participantId: string, maxParticipants: number): GuardResult {
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
  const state = normalizeState(body.state);
  if (state instanceof Response) return state;
  const status = normalizeStatus(body.status);
  if (status instanceof Response) return status;
  const model = normalizeModel(body.model);
  if (model instanceof Response) return model;
  const skills = normalizeSkills(body.skills);
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
  return { ...invite, participants };
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
  return { ...invite, participants };
}

export function withLeftParticipant(invite: InviteState, participantId: string): InviteState {
  const participants = { ...invite.participants };
  if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
  return { ...invite, participants };
}

export function withKickedParticipant(invite: InviteState, targetId: string): InviteState | Response {
  if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);
  if (!isParticipantJoined(invite.participants, targetId)) return json({ error: "target participant is not active" }, 404);
  return withLeftParticipant(invite, targetId);
}
