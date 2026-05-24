const MAX_ID_LENGTH = 64;
export const DEFAULT_MAX_PARTICIPANTS = 16;
export const MAX_PARTICIPANTS_HARD_LIMIT = 64;
export const MAX_MESSAGES = 200;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BOARD_VALUE_BYTES = 64 * 1024;
export const INVITE_TTL_MS = 10 * 60 * 1000;
export const MIN_INVITE_TTL_MS = 60_000;
export const MAX_INVITE_TTL_MS = 3_600_000;
export const DEFAULT_EXTEND_MS = 5 * 60_000;

export function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, MAX_ID_LENGTH);
}
