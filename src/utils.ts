import { MAX_ID_LENGTH } from "./constants";

export function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, MAX_ID_LENGTH);
}
