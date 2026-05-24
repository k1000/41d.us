import { json } from "../format";
import type { InviteState } from "../types";
import { withJoinedParticipant } from "./auth";
import type { RoomEvents } from "./events";
import { buildReadResponse, createSentMessage, isReadableMessage, parseReadOptions } from "./messages";
import { withReadReceipt } from "./participants";
import { patchInviteState, type RoomStorage } from "./storage";

export class RoomMessageController {
  constructor(
    private readonly storage: RoomStorage,
    private readonly events: RoomEvents,
  ) {}

  async send(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, (body, participantId) =>
      this.sendMessage(body, participantId, invite),
    );
  }

  private async sendMessage(
    body: Record<string, unknown>,
    participantId: string,
    invite: InviteState,
  ): Promise<Response> {
    const result = createSentMessage(body, participantId, invite);
    if (result instanceof Response) return result;
    await this.storage.putInvite(
      patchInviteState(invite, { nextSeq: result.seq, messages: result.messages }),
    );
    this.events.notifyMessage(result.message, result.seq);
    return json({ ok: true, id: result.message.id, seq: result.seq });
  }

  async read(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, (body, participantId) =>
      this.readMessages(request, body, participantId, invite),
    );
  }

  private async readMessages(
    request: Request,
    body: Record<string, unknown>,
    participantId: string,
    invite: InviteState,
  ): Promise<Response> {
    const readOptions = parseReadOptions(request, body, invite, participantId);
    const messages = invite.messages.filter((msg) =>
      isReadableMessage(msg, participantId, readOptions),
    );
    const updated = withReadReceipt(invite, participantId, invite.nextSeq);
    await this.storage.putInvite(updated);
    return json(buildReadResponse(updated, participantId, messages, readOptions));
  }
}
