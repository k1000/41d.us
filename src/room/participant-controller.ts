import { json } from "../format";
import type { InviteState } from "../types";
import { authenticate } from "./auth";
import { joinResponse, roomInfo } from "./info";
import {
  createJoinedParticipant,
  isParticipantJoined,
  parseParticipantProfile,
  requireParticipantId,
  validateParticipantCanJoin,
  withKickedParticipant,
  withLeftParticipant,
  withUpdatedParticipant,
} from "./participants";
import type { RoomStorage } from "./storage";

export class RoomParticipantController {
  constructor(private readonly storage: RoomStorage) {}

  async join(request: Request, invite: InviteState, pathParticipantId: string): Promise<Response> {
    const body = await authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(pathParticipantId);
    if (participantId instanceof Response) return participantId;

    const participants = { ...invite.participants };
    const joinValidation = validateParticipantCanJoin(participants, participantId, invite.maxParticipants);
    if (joinValidation) return joinValidation;
    const profile = parseParticipantProfile(body);
    if (profile instanceof Response) return profile;
    participants[participantId] = createJoinedParticipant(participantId, profile);
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    await this.storage.putInvite(updated);
    return json(joinResponse(updated, participantId, invite.nextSeq));
  }

  async update(request: Request, invite: InviteState, participantIdFromPath: string): Promise<Response> {
    const body = await authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(participantIdFromPath);
    if (participantId instanceof Response) return participantId;
    const actorId = this.resolveActorId(request, participantId);
    if (actorId instanceof Response) return actorId;
    if (actorId !== participantId && actorId !== invite.hostId) return json({ error: "only participant or host can update participant status" }, 403);
    if (!isParticipantJoined(invite.participants, participantId)) return json({ error: "participant has not joined" }, 403);

    const profile = parseParticipantProfile(body);
    if (profile instanceof Response) return profile;

    const updated = withUpdatedParticipant(invite, participantId, profile);
    await this.storage.putInvite(updated);
    return json({ ok: true, participant: updated.participants[participantId] });
  }

  async delete(request: Request, invite: InviteState, targetIdFromPath: string): Promise<Response> {
    const body = await authenticate(request, invite);
    if (body instanceof Response) return body;
    const targetId = requireParticipantId(targetIdFromPath);
    if (targetId instanceof Response) return targetId;
    const actorId = this.resolveActorId(request, targetId);
    if (actorId instanceof Response) return actorId;
    if (actorId === targetId) return this.leave(invite, targetId);
    return this.kick(invite, actorId, targetId);
  }

  private resolveActorId(request: Request, fallback: string): string | Response {
    return requireParticipantId(request.headers.get("x-participant-id") ?? fallback);
  }

  private async leave(invite: InviteState, participantId: string): Promise<Response> {
    await this.storage.putInvite(withLeftParticipant(invite, participantId));
    await this.storage.deleteIfEmpty();
    return json({ ok: true });
  }

  private async kick(invite: InviteState, hostId: string, targetId: string): Promise<Response> {
    const updated = withKickedParticipant(invite, hostId, targetId);
    if (updated instanceof Response) return updated;
    await this.storage.putInvite(updated);
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }
}
