import { json } from "../format";
import type { InviteState } from "../types";
import { withAuth, withJoinedParticipant } from "./auth";
import { deleteBoardKey, getBoard, getBoardKey, patchBoard, setBoardKey } from "./board";
import type { RoomEvents } from "./events";
import type { RoomStorage } from "./storage";

export class RoomBoardController {
  constructor(private readonly storage: RoomStorage, private readonly events: RoomEvents) {}

  get(request: Request, invite: InviteState): Promise<Response> {
    return withAuth(request, invite, async () => getBoard(invite));
  }

  getKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return withAuth(request, invite, async () => getBoardKey(invite, keyFromPath));
  }

  setKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return withJoinedParticipant(request, invite, async (body, participantId) => {
      const result = setBoardKey(invite, keyFromPath, body, participantId);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(result.key, participantId);
      return json({ ok: true, key: result.key, entry: result.entry });
    });
  }

  patch(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, async (body, participantId) => {
      const result = patchBoard(invite, body, participantId);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(Object.keys(result.updated), participantId);
      return json({ ok: true, updated: result.updated, board: result.board });
    });
  }

  deleteKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return withJoinedParticipant(request, invite, async (_body, participantId) => {
      const result = deleteBoardKey(invite, keyFromPath);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(result.key, participantId);
      return json({ ok: true, deleted: result.key });
    });
  }
}
