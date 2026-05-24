import { json } from "../format";
import type { InviteState } from "../types";
import { joinedThen } from "./auth-context";
import type { RoomEventBus } from "./events";
import { buildReadResponse, createSentMessage, isReadableMessage, parseReadOptions } from "./messages";
import { withReadReceipt } from "./participants";
import type { RoomStorage } from "./storage";

export class RoomMessageController {
  constructor(
    private readonly storage: RoomStorage,
    private readonly events: RoomEventBus,
  ) {}

  async send(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const result = createSentMessage(auth.body, auth.participantId, invite);
      if (result instanceof Response) return result;
      await this.storage.patchAndSave(invite, { nextSeq: result.seq, messages: result.messages });
      this.events.notifyMessage(result.message, result.seq);
      return json({ ok: true, id: result.message.id, seq: result.seq });
    });
  }

  async read(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const readOptions = parseReadOptions(request, auth.body, invite, auth.participantId);
      const messages = invite.messages.filter((msg) =>
        isReadableMessage(msg, auth.participantId, readOptions),
      );
      const updated = withReadReceipt(invite, auth.participantId, invite.nextSeq);
      await this.storage.putInvite(updated);
      return json(buildReadResponse(updated, auth.participantId, messages, readOptions));
    });
  }
}
