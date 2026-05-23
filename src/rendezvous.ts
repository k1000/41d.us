import { MAX_BODY_BYTES, MAX_MESSAGES } from "./constants";
import { hashJoinSecret } from "./crypto";
import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import { deleteBoardKey, getBoard, getBoardKey, patchBoard, setBoardKey, validateBoard, wrapInitialBoard } from "./room/board";
import type { Env, InitPayload, InviteState, Participant, Recipient, RoomMessage } from "./types";
import { sanitizeId } from "./utils";

const STATE_KEY = "invite";
const SSE_HEARTBEAT_MS = 25_000;
const ENCODER = new TextEncoder();

interface EventSubscriber {
  participantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  includeSelf: boolean;
}

interface ParticipantProfile {
  state?: "free" | "busy";
  status?: string;
  model?: string;
  skills?: string[];
}

interface ReadOptions {
  after: number;
  includeSelf: boolean;
}

export class RendezvousSession {
  private readonly eventSubscribers = new Map<string, EventSubscriber>();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") return this.handleInit(request);

    const invite = await this.getValidInvite();
    if (invite instanceof Response) return invite;

    const routed = this.routeRequest(request, url, invite);
    if (routed) return routed;

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

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as InitPayload;
    const existing = await this.getInvite();
    if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
    const firstMessage = body.firstMessage ? [createInitialMessage(body)] : [];
    const board = wrapInitialBoard(body.initialBoard, body.hostId);
    const validation = validateBoard(body.boardSchema, board);
    if (validation) return validation;
    // Strip transient init-only fields before storing
    const { initialBoard: _ib, firstMessage: _fm, ...stateToStore } = body;
    await this.state.storage.put(STATE_KEY, { ...stateToStore, nextSeq: firstMessage.length, participants: {}, messages: firstMessage, board } satisfies InviteState);
    return json({ ok: true });
  }

  // ── Routing helpers ───────────────────────────────────────────

  private routeRequest(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    return this.routeRoomRoot(request, url, invite)
      ?? this.routeRoomExport(request, url, invite)
      ?? this.routeBoard(request, url, invite)
      ?? this.routeParticipants(request, url, invite)
      ?? this.routeRoomMeta(request, url, invite);
  }

  private routeRoomRoot(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    if (!isRoomRoot(url, invite.inviteId)) return undefined;
    if (request.method === "GET" && request.headers.has("authorization")) return this.handleRead(request, invite);
    if (request.method === "POST") return this.handleSend(request, invite);
    if (request.method === "DELETE") return this.handleClose(request, invite);
    return undefined;
  }

  private routeRoomExport(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    if (url.pathname.endsWith("/export") && request.method === "GET") return this.handleExport(request, invite);
    return undefined;
  }

  private routeBoard(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    if (url.pathname.endsWith("/board")) {
      if (request.method === "GET") return this.handleGetBoard(request, invite);
      if (request.method === "PATCH") return this.handlePatchBoard(request, invite);
      return undefined;
    }

    const key = boardKeyFromUrl(url);
    if (!key) return undefined;
    if (request.method === "GET") return this.handleGetBoardKey(request, invite, key);
    if (request.method === "PUT") return this.handleSetBoardKey(request, invite, key);
    if (request.method === "DELETE") return this.handleDeleteBoardKey(request, invite, key);
    return undefined;
  }

  private routeParticipants(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "PUT") return this.handleJoin(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "PATCH") return this.handleUpdateParticipant(request, invite, pathLastSegment(url));
    if (url.pathname.match(/\/participants\/[^/]+$/) && request.method === "DELETE") return this.handleDeleteParticipant(request, invite, pathLastSegment(url));
    if (url.pathname.endsWith("/participants") && request.method === "GET") return this.handleParticipants(request, invite);
    return undefined;
  }

  private routeRoomMeta(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    if (url.pathname.endsWith("/status") && request.method === "GET") return this.handleStatus(request, invite);
    if (url.pathname.endsWith("/events") && request.method === "GET") return this.handleEvents(request, invite);
    return undefined;
  }

  // ── Auth helpers ──────────────────────────────────────────────

  /** Authenticate and return parsed body. Returns error Response on failure. */
  private async authenticate(request: Request, invite: InviteState): Promise<Record<string, unknown> | Response> {
    const body = await readJsonObject(request);
    const auth = await this.authorizeToken(invite, tokenFromRequest(request));
    if (auth) return auth;
    return body;
  }

  /** Authenticate + require participant_id + verify joined. Returns body and participantId. */
  private async authenticateParticipant(request: Request, invite: InviteState): Promise<{ body: Record<string, unknown>; participantId: string } | Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(request.headers.get("x-participant-id"));
    if (participantId instanceof Response) return participantId;
    return { body, participantId };
  }

  /**
   * Full participant guard: auth + joined check.
   * Calls fn(body, participantId) only if the participant is authenticated and joined.
   */
  private async withJoinedParticipant<T>(
    request: Request,
    invite: InviteState,
    fn: (body: Record<string, unknown>, participantId: string) => Promise<T>,
  ): Promise<T | Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    if (!this.isJoined(invite, auth.participantId)) {
      return json({ error: "participant has not joined" }, 403);
    }
    return fn(auth.body, auth.participantId);
  }

  private async requireHost(request: Request, invite: InviteState, action: string): Promise<true | Response> {
    const auth = await this.authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    if (auth.participantId !== invite.hostId) return json({ error: `only host can ${action}` }, 403);
    return true;
  }

  /**
   * Auth guard that only requires a valid token (no participant_id needed).
   */
  private async withAuth<T>(
    request: Request,
    invite: InviteState,
    fn: (body: Record<string, unknown>) => Promise<T>,
  ): Promise<T | Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    return fn(body);
  }

  private async authorizeToken(invite: InviteState, token: string | undefined): Promise<Response | undefined> {
    if (!token) return json({ error: "authorization token is required" }, 401);
    const tokenHash = await hashJoinSecret(invite.inviteId, token);
    if (tokenHash !== invite.secretHash) return json({ error: "invalid authorization token" }, 403);
    return undefined;
  }

  // ── Handlers ──────────────────────────────────────────────────

  private async handleJoin(request: Request, invite: InviteState, pathParticipantId: string): Promise<Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantId = requireParticipantId(pathParticipantId);
    if (participantId instanceof Response) return participantId;

    const participants = invite.participants;
    const joinValidation = validateParticipantCanJoin(participants, participantId, invite.maxParticipants);
    if (joinValidation) return joinValidation;
    const profile = parseParticipantProfile(body);
    if (profile instanceof Response) return profile;
    participants[participantId] = createJoinedParticipant(participantId, profile);
    const updated = { ...invite, phase: "ready", participants } satisfies InviteState;
    await this.state.storage.put(STATE_KEY, updated);
    return json({ ok: true, room: roomInfo(updated), participant_id: participantId, is_host: participantId === invite.hostId, cursor: invite.nextSeq, message: "Joined. Sync with GET room_url?after=N and send with POST room_url." });
  }

  private async handleSend(request: Request, invite: InviteState): Promise<Response> {
    return this.withJoinedParticipant(request, invite, (body, participantId) => this.sendMessage(body, participantId, invite));
  }

  private async sendMessage(body: Record<string, unknown>, participantId: string, invite: InviteState): Promise<Response> {
    if (ENCODER.encode(JSON.stringify(body.body ?? {})).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
    const to: Recipient = (body.to as Recipient) ?? "all";
    if (!this.validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
    const seq = invite.nextSeq + 1;
    const message = createRoomMessage(body, participantId, to, seq);
    const messages = [...invite.messages, message].slice(-MAX_MESSAGES);
    await this.state.storage.put(STATE_KEY, { ...invite, nextSeq: seq, messages } satisfies InviteState);
    this.notifyMessage(message, seq);
    return json({ ok: true, id: message.id, seq });
  }

  private async handleRead(request: Request, invite: InviteState): Promise<Response> {
    return this.withJoinedParticipant(request, invite, (body, participantId) => this.readMessages(request, body, participantId, invite));
  }

  private async readMessages(request: Request, body: Record<string, unknown>, participantId: string, invite: InviteState): Promise<Response> {
    const readOptions = parseReadOptions(request, body);
    const messages = invite.messages.filter((msg) => this.isReadableMessage(msg, participantId, readOptions));
    await this.touchParticipantLastSeen(invite, participantId);
    return json(buildReadResponse(invite, participantId, messages));
  }

  private async handleEvents(request: Request, invite: InviteState): Promise<Response> {
    const url = new URL(request.url);
    const auth = await this.authorizeToken(invite, tokenFromRequest(request));
    if (auth) return auth;
    const participantResult = requireParticipantId(request.headers.get("x-participant-id"));
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
        enqueueSse(controller, "ready", { participant_id: participantId, last_seq: invite.nextSeq });
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
    return this.withAuth(request, invite, async () =>
      json({ room: roomInfo(invite), participants: this.activeParticipants(invite) }),
    );
  }

  private async handleGetBoard(request: Request, invite: InviteState): Promise<Response> {
    return this.withAuth(request, invite, async () => getBoard(invite));
  }

  private async handleGetBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return this.withAuth(request, invite, async () => getBoardKey(invite, keyFromPath));
  }

  private async handleSetBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return this.withJoinedParticipant(request, invite, async (body, participantId) => {
      const result = setBoardKey(invite, keyFromPath, body, participantId);
      if (result instanceof Response) return result;
      await this.state.storage.put(STATE_KEY, { ...invite, board: result.board } satisfies InviteState);
      this.notifyBoard(keyFromPath, participantId);
      return json({ ok: true, key: keyFromPath, entry: result.entry });
    });
  }

  private async handlePatchBoard(request: Request, invite: InviteState): Promise<Response> {
    return this.withJoinedParticipant(request, invite, async (body, participantId) => {
      const result = patchBoard(invite, body, participantId);
      if (result instanceof Response) return result;
      await this.state.storage.put(STATE_KEY, { ...invite, board: result.board } satisfies InviteState);
      this.notifyBoard(Object.keys(result.updated), participantId);
      return json({ ok: true, updated: result.updated, board: result.board });
    });
  }

  private async handleDeleteBoardKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return this.withJoinedParticipant(request, invite, async (_body, participantId) => {
      const result = deleteBoardKey(invite, keyFromPath);
      if (result instanceof Response) return result;
      await this.state.storage.put(STATE_KEY, { ...invite, board: result.board } satisfies InviteState);
      this.notifyBoard(result.key, participantId);
      return json({ ok: true, deleted: result.key });
    });
  }

  private async handleStatus(request: Request, invite: InviteState): Promise<Response> {
    return this.withAuth(request, invite, async () =>
      json({
        ...this.buildStatus(invite),
        closed: invite.phase === "closed",
      }),
    );
  }

  private async handleUpdateParticipant(request: Request, invite: InviteState, participantIdFromPath: string): Promise<Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const participantResult = requireParticipantId(participantIdFromPath);
    if (participantResult instanceof Response) return participantResult;
    const participantId = participantResult as string;
    const actorResult = requireParticipantId(request.headers.get("x-participant-id") ?? participantId);
    if (actorResult instanceof Response) return actorResult;
    const actorId = actorResult as string;
    if (actorId !== participantId && actorId !== invite.hostId) return json({ error: "only participant or host can update participant status" }, 403);
    if (!this.isJoined(invite, participantId)) return json({ error: "participant has not joined" }, 403);

    const profile = parseParticipantProfile(body);
    if (profile instanceof Response) return profile;

    const participants = { ...invite.participants };
    participants[participantId] = updateParticipantProfile(participants[participantId], profile);
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
    return json({ ok: true, participant: participants[participantId] });
  }

  private async handleDeleteParticipant(request: Request, invite: InviteState, targetIdFromPath: string): Promise<Response> {
    const body = await this.authenticate(request, invite);
    if (body instanceof Response) return body;
    const targetResult = requireParticipantId(targetIdFromPath);
    if (targetResult instanceof Response) return targetResult;
    const targetId = targetResult as string;
    const actorResult = requireParticipantId(request.headers.get("x-participant-id") ?? targetId);
    if (actorResult instanceof Response) return actorResult;
    const actorId = actorResult as string;
    if (actorId === targetId) return this.leaveParticipant(invite, targetId);
    return this.kickParticipant(invite, actorId, targetId);
  }

  private async handleClose(request: Request, invite: InviteState): Promise<Response> {
    const hostCheck = await this.requireHost(request, invite, "close room");
    if (hostCheck instanceof Response) return hostCheck;
    await this.state.storage.put(STATE_KEY, { ...invite, phase: "closed" } satisfies InviteState);
    return json({ ok: true, closed: true });
  }

  private async handleExport(request: Request, invite: InviteState): Promise<Response> {
    const hostCheck = await this.requireHost(request, invite, "export room");
    if (hostCheck instanceof Response) return hostCheck;
    return json({
      room: roomInfo(invite),
      phase: invite.phase,
      participants: invite.participants,
      messages: invite.messages,
      board: invite.board,
      board_schema: invite.boardSchema ?? null,
      next_seq: invite.nextSeq,
      expires_at: new Date(invite.expiresAt).toISOString(),
    });
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

  private activeParticipants(invite: InviteState): Participant[] {
    return Object.values(invite.participants).filter((p) => !p.left_at);
  }

  private buildStatus(invite: InviteState) {
    return {
      room: roomInfo(invite),
      participants: this.activeParticipants(invite),
      message_count: invite.messages.length,
      last_seq: invite.nextSeq,
      oldest_seq: invite.messages[0]?.seq ?? 0,
      expires_at: new Date(invite.expiresAt).toISOString(),
    };
  }

  private isJoined(invite: InviteState, participantId: string): boolean {
    const participant = invite.participants[participantId];
    return !!participant && !participant.left_at;
  }

  private validRecipient(invite: InviteState, to: Recipient): boolean {
    if (to === "all") return true;
    const recipients = Array.isArray(to) ? to : [to];
    return recipients.every((id) => this.isJoined(invite, id));
  }

  private async touchParticipantLastSeen(invite: InviteState, participantId: string): Promise<void> {
    const participants = { ...invite.participants };
    participants[participantId] = { ...participants[participantId], last_seen_at: new Date().toISOString() };
    await this.state.storage.put(STATE_KEY, { ...invite, participants } satisfies InviteState);
  }

  private isReadableMessage(message: RoomMessage, participantId: string, options: ReadOptions): boolean {
    return message.seq > options.after && (options.includeSelf || message.from !== participantId) && this.visibleTo(message, participantId);
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
    if (!Object.values(invite.participants).some((p) => !p.left_at)) {
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

function tokenFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function isRoomRoot(url: URL, inviteId: string): boolean {
  return url.pathname.replace(/\/$/, "") === `/r/${inviteId}`;
}

function pathLastSegment(url: URL): string {
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
}

function boardKeyFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/board\/[^/]+$/) ? pathLastSegment(url) : undefined;
}

function roomInfo(invite: InviteState) {
  return {
    invite_id: invite.inviteId,
    name: invite.roomName,
    host_id: invite.hostId,
    max_participants: invite.maxParticipants,
  };
}

function parseReadOptions(request: Request, body: Record<string, unknown>): ReadOptions {
  const url = new URL(request.url);
  return {
    after: Number(body.after ?? url.searchParams.get("after") ?? 0),
    includeSelf: !!body.include_self || url.searchParams.get("include_self") === "true",
  };
}

function buildReadResponse(invite: InviteState, participantId: string, messages: RoomMessage[]) {
  return {
    participant_id: participantId,
    cursor: invite.nextSeq,
    oldest_seq: invite.messages[0]?.seq ?? 0,
    retention: { max_messages: MAX_MESSAGES },
    messages,
  };
}

function createRoomMessage(body: Record<string, unknown>, participantId: string, to: Recipient, seq: number): RoomMessage {
  return {
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
}

function createInitialMessage(body: InitPayload): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    from: body.hostId,
    to: "all",
    reply_to: null,
    intent: "room_purpose",
    priority: "normal",
    body: body.firstMessage,
    created_at: new Date().toISOString(),
  };
}

function validateParticipantCanJoin(participants: Record<string, Participant>, participantId: string, maxParticipants: number): Response | undefined {
  if (participants[participantId] && !participants[participantId].left_at) {
    return json({ error: "participant_id already joined" }, 409);
  }
  if (!participants[participantId] && activeParticipantCount(participants) >= maxParticipants) {
    return json({ error: "room is full", max_participants: maxParticipants }, 409);
  }
  return undefined;
}

function activeParticipantCount(participants: Record<string, Participant>): number {
  return Object.values(participants).filter((p) => !p.left_at).length;
}

function parseParticipantProfile(body: Record<string, unknown>): ParticipantProfile | Response {
  const state = normalizeParticipantState(body.state);
  if (state instanceof Response) return state;
  const status = normalizeParticipantStatus(body.status);
  if (status instanceof Response) return status;
  const model = normalizeParticipantModel(body.model);
  if (model instanceof Response) return model;
  const skills = normalizeParticipantSkills(body.skills);
  if (skills instanceof Response) return skills;
  return { state, status, model, skills };
}

function createJoinedParticipant(participantId: string, profile: ParticipantProfile): Participant {
  const now = new Date().toISOString();
  return {
    id: participantId,
    joined_at: now,
    last_seen_at: now,
    state: "free",
    status: "joined",
    status_updated_at: now,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.skills ? { skills: profile.skills } : {}),
  };
}

function updateParticipantProfile(participant: Participant, profile: ParticipantProfile): Participant {
  const now = new Date().toISOString();
  return {
    ...participant,
    state: profile.state ?? participant.state ?? "free",
    status: profile.status ?? participant.status ?? "joined",
    status_updated_at: now,
    last_seen_at: now,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.skills !== undefined ? { skills: profile.skills } : {}),
  };
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
  controller.enqueue(ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function httpRoomUrl(request: Request): string {
  const url = new URL(request.url);
  url.search = "";
  return url.toString();
}
