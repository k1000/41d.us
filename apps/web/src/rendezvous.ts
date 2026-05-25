import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import { DEFAULT_EXTEND_MS, MAX_INVITE_TTL_MS, MIN_INVITE_TTL_MS } from "./constants";
import { tokenAuthThen, participantAuthThen, joinedThen } from "./room/auth-context";
import { RoomBoardController } from "./room/board-controller";
import { RoomEvents } from "./room/events";
import type { RoomEventBus } from "./room/events";
import { roomExport, roomInfo, roomStatus, roomTransitionInfo } from "./room/info";
import { RoomInitController } from "./room/init-controller";
import { RoomMessageController } from "./room/message-controller";
import { activeParticipants } from "./room/participants";
import { RoomParticipantController } from "./room/participant-controller";
import { routeRoomRequest } from "./room/router";
import { RoomStorage } from "./room/storage";
import type { Env, InviteState } from "./types";

export class RendezvousSession implements DurableObject {
  private readonly events: RoomEventBus = new RoomEvents();
  private readonly storage: RoomStorage;
  private readonly board: RoomBoardController;
  private readonly participants: RoomParticipantController;
  private readonly messages: RoomMessageController;
  private readonly init: RoomInitController;
  private readonly ctx: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.ctx = state;
    this.storage = new RoomStorage(state);
    this.board = new RoomBoardController(this.storage, this.events);
    this.participants = new RoomParticipantController(this.storage, this.events);
    this.messages = new RoomMessageController(this.storage, this.events);
    this.init = new RoomInitController(this.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      return this.init.init(request);
    }

    const invite = await this.storage.getValidInvite();
    if (invite instanceof Response) return invite;

    const routed = this.routeRequest(request, url, invite);
    if (routed) return routed;

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket transport has been removed. Use the collab space.", { status: 410 });
    }

    const roomUrl = new URL(request.url);
    roomUrl.search = "";
    const secretFromUrl = url.searchParams.get("s") ?? undefined;
    const roomInfo = {
      name: invite.roomName,
      purpose: invite.purpose,
      host_id: invite.hostId,
      participant_count: activeParticipants(invite.participants).length,
      expires_at: new Date(invite.expiresAt).toISOString(),
    };
    return respondNegotiated(
      request,
      () => inviteInstructionsPage(roomUrl.toString(), secretFromUrl, roomInfo),
      () => inviteInstructionsMarkdown(roomUrl.toString(), secretFromUrl, roomInfo),
    );
  }

  async alarm(): Promise<void> {
    const invite = await this.storage.getInvite();
    if (!invite) return;
    if (Date.now() > invite.expiresAt || activeParticipants(invite.participants).length === 0) {
      await this.ctx.storage.deleteAll();
    }
  }

  private routeRequest(
    request: Request,
    url: URL,
    invite: InviteState,
  ): Promise<Response> | undefined {
    return routeRoomRequest(request, url, invite, {
      read: () => this.messages.read(request, invite),
      send: () => this.messages.send(request, invite),
      close: () => this.handleClose(request, invite),
      export: () => this.handleExport(request, invite),
      getBoard: () => this.board.get(request, invite),
      patchBoard: () => this.board.patch(request, invite),
      getBoardKey: (key) => this.board.getKey(request, invite, key),
      setBoardKey: (key) => this.board.setKey(request, invite, key),
      deleteBoardKey: (key) => this.board.deleteKey(request, invite, key),
      join: (participantId) =>
        this.participants.join(request, invite, participantId),
      updateParticipant: (participantId) =>
        this.participants.update(request, invite, participantId),
      deleteParticipant: (participantId) =>
        this.participants.delete(request, invite, participantId),
      participants: () => this.handleParticipants(request, invite),
      status: () => this.handleStatus(request, invite),
      events: () => this.handleEvents(request, invite),
      extend: () => this.handleExtendTtl(request, invite),
      transition: () => this.handleTransition(request, invite),
    });
  }

  private handleExtendTtl(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can extend TTL" }, 403);

      const rawExtend = auth.body.extend_ms as number | undefined;
      const requested = typeof rawExtend === "number" && Number.isFinite(rawExtend)
        ? Math.trunc(rawExtend)
        : DEFAULT_EXTEND_MS;
      const maxExtend = Date.now() + MAX_INVITE_TTL_MS - invite.expiresAt;
      const extendMs = Math.min(Math.max(requested, MIN_INVITE_TTL_MS), Math.max(maxExtend, MIN_INVITE_TTL_MS));

      const newExpiresAt = invite.expiresAt + extendMs;
      await this.storage.patchAndSave(invite, { expiresAt: newExpiresAt });
      await this.storage.scheduleCleanup(newExpiresAt);
      return json({
        ok: true,
        extended_ms: extendMs,
        expires_at: new Date(newExpiresAt).toISOString(),
      });
    });
  }

  private handleEvents(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const url = new URL(request.url);
      const includeSelf = url.searchParams.get("include_self") === "true";
      return this.events.subscribe(auth.participantId, includeSelf, invite.nextSeq);
    });
  }

  private handleTransition(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantAuthThen(invite, request, async (auth) => {
      const states = invite.roomStates;
      if (!states || Object.keys(states).length === 0) {
        return json({ error: "room has no state machine configured" }, 400);
      }
      if (auth.participantId !== invite.hostId) {
        return json({ error: "only host can transition room state" }, 403);
      }

      const event = auth.body.event as string | undefined;
      if (!event) return json({ error: "'event' field is required" }, 400);

      const currentState = states[invite.phase];
      if (!currentState) {
        return json({ error: `current state "${invite.phase}" is not a known state` }, 400);
      }

      const to = currentState.transitions[event];
      if (!to) {
        const available = Object.keys(currentState.transitions);
        return json({
          error: `no transition "${event}" from "${invite.phase}"`,
          available_events: available,
        }, 400);
      }

      const nextState = states[to];
      if (!nextState) {
        return json({ error: `target state "${to}" not found in room configuration` }, 400);
      }

      // Record the transition as a system message.
      const seq = invite.nextSeq + 1;
      const transitionMessage = {
        id: crypto.randomUUID(),
        seq,
        from: auth.participantId,
        to: "all" as const,
        reply_to: null as string | null,
        intent: "room.transitioned" as const,
        priority: "normal" as const,
        body: { from: invite.phase, event, to },
        created_at: new Date().toISOString(),
      } satisfies import("./types").RoomMessage;
      const messages = [...invite.messages, transitionMessage].slice(-200);

      await this.storage.patchAndSave(invite, { phase: to, nextSeq: seq, messages });
      this.events.notifyMessage(transitionMessage, seq);

      return json({ ok: true, from: invite.phase, event, to, ...roomTransitionInfo(nextState) });
    });
  }

  private handleParticipants(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return tokenAuthThen(invite, request, async () => {
      return json({
        room: roomInfo(invite),
        participants: activeParticipants(invite.participants),
      });
    });
  }

  private handleStatus(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return tokenAuthThen(invite, request, async () => {
      return json({
        ...roomStatus(invite),
        closed: invite.phase === "closed",
      });
    });
  }

  private handleClose(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can close room" }, 403);
      await this.storage.patchAndSave(invite, { phase: "closed" });
      return json({ ok: true, closed: true });
    });
  }

  private handleExport(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can export room" }, 403);
      return json(roomExport(invite));
    });
  }
}
