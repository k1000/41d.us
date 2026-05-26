import { isEncryptedBody } from "@41d/sdk/crypto";

export function isOpaqueEncryptedBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return typeof (body as Record<string, unknown>).encrypted_payload === "string";
}

export function isEncryptedEnvelope(body: unknown): boolean {
  return isEncryptedBody(body) || isOpaqueEncryptedBody(body);
}
