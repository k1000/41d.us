import { json } from "../format";
import type { InviteState } from "../types";
import { parseRequest, authenticate, authenticateParticipant } from "./auth-context";
import { joinResponse, roomInfo } from "./info";
import { createRoomMessage } from "./messages";
import {
  createJoinedParticipant,
  isParticipantJoined,
  parseParticipantProfile,
  validateParticipantCanJoin,
  withKickedParticipant,
  withLeftParticipant,
  withUpdatedParticipant,
} from "./participants";
import { normalizeParticipantId } from "../validation";
import type { RoomEventBus } from "./events";
import type { RoomStorage } from "./storage";

export class RoomParticipantController {
  constructor(
    private readonly storage: RoomStorage,
    private readonly events: RoomEventBus,
  ) {}

  async join(request: Request, invite: InviteState, pathParticipantId: string): Promise<Response> {
    const parsed = await parseRequest(request);
    const err = await authenticate(invite, parsed);
    if (err) return err;

    const participantId = normalizeParticipantId(pathParticipantId);
    if (participantId instanceof Response) return participantId;

    const participants = { ...invite.participants };
    const joinValidation = validateParticipantCanJoin(participants, participantId, invite.maxParticipants);
    if (joinValidation) return joinValidation;
    const profile = parseParticipantProfile(parsed.body);
    if (profile instanceof Response) return profile;
    participants[participantId] = createJoinedParticipant(participantId, profile);
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    const seq = updated.nextSeq + 1;
    const systemMessage = createRoomMessage(
      {
        body: {
          participant_id: participantId,
          room_id: updated.roomId,
          host_id: updated.hostId,
          next: "Announce your encryption key (key.exchange), sync (read) to learn peer keys, then send encrypted messages.",
        },
        intent: "participant.joined",
      },
      "system",
      "all",
      seq,
    );
    const messages = [...updated.messages, systemMessage];
    await this.storage.patchAndSave(updated, { nextSeq: seq, messages });
    this.events.notifyMessage(systemMessage, seq);
    return json(joinResponse(updated, participantId, invite.nextSeq));
  }

  async update(request: Request, invite: InviteState, participantIdFromPath: string): Promise<Response> {
    const parsed = await parseRequest(request);
    const auth = await authenticateParticipant(invite, parsed, participantIdFromPath);
    if (auth instanceof Response) return auth;
    const participantId = normalizeParticipantId(participantIdFromPath);
    if (participantId instanceof Response) return participantId;
    if (auth.participantId !== participantId && auth.participantId !== invite.hostId) {
      return json({ error: "only participant or host can update participant status" }, 403);
    }
    if (!isParticipantJoined(invite.participants, participantId)) {
      return json({ error: "participant has not joined" }, 403);
    }
    const profile = parseParticipantProfile(parsed.body);
    if (profile instanceof Response) return profile;
    const updated = withUpdatedParticipant(invite, participantId, profile);
    await this.storage.putInvite(updated);
    return json({ ok: true, participant: updated.participants[participantId] });
  }

  async delete(request: Request, invite: InviteState, targetIdFromPath: string): Promise<Response> {
    const parsed = await parseRequest(request);
    const auth = await authenticateParticipant(invite, parsed, targetIdFromPath);
    if (auth instanceof Response) return auth;
    const targetId = normalizeParticipantId(targetIdFromPath);
    if (targetId instanceof Response) return targetId;
    const actorId = auth.participantId;
    if (actorId === targetId) return this.leave(invite, targetId);
    return this.kick(invite, actorId, targetId);
  }

  private async leave(invite: InviteState, participantId: string): Promise<Response> {
    await this.storage.putInvite(withLeftParticipant(invite, participantId));
    await this.storage.deleteIfEmpty();
    return json({ ok: true });
  }

  private async kick(invite: InviteState, actorId: string, targetId: string): Promise<Response> {
    if (actorId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    const updated = withKickedParticipant(invite, targetId);
    if (updated instanceof Response) return updated;
    await this.storage.putInvite(updated);
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }
}
