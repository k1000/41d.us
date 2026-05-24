import { json } from "../format";
import type { InitPayload, InviteState } from "../types";
import { validateBoard, wrapInitialBoard } from "./board";
import { createInitialMessage } from "./messages";

export function buildInitialInviteState(body: InitPayload, existing: InviteState | undefined): InviteState | Response {
  if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
  const firstMessage = body.firstMessage ? [createInitialMessage(body)] : [];
  const board = wrapInitialBoard(body.initialBoard, body.hostId);
  const validation = validateBoard(body.boardSchema, board);
  if (validation) return validation;
  const { initialBoard: _ib, firstMessage: _fm, ...stateToStore } = body;
  return { ...stateToStore, nextSeq: firstMessage.length, participants: {}, messages: firstMessage, board } satisfies InviteState;
}
