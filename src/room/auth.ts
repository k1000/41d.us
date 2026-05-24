import { hashJoinSecret } from "../../packages/sdk/src/crypto";
import { json } from "../format";
import type { InviteState } from "../types";
import { isParticipantJoined, requireParticipantId } from "./participants";

export async function authenticate(request: Request, invite: InviteState): Promise<Record<string, unknown> | Response> {
  const body = await readJsonObject(request);
  const auth = await authorizeToken(invite, tokenFromRequest(request));
  if (auth) return auth;
  return body;
}

export async function authenticateParticipant(request: Request, invite: InviteState): Promise<{ body: Record<string, unknown>; participantId: string } | Response> {
  const body = await authenticate(request, invite);
  if (body instanceof Response) return body;
  const participantId = requireParticipantId(request.headers.get("x-participant-id"));
  if (participantId instanceof Response) return participantId;
  return { body, participantId };
}

export async function withAuth<T>(request: Request, invite: InviteState, fn: (body: Record<string, unknown>) => Promise<T>): Promise<T | Response> {
  const body = await authenticate(request, invite);
  if (body instanceof Response) return body;
  return fn(body);
}

export async function withJoinedParticipant<T>(
  request: Request,
  invite: InviteState,
  fn: (body: Record<string, unknown>, participantId: string) => Promise<T>,
): Promise<T | Response> {
  const auth = await authenticateParticipant(request, invite);
  if (auth instanceof Response) return auth;
  if (!isParticipantJoined(invite.participants, auth.participantId)) return json({ error: "participant has not joined" }, 403);
  return fn(auth.body, auth.participantId);
}

export async function requireHost(request: Request, invite: InviteState, action: string): Promise<true | Response> {
  const auth = await authenticateParticipant(request, invite);
  if (auth instanceof Response) return auth;
  if (auth.participantId !== invite.hostId) return json({ error: `only host can ${action}` }, 403);
  return true;
}

async function authorizeToken(invite: InviteState, token: string | undefined): Promise<Response | undefined> {
  if (!token) return json({ error: "authorization token is required" }, 401);
  const tokenHash = await hashJoinSecret(invite.roomId, token);
  if (tokenHash !== invite.secretHash) return json({ error: "invalid authorization token" }, 403);
  return undefined;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function tokenFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}
