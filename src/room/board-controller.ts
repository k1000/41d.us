import { Validator } from "@cfworker/json-schema";
import { MAX_BOARD_VALUE_BYTES } from "../constants";
import { json } from "../format";
import { sanitizeId } from "../constants";
import type { BoardEntry, InviteState } from "../types";
import { withAuth, withJoinedParticipant } from "./auth";
import type { RoomEvents } from "./events";
import type { RoomStorage } from "./storage";

const ENCODER = new TextEncoder();

// ── Helpers (called directly by the controller) ─────────────────

function unwrapBoard(board: Record<string, BoardEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(board).map(([key, entry]) => [key, entry.value]));
}

function normalizeBoardKey(value: unknown): string | Response {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return json({ error: "board key is required" }, 400);
  const normalized = sanitizeId(key).slice(0, 80);
  if (!normalized) return json({ error: "invalid board key" }, 400);
  return normalized;
}

function makeBoardEntry(value: unknown, updatedBy: string): BoardEntry | Response {
  const size = ENCODER.encode(JSON.stringify(value ?? null)).length;
  if (size > MAX_BOARD_VALUE_BYTES) {
    return json({ error: "board value too large", max_bytes: MAX_BOARD_VALUE_BYTES }, 413);
  }
  return { value: value ?? null, updated_by: updatedBy, updated_at: new Date().toISOString() };
}

// ── Pure data operations ────────────────────────────────────────

function getBoard(invite: InviteState): Response {
  return json({ board: invite.board, board_schema: invite.boardSchema ?? null });
}

function getBoardKey(invite: InviteState, keyFromPath: string): Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const entry = invite.board[key];
  if (!entry) return json({ error: "board key not found" }, 404);
  return json({ key, entry });
}

function setBoardKeyData(
  invite: InviteState,
  keyFromPath: string,
  value: unknown,
  updatedBy: string,
): { board: Record<string, BoardEntry>; key: string; entry: BoardEntry } | Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const entryResult = makeBoardEntry(value, updatedBy);
  if (entryResult instanceof Response) return entryResult;
  const board = { ...invite.board, [key]: entryResult };
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, key, entry: entryResult };
}

function patchBoardData(
  invite: InviteState,
  patchValues: Record<string, unknown>,
  updatedBy: string,
): { board: Record<string, BoardEntry>; updated: Record<string, BoardEntry> } | Response {
  const board = { ...invite.board };
  const updated: Record<string, BoardEntry> = {};
  for (const [rawKey, value] of Object.entries(patchValues)) {
    const key = normalizeBoardKey(rawKey);
    if (key instanceof Response) return key;
    const entryResult = makeBoardEntry(value, updatedBy);
    if (entryResult instanceof Response) return entryResult;
    board[key] = entryResult;
    updated[key] = entryResult;
  }
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, updated };
}

function deleteBoardKeyData(
  invite: InviteState,
  keyFromPath: string,
): { board: Record<string, BoardEntry>; key: string } | Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const board = { ...invite.board };
  delete board[key];
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, key };
}

// ── Exported for init ───────────────────────────────────────────

export function wrapInitialBoard(
  initialBoard: Record<string, unknown> | undefined,
  updatedBy: string,
): Record<string, BoardEntry> {
  if (!initialBoard) return {};
  const board: Record<string, BoardEntry> = {};
  for (const [rawKey, value] of Object.entries(initialBoard)) {
    const key = sanitizeId(rawKey).slice(0, 80);
    if (!key) continue;
    board[key] = { value, updated_by: updatedBy, updated_at: new Date().toISOString() };
  }
  return board;
}

export function validateBoard(
  schema: Record<string, unknown> | undefined,
  board: Record<string, BoardEntry>,
): Response | undefined {
  if (!schema) return undefined;
  try {
    const result = new Validator(schema, "7").validate(unwrapBoard(board));
    if (result.valid) return undefined;
    return json({
      error: "board schema validation failed",
      issues: result.errors.map((issue) => ({
        path: issue.instanceLocation.replace(/^#/, "") || "/",
        message: issue.error,
        keyword: issue.keyword,
      })),
    }, 422);
  } catch (error) {
    return json({
      error: "invalid board_schema",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}

// ── Controller (auth + persistence + events) ────────────────────

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
      const result = setBoardKeyData(invite, keyFromPath, body, participantId);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(result.key, participantId);
      return json({ ok: true, key: result.key, entry: result.entry });
    });
  }

  patch(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, async (body, participantId) => {
      const result = patchBoardData(invite, body, participantId);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(Object.keys(result.updated), participantId);
      return json({ ok: true, updated: result.updated, board: result.board });
    });
  }

  deleteKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return withJoinedParticipant(request, invite, async (_body, participantId) => {
      const result = deleteBoardKeyData(invite, keyFromPath);
      if (result instanceof Response) return result;
      await this.storage.putInvite({ ...invite, board: result.board });
      this.events.notifyBoard(result.key, participantId);
      return json({ ok: true, deleted: result.key });
    });
  }
}
