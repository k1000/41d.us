import { json } from "../format";
import type { InviteState } from "../types";
import { isParticipantJoined } from "./participants";
import { normalizeParticipantId } from "../validation";
import { hashJoinSecret } from "@41d/sdk/crypto";

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return {};
  const text = await request.clone().text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { return {}; }
}

export interface ParsedRequest {
  body: Record<string, unknown>;
  token: string | undefined;
  participantId: string | undefined; // from x-participant-id header
}

export async function parseRequest(request: Request): Promise<ParsedRequest> {
  const body = await readJsonObject(request);
  const token = tokenFromRequest(request);
  const participantId = request.headers.get("x-participant-id") ?? undefined;
  return { body, token, participantId };
}

function tokenFromRequest(request: Request): string | undefined {
  const auth = request.headers.get("authorization") ?? "";
  return auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

export interface AuthSuccess {
  ok: true;
  body: Record<string, unknown>;
  participantId: string;
}

export type AuthResult = AuthSuccess | Response;

/** Validate bearer token only (for read-only endpoints). */
export async function authenticate(invite: InviteState, parsed: ParsedRequest): Promise<Response | undefined> {
  if (!parsed.token) return json({ error: "authorization token is required" }, 401);
  const hash = await hashJoinSecret(invite.roomId, parsed.token);
  if (hash !== invite.secretHash) return json({ error: "invalid authorization token" }, 403);
  return undefined;
}

/**
 * Validate bearer token + extract participant ID.
 * Falls back to `fallbackId` when the x-participant-id header is absent.
 * This preserves the original behavior where DELETE/PATCH on /participants/:id
 * uses the path ID as the actor when no explicit header is sent.
 */
export async function authenticateParticipant(
  invite: InviteState,
  parsed: ParsedRequest,
  fallbackId?: string,
): Promise<AuthResult> {
  const tokenErr = await authenticate(invite, parsed);
  if (tokenErr) return tokenErr;
  const raw = parsed.participantId ?? fallbackId ?? null;
  const pidResult = normalizeParticipantId(raw);
  if (pidResult instanceof Response) return pidResult;
  return { ok: true, body: parsed.body, participantId: pidResult };
}

/** Assert the authenticated participant has joined the room. */
export async function requireJoined(
  invite: InviteState,
  auth: AuthResult,
): Promise<AuthResult> {
  if (auth instanceof Response) return auth;
  if (!isParticipantJoined(invite.participants, auth.participantId)) {
    return json({ error: "participant has not joined" }, 403);
  }
  return auth;
}

/** Validate bearer token only (for read-only endpoints), then run fn. */
export async function tokenAuthThen(
  invite: InviteState,
  request: Request,
  fn: () => Promise<Response>,
): Promise<Response> {
  const parsed = await parseRequest(request);
  const err = await authenticate(invite, parsed);
  if (err) return err;
  return fn();
}

/** Validate token + participant ID, require joined, then run fn with the auth result. */
export async function joinedThen(
  invite: InviteState,
  request: Request,
  fn: (auth: AuthSuccess) => Promise<Response>,
): Promise<Response> {
  const parsed = await parseRequest(request);
  const auth = await authenticateParticipant(invite, parsed);
  const joined = await requireJoined(invite, auth);
  if (joined instanceof Response) return joined;
  return fn(joined);
}
