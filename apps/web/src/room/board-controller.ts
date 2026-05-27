import { json } from "../format";
import type { InviteState } from "../types";
import { joinedThen, tokenAuthThen } from "./auth-context";
import {
  deleteBoardKeyData,
  deleteBoardKeysData,
  getBoard,
  getBoardKey,
  patchBoardData,
  setBoardKeyData,
} from "./board";
import type { RoomEventBus } from "./events";
import { dispatchWebhooks } from "./hooks";
import type { RoomStorage } from "./storage";

export class RoomBoardController {
  constructor(private readonly storage: RoomStorage, private readonly events: RoomEventBus) {}

  get(request: Request, invite: InviteState): Promise<Response> {
    return tokenAuthThen(invite, request, async () => getBoard(invite));
  }

  getKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return tokenAuthThen(invite, request, async () => getBoardKey(invite, keyFromPath));
  }

  setKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const result = setBoardKeyData(invite, keyFromPath, auth.body, auth.participantId);
      if (result instanceof Response) return result;
      await this.storage.patchAndSave(invite, { board: result.board });
      this.events.notifyBoard(result.key, auth.participantId);
      dispatchWebhooks({ ...invite, board: result.board }, "board", { keys: [result.key], updated_by: auth.participantId });
      return json({ ok: true, key: result.key, entry: result.entry });
    });
  }

  patch(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const result = patchBoardData(invite, auth.body, auth.participantId);
      if (result instanceof Response) return result;
      await this.storage.patchAndSave(invite, { board: result.board });
      this.events.notifyBoard(Object.keys(result.updated), auth.participantId);
      dispatchWebhooks({ ...invite, board: result.board }, "board", { keys: Object.keys(result.updated), updated_by: auth.participantId });
      return json({ ok: true, updated: result.updated, board: result.board });
    });
  }

  deleteKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const result = deleteBoardKeyData(invite, keyFromPath, auth.participantId);
      if (result instanceof Response) return result;
      await this.storage.patchAndSave(invite, { board: result.board });
      this.events.notifyBoard(result.key, auth.participantId);
      dispatchWebhooks({ ...invite, board: result.board }, "board", { keys: [result.key], updated_by: auth.participantId });
      return json({ ok: true, deleted: result.key });
    });
  }

  /** Batch delete: POST /r/:roomId/board/delete with { keys: [...] } */
  async deleteKeys(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const rawKeys = (auth.body.keys ?? []) as string[];
      if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        return json({ error: "keys must be a non-empty array" }, 400);
      }
      const result = deleteBoardKeysData(invite, rawKeys, auth.participantId);
      if (result instanceof Response) return result;
      await this.storage.patchAndSave(invite, { board: result.board });
      this.events.notifyBoard(result.keys, auth.participantId);
      dispatchWebhooks({ ...invite, board: result.board }, "board", { keys: result.keys, updated_by: auth.participantId });
      return json({ ok: true, deleted: result.keys });
    });
  }
}
