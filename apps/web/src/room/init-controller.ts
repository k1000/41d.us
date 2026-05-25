import { json } from "../format";
import type { InitPayload, InviteState } from "../types";
import { validateBoard, wrapInitialBoard } from "./board";
import { createInitialMessage } from "./messages";
import { createJoinedParticipant } from "./participants";
import type { RoomStorage } from "./storage";

export class RoomInitController {
  constructor(private readonly storage: RoomStorage) {}

  async init(request: Request): Promise<Response> {
    const body = (await request.json()) as InitPayload;
    const existing = await this.storage.getInvite();
    const initState = this.buildState(body, existing);
    if (initState instanceof Response) return initState;
    await this.storage.putInvite(initState);
    await this.storage.scheduleCleanup(body.expiresAt);
    return json({ ok: true });
  }

  private buildState(
    body: InitPayload,
    existing: InviteState | undefined,
  ): InviteState | Response {
    if (existing && existing.phase !== "closed") {
      return json({ error: "invite already exists" }, 409);
    }
    const firstMessage = body.firstMessage ? [createInitialMessage(body)] : [];
    const board = wrapInitialBoard(body.initialBoard, body.hostId);
    const validation = validateBoard(body.boardSchema, board);
    if (validation) return validation;

    // Auto-join the host when hostPublicKey is provided.
    const participants: Record<string, import("../types").Participant> = {};
    if (body.hostPublicKey) {
      participants[body.hostId] = createJoinedParticipant(body.hostId, {
        public_key: body.hostPublicKey,
        model: body.hostModel,
      });
    }

    const { initialBoard: _ib, firstMessage: _fm, hostPublicKey: _hpk, hostModel: _hm, ...stateToStore } = body;
    return {
      ...stateToStore,
      nextSeq: firstMessage.length,
      participants,
      messages: firstMessage,
      board,
    } satisfies InviteState;
  }
}
