import { Validator } from "@cfworker/json-schema";
import { MAX_BOARD_VALUE_BYTES, sanitizeId } from "../constants";
import { json, type GuardResult } from "../format";
import { normalizeBoardKey, MAX_BOARD_KEY_LENGTH } from "../validation";
import type { BoardEntry, InviteState } from "../types";

const ENCODER = new TextEncoder();

function unwrapBoard(board: Record<string, BoardEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(board).map(([key, entry]) => [key, entry.value]));
}


function makeBoardEntry(value: unknown, updatedBy: string): BoardEntry | Response {
  const size = ENCODER.encode(JSON.stringify(value ?? null)).length;
  if (size > MAX_BOARD_VALUE_BYTES) {
    return json({ error: "board value too large", max_bytes: MAX_BOARD_VALUE_BYTES }, 413);
  }
  return { value: value ?? null, updated_by: updatedBy, updated_at: new Date().toISOString() };
}

export function getBoard(invite: InviteState): Response {
  return json({ board: invite.board, board_schema: invite.boardSchema ?? null });
}

export function getBoardKey(invite: InviteState, keyFromPath: string): Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const entry = invite.board[key];
  if (!entry) return json({ error: "board key not found" }, 404);
  return json({ key, entry });
}

export function setBoardKeyData(
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

export function patchBoardData(
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

export function deleteBoardKeyData(
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

export function wrapInitialBoard(
  initialBoard: Record<string, unknown> | undefined,
  updatedBy: string,
): Record<string, BoardEntry> {
  if (!initialBoard) return {};
  const board: Record<string, BoardEntry> = {};
  for (const [rawKey, value] of Object.entries(initialBoard)) {
    const key = sanitizeId(rawKey).slice(0, MAX_BOARD_KEY_LENGTH);
    if (!key) continue;
    board[key] = { value, updated_by: updatedBy, updated_at: new Date().toISOString() };
  }
  return board;
}

export function validateBoard(
  schema: Record<string, unknown> | undefined,
  board: Record<string, BoardEntry>,
): GuardResult {
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
