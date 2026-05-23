import { DEFAULT_MAX_PARTICIPANTS, MAX_BOARD_VALUE_BYTES, MAX_BODY_BYTES, MAX_MESSAGES } from "./constants";
import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import type { BoardEntry, Env, InviteState, Participant, Recipient, RoomMessage } from "./types";
import { sanitizeId } from "./utils";

const STATE_KEY = "invite";
const SSE_HEARTBEAT_MS = 25_000;
const SSE_ENCODER = new TextEncoder();

interface EventSubscriber {
  participantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  includeSelf: boolean;
}

export class RendezvousSession {
  private readonly eventSubscribers = new Map<string, EventSubscriber>();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      const body = (await request.json()) as InviteState;
      const existing = await this.getInvite();
      if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
      const firstMessage = body.firstMessage ? [{
        id: crypto.randomUUID(),
        seq: 1,
        from: body.hostId ?? "host",
        to: "all" as const,
        reply_to: null,
        intent: "room_purpose",
        priority: "normal",
        body: body.firstMessage,
        created_at: new Date().toISOString(),
      }] : [];
      await this.state.storage.put(STATE_KEY, { ...body, nextSeq: firstMessage.length, participants: {}, messages: firstMessage } satisfies InviteState);
      return json({ ok: true });
    }

    const invite = await this.getValidInvite();
    if (invite instanceof Response) return invite;

    if (isRoomRoot(url, invite.inviteId) && request.method === "GET" && request.headers.has("authorization")) return this.handleRead(request, invite);
    if (isRoomRoot(url, invite.inviteId) && request.method === "POST") return this.handleSend(request, invite);
    if (isRoomRoot(url, invite.inviteId) && request.method === "DELETE") return this.handleClose(request, invite);

    if (url.pathname.match(/\/board\/[^/]+$/) && request.method === "GET") return this.handleGetBoardKey(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/board\/[^/]+$/) && request.method === "PUT") return this.handleSetBoardKey(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/board\/[^/]+$/) && request.method === "DELETE") return this.handleDeleteBoardKey(request, invite, pathLastSegment(url));
    if (url.pathname.endsWith("/board") && request.method === "GET") return this.handleGetBoard(request, invite);
    if (url.pathname.endsWith("/board") && request.method === "PATCH") return this.handlePatchBoard(request, invite);

    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "PUT") return this.handleJoin(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "PATCH") return this.handleUpdateParticipant(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "DELETE") return this.handleDeleteParticipant(request, invite, pathLastSegment(url));
    if (url.pathname.endsWith("/participants") && request.method === "GET") return this.handleParticipants(request, invite);
    if (url.pathname.endsWith("/status") && request.method === "GET") return this.handleStatus(request, invite);
    if (url.pathname.endsWith("/events") && request.method === "GET") return this.handleEvents(request, invite);

    if (url.pathname.endsWith("/join") && request.method === "POST") return this.handleJoin(request, invite);
    if (url.pathname.endsWith("/messages") && request.method === "POST") return this.handleSend(request, invite);
    if (url.pathname.endsWith("/messages/read") && request.method === "POST") return this.handleRead(request, invite);
    if (url.pathname.endsWith("/participants") && request.method === "POST") return this.handleParticipants(request, invite);
    if (url.pathname.endsWith("/status") && request.method === "POST") return this.handleStatus(request, invite);
    if (url.pathname.endsWith("/kick") && request.method === "POST") return this.handleKick(request, invite);
    if (url.pathname.endsWith("/close") && request.method === "POST") return this.handleClose(request, invite);
    if (url.pathname.endsWith("/leave") && request.method === "POST") return this.handleLeave(request, invite);

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket transport has been removed. Use the collab space.", { status: 410 });
    }

    const roomUrl = httpRoomUrl(request);
    return respondNegotiated(
      request,
      () => inviteInstructionsPage(invite.inviteId, roomUrl),
      () => inviteInstructionsMarkdown(invite.inviteId, roomUrl),
    );
  }

  // ── Auth helpers ──────────────────────────────────────────────

  private async authenticate(request: Request, invite: InviteState): Promise<Record<string, unknown> | Response> {
    const body = await readJsonObject(request);
    const auth = await this.authorizeToken(invite, tokenFromRequest(request, body));
    if (auth) return auth;
    return body;
  }

  private async authorizeToken(invite: InviteState, token: string | undefined): Promise<Response | undefined> {
    if (!token) return json({ error: "admission_token is required" }, 401);
    const tokenHash = await hashJoinSecret(invite.inviteId, token);
    if (tokenHash !== invite.secretHash) return json({ error: "invalid admission_token" }, 403);
    return undefined;
  }

  /**
   * Authenticate and require a valid participant_id.
   * Returns body + participantId, or an error Response.
   */
  private async authenticateParticipant(request: Request, invite: InviteState): Promise<{ body: Record<string, unknown>; participantId: string } | Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(body.participant_id ?? request.headers.get("x-participant-id"));
    if (participantId instanceof Response) return participantId;
    return { body, participantId };
  }

  private async authenticatePathParticipant(request: Request, invite: InviteState, pathParticipantId: string): Promise<{ body: Record<string, unknown>; participantId: string } | Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(pathParticipantId);
    if (participantId instanceof Response) return participantId;
    return { body, participantId };
  }

  // ── Handlers ──────────────────────────────────────────────────

  private async handleJoin(request: Request, invite: InviteState, pathParticipantId?: string): Promise<Response> {
    const auth = pathParticipantId
      ? await this.authenticatePathParticipant(request, invite, pathParticipantId)
      : await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId } = auth;

    const participants = invite.participants ?? {};
    if (!participants[participantId] && this.activeCount(participants) >= (invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS)) {
      return json({ error: "room is full", max_participants: invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS }, 409);
    }
    if (participants[participantId] && !participants[participantId].left_at) return json({ error: "participant_id already joined" }, 409);
    const now = new Date().toISOString();
    const model = normalizeParticipantModel(auth.body.model);
    if (model instanceof Response) return model;
    const skills = normalizeParticipantSkills(auth.body.skills);
    if (skills instanceof Response) return skills;
    participants[participantId] = { id: participantId, joined_at: now, last_seen_at: now, state: "free", status: "joined", status_updated_at: now, ...(model ? { model } : {}), ...(skills ? { skills } : {}) };
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, room: roomInfo(updated), participant_id: participantId, is_host: participantId === invite.hostId, cursor: invite.nextSeq ?? 0, message: "Joined. Sync with GET room_url?after=N and send with POST room_url." });
  }

  private async handleSend(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;

    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    if (new TextEncoder().encode(JSON.stringify(body.body ?? {})).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
    const to: Recipient = (body.to as Recipient) ?? "all";
    if (!this.validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
    const seq = (invite.nextSeq ?? 0) + 1;
    const message: RoomMessage = {
      id: crypto.randomUUID(),
      seq,
      from: participantId,
      to,
      reply_to: (body.reply_to as string) ?? null,
      intent: (body.intent as string) ?? "notify",
      priority: (body.priority as string) ?? "normal",
      body: (body.body as unknown) ?? {},
      created_at: new Date().toISOString(),
    };
    const messages = [...(invite.messages ?? []), message].slice(-MAX_MESSAGES);
    await this.state.storage.put(STATE_KEY, { ...invite, nextSeq: seq, messages } satisfies InviteState);
    this.notifyMessage(message, seq);
    return json({ ok: true, id: message.id, seq });
  }

  private async handleRead(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;

    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const after = Number(body.after ?? new URL(request.url).searchParams.get("after") ?? 0);
    const includeSelf = !!body.include_self || new URL(request.url).searchParams.get("include_self") === "true";
    const messages = (invite.messages ?? []).filter((msg) => msg.seq > after && (includeSelf || msg.from !== participantId) && this.visibleTo(msg, participantId));
    const participants = invite.participants ?? {};
    participants[participantId] = { ...participants[participantId], last_seen_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    return json({
      participant_id: participantId,
      cursor: invite.nextSeq ?? 0,
      oldest_seq: (invite.messages ?? [])[0]?.seq ?? 0,
      retention: { max_messages: MAX_MESSAGES },
      messages,
    });
  }

  private async handleEvents(request: Request, invite: InviteState): Promise<Response> {
    const url = new URL(request.url);
    const auth = await this.authorizeToken(invite, tokenFromRequest(request, {}));
    if (auth) return auth;
    const participantResult = requireParticipantId(url.searchParams.get("participant_id") ?? request.headers.get("x-participant-id"));
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const includeSelf = url.searchParams.get("include_self") === "true";

    let interval: ReturnType<typeof setInterval> | undefined;
    let subscriberId = "";
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = crypto.randomUUID();
        this.eventSubscribers.set(subscriberId, { participantId, controller, includeSelf });
        enqueueSse(controller, "ready", { participant_id: participantId, last_seq: invite.nextSeq ?? 0 });
        interval = setInterval(() => enqueueSse(controller, "ping", { ts: new Date().toISOString() }), SSE_HEARTBEAT_MS);
      },
      cancel: () => {
        if (interval) clearInterval(interval);
        this.eventSubscribers.delete(subscriberId);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  private async handleParticipants(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    return json({ room: roomInfo(invite), participants: this.activeParticipants(invite) });
  }

  private async handleGetBoard(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    return json({ room: roomInfo(invite), board: invite.board ?? {} });
  }

  private async handleGetBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    const key = normalizeBoardKey(keyFromPath);
    if (key instanceof Response) return key;
    const entry = invite.board?.[key];
    if (!entry) return json({ error: "board key not found" }, 404);
    return json({ key, entry });
  }

  private async handleSetBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const key = normalizeBoardKey(keyFromPath);
    if (key instanceof Response) return key;
    const entryResult = makeBoardEntry(body, participantId);
    if (entryResult instanceof Response) return entryResult;
    const board = { ...(invite.board ?? {}), [key]: entryResult };
    await this.state.storage.put(STATE_KEY, { ...invite, board } satisfies InviteState);
    this.notifyBoard(key, participantId);
    return json({ ok: true, key, entry: entryResult });
  }

  private async handlePatchBoard(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId } = auth;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const board = { ...(invite.board ?? {}) };
    const updated: Record<string, BoardEntry> = {};
    for (const [rawKey, value] of Object.entries(body)) {
      const key = normalizeBoardKey(rawKey);
      if (key instanceof Response) return key;
      const entryResult = makeBoardEntry(value, participantId);
      if (entryResult instanceof Response) return entryResult;
      board[key] = entryResult;
      updated[key] = entryResult;
    }
    await this.state.storage.put(STATE_KEY, { ...invite, board } satisfies InviteState);
    this.notifyBoard(Object.keys(updated), participantId);
    return json({ ok: true, updated, board });
  }

  private async handleDeleteBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId } = auth;
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);
    const key = normalizeBoardKey(keyFromPath);
    if (key instanceof Response) return key;
    const board = { ...(invite.board ?? {}) };
    delete board[key];
    await this.state.storage.put(STATE_KEY, { ...invite, board } satisfies InviteState);
    this.notifyBoard(key, participantId);
    return json({ ok: true, deleted: key });
  }

  private async handleStatus(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticate(request, invite);
    if (auth instanceof Response) return auth;
    return json({
      ...this.buildStatus(invite),
      closed: invite.phase === "closed",
    });
  }

  private async handleLeave(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId } = auth;
    return this.leaveParticipant(invite, participantId);
  }

  private async handleUpdateParticipant(request: Request, invite: InviteState, participantIdFromPath: string): Promise<Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantResult = requireParticipantId(participantIdFromPath);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult as string;
    const actorResult = requireParticipantId(body.participant_id ?? request.headers.get("x-participant-id") ?? participantId);
    if (actorResult instanceof Response) return actorResult;
    const actorId = actorResult as string;
    if (actorId !== participantId && actorId !== invite.hostId) return json({ error: "only participant or host can update participant status" }, 403);
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);

    const state = normalizeParticipantState(body.state);
    if (state instanceof Response) return state;
    const status = normalizeParticipantStatus(body.status);
    if (status instanceof Response) return status;
    const model = normalizeParticipantModel(body.model);
    if (model instanceof Response) return model;
    const skills = normalizeParticipantSkills(body.skills);
    if (skills instanceof Response) return skills;

    const now = new Date().toISOString();
    const participants = { ...invite.participants };
    participants[participantId] = {
      ...participants[participantId],
      state: state ?? participants[participantId].state ?? "free",
      status: status ?? participants[participantId].status ?? "joined",
      status_updated_at: now,
      last_seen_at: now,
      ...(model !== undefined ? { model } : {}),
      ...(skills !== undefined ? { skills } : {}),
    };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    return json({ ok: true, participant: participants[participantId] });
  }

  private async handleDeleteParticipant(request: Request, invite: InviteState, targetIdFromPath: string): Promise<Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const targetResult = requireParticipantId(targetIdFromPath);
    if (targetResult instanceof Response) return targetResult;
    const targetId = targetResult as string;
    const actorResult = requireParticipantId(body.participant_id ?? request.headers.get("x-participant-id") ?? targetId);
    if (actorResult instanceof Response) return actorResult;
    const actorId = actorResult as string;
    if (actorId === targetId) return this.leaveParticipant(invite, targetId);
    return this.kickParticipant(invite, actorId, targetId);
  }

  private async handleKick(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { body, participantId: hostId } = auth;

    const targetResult = requireParticipantId(body.target_id);
    if (targetResult instanceof Response) return json({ error: "target_id is required" }, 400);
    const targetId = targetResult as string;

    return this.kickParticipant(invite, hostId, targetId);
  }

  private async handleClose(request: Request, invite: InviteState): Promise<Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const { participantId: hostId } = auth;

    if (hostId !== invite.hostId) return json({ error: "only host can close room" }, 403);
    await this.state.storage.put(STATE_KEY, { ...invite, phase: "closed" } satisfies InviteState);
    return json({ ok: true, closed: true });
  }

  // ── Domain helpers ────────────────────────────────────────────

  private async leaveParticipant(invite: InviteState, participantId: string): Promise<Response> {
    const participants = { ...invite.participants };
    if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    await this.maybeDeleteEmptyRoom();
    return json({ ok: true });
  }

  private async kickParticipant(invite: InviteState, hostId: string, targetId: string): Promise<Response> {
    if (hostId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);

    const participants = { ...invite.participants };
    if (!participants[targetId] || participants[targetId].left_at) return json({ error: "target participant is not active" }, 404);
    participants[targetId] = { ...participants[targetId], left_at: new Date().toISOString() };
    const updated = { ...invite, participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }

  private notifyMessage(message: RoomMessage, lastSeq: number): void {
    for (const [id, subscriber] of this.eventSubscribers) {
      if (!subscriber.includeSelf && message.from === subscriber.participantId) continue;
      if (!this.visibleTo(message, subscriber.participantId)) continue;
      try {
        enqueueSse(subscriber.controller, "changed", { last_seq: lastSeq });
      } catch {
        this.eventSubscribers.delete(id);
      }
    }
  }

  private notifyBoard(keys: string | string[], updatedBy: string): void {
    for (const [id, subscriber] of this.eventSubscribers) {
      try {
        enqueueSse(subscriber.controller, "board", { keys: Array.isArray(keys) ? keys : [keys], updated_by: updatedBy });
      } catch {
        this.eventSubscribers.delete(id);
      }
    }
  }

  private activeCount(participants: Record<string, Participant>): number {
    return Object.values(participants).filter((p) => !p.left_at).length;
  }

  private activeParticipants(invite: InviteState): Participant[] {
    return Object.values(invite.participants ?? {}).filter((p) => !p.left_at);
  }

  private buildStatus(invite: InviteState) {
    return {
      room: roomInfo(invite),
      participants: this.activeParticipants(invite),
      message_count: invite.messages?.length ?? 0,
      last_seq: invite.nextSeq ?? 0,
      oldest_seq: (invite.messages ?? [])[0]?.seq ?? 0,
      expires_at: new Date(invite.expiresAt).toISOString(),
    };
  }

  private isJoined(invite: InviteState, participantId: string): boolean {
    const participant = invite.participants?.[participantId];
    return !!participant && !participant.left_at;
  }

  private validRecipient(invite: InviteState, to: Recipient): boolean {
    if (to === "all") return true;
    const recipients = Array.isArray(to) ? to : [to];
    return recipients.every((id) => this.isJoined(invite, id));
  }

  private visibleTo(message: RoomMessage, participantId: string): boolean {
    if (message.to === "all") return true;
    if (Array.isArray(message.to)) return message.to.includes(participantId);
    return message.to === participantId;
  }

  // ── Storage ────────────────────────────────────────────────────

  private async getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
  }

  private async getValidInvite(): Promise<InviteState | Response> {
    const invite = await this.getInvite();
    if (!invite) return new Response("invite not found", { status: 404 });
    if (invite.phase === "closed") return new Response("room closed", { status: 410 });
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return new Response("invite expired", { status: 410 });
    }
    return invite;
  }

  private async maybeDeleteEmptyRoom(): Promise<void> {
    const invite = await this.getInvite();
    if (!invite) return;
    if (!Object.values(invite.participants ?? {}).some((p) => !p.left_at)) {
      await this.state.storage.deleteAll();
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function tokenFromRequest(request: Request, body: Record<string, unknown>): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const url = new URL(request.url);
  return (body.admission_token ?? body.join_secret ?? url.searchParams.get("admission_token") ?? url.searchParams.get("join_secret")) as string | undefined;
}

function isRoomRoot(url: URL, inviteId: string): boolean {
  return url.pathname.replace(/\/$/, "") === `/r/${inviteId}`;
}

function pathLastSegment(url: URL): string {
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
}

function roomInfo(invite: InviteState) {
  return {
    invite_id: invite.inviteId,
    name: invite.roomName ?? "41d rendezvous",
    host_id: invite.hostId ?? "host",
    max_participants: invite.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
  };
}

function normalizeBoardKey(value: unknown): string | Response {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) return json({ error: "board key is required" }, 400);
  const normalized = sanitizeId(key).slice(0, 80);
  if (!normalized) return json({ error: "invalid board key" }, 400);
  return normalized;
}

function makeBoardEntry(value: unknown, updatedBy: string): BoardEntry | Response {
  const size = new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  if (size > MAX_BOARD_VALUE_BYTES) return json({ error: "board value too large", max_bytes: MAX_BOARD_VALUE_BYTES }, 413);
  return { value: value ?? null, updated_by: updatedBy, updated_at: new Date().toISOString() };
}

function normalizeParticipantState(value: unknown): "free" | "busy" | undefined | Response {
  if (value === undefined) return undefined;
  if (value === "free" || value === "busy") return value;
  return json({ error: "state must be 'free' or 'busy'" }, 400);
}

function normalizeParticipantStatus(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "status must be a string" }, 400);
  return value.trim().slice(0, 240);
}

function normalizeParticipantModel(value: unknown): string | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return json({ error: "model must be a string" }, 400);
  const model = value.trim().slice(0, 120);
  return model || undefined;
}

function normalizeParticipantSkills(value: unknown): string[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return json({ error: "skills must be an array of strings" }, 400);
  const skills = value
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 32);
  return [...new Set(skills)];
}

function requireParticipantId(value: unknown): string | Response {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return json({ error: "participant_id is required" }, 400);
  return sanitizeId(id);
}

function enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
  controller.enqueue(SSE_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function httpRoomUrl(request: Request): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.search = "";
  return url.toString();
}
