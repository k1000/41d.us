import type { InviteState } from "../types";
import { activeParticipants } from "./participants";

const STATE_KEY = "invite";

export class RoomStorage {
  constructor(private readonly state: DurableObjectState) {}

  getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
  }

  async getValidInvite(): Promise<InviteState | Response> {
    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (invite.phase === "closed") return new Response("room closed", { status: 410 });
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return new Response("invite expired", { status: 410 });
    }
    return invite;
  }

  putInvite(invite: InviteState): Promise<void> {
    return this.state.storage.put(STATE_KEY, invite);
  }

  touchParticipantLastSeen(invite: InviteState, participantId: string): Promise<void> {
    const participants = { ...invite.participants };
    participants[participantId] = { ...participants[participantId], last_seen_at: new Date().toISOString() };
    return this.putInvite({ ...invite, participants } satisfies InviteState);
  }

  async deleteIfEmpty(): Promise<void> {
    const invite = await this.getInvite();
    if (invite && activeParticipants(invite.participants).length === 0) await this.state.storage.deleteAll();
  }
}
