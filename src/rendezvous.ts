import { json, respondNegotiated } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import { authenticateParticipant, requireHost, withAuth, withJoinedParticipant } from "./room/auth";
import { RoomBoardController, validateBoard, wrapInitialBoard } from "./room/board-controller";
import { RoomEvents } from "./room/events";
import { roomExport, roomInfo, roomStatus } from "./room/info";
import { buildReadResponse, createInitialMessage, createSentMessage, isReadableMessage, parseReadOptions } from "./room/messages";
import { activeParticipants, isParticipantJoined, withReadReceipt } from "./room/participants";
import { RoomParticipantController } from "./room/participant-controller";
import { routeRoomRequest } from "./room/router";
import { RoomStorage } from "./room/storage";
import type { Env, InitPayload, InviteState } from "./types";

export class RendezvousSession {
  private readonly events = new RoomEvents();
  private readonly storage: RoomStorage;
  private readonly board: RoomBoardController;
  private readonly participants: RoomParticipantController;

  constructor(state: DurableObjectState, _env: Env) {
    this.storage = new RoomStorage(state);
    this.board = new RoomBoardController(this.storage, this.events);
    this.participants = new RoomParticipantController(this.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") return this.handleInit(request);

    const invite = await this.storage.getValidInvite();
    if (invite instanceof Response) return invite;

    const routed = this.routeRequest(request, url, invite);
    if (routed) return routed;

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket transport has been removed. Use the collab space.", { status: 410 });
    }

    const roomUrl = new URL(request.url);
    roomUrl.search = "";
    return respondNegotiated(
      request,
      () => inviteInstructionsPage(roomUrl.toString()),
      () => inviteInstructionsMarkdown(roomUrl.toString()),
    );
  }

  private buildInitialInviteState(body: InitPayload, existing: InviteState | undefined): InviteState | Response {
    if (existing && existing.phase !== "closed") return json({ error: "invite already exists" }, 409);
    const firstMessage = body.firstMessage ? [createInitialMessage(body)] : [];
    const board = wrapInitialBoard(body.initialBoard, body.hostId);
    const validation = validateBoard(body.boardSchema, board);
    if (validation) return validation;
    const { initialBoard: _ib, firstMessage: _fm, ...stateToStore } = body;
    return { ...stateToStore, nextSeq: firstMessage.length, participants: {}, messages: firstMessage, board } satisfies InviteState;
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as InitPayload;
    const existing = await this.storage.getInvite();
    const initState = this.buildInitialInviteState(body, existing);
    if (initState instanceof Response) return initState;
    await this.storage.putInvite(initState);
    return json({ ok: true });
  }

  private routeRequest(request: Request, url: URL, invite: InviteState): Promise<Response> | undefined {
    return routeRoomRequest(request, url, invite, {
      read: () => this.handleRead(request, invite),
      send: () => this.handleSend(request, invite),
      close: () => this.handleClose(request, invite),
      export: () => this.handleExport(request, invite),
      getBoard: () => this.board.get(request, invite),
      patchBoard: () => this.board.patch(request, invite),
      getBoardKey: (key) => this.board.getKey(request, invite, key),
      setBoardKey: (key) => this.board.setKey(request, invite, key),
      deleteBoardKey: (key) => this.board.deleteKey(request, invite, key),
      join: (participantId) => this.participants.join(request, invite, participantId),
      updateParticipant: (participantId) => this.participants.update(request, invite, participantId),
      deleteParticipant: (participantId) => this.participants.delete(request, invite, participantId),
      participants: () => this.handleParticipants(request, invite),
      status: () => this.handleStatus(request, invite),
      events: () => this.handleEvents(request, invite),
    });
  }

  private async handleSend(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, (body, participantId) => this.sendMessage(body, participantId, invite));
  }

  private async sendMessage(body: Record<string, unknown>, participantId: string, invite: InviteState): Promise<Response> {
    const result = createSentMessage(body, participantId, invite);
    if (result instanceof Response) return result;
    await this.storage.putInvite({ ...invite, nextSeq: result.seq, messages: result.messages } satisfies InviteState);
    this.events.notifyMessage(result.message, result.seq);
    return json({ ok: true, id: result.message.id, seq: result.seq });
  }

  private async handleRead(request: Request, invite: InviteState): Promise<Response> {
    return withJoinedParticipant(request, invite, (body, participantId) => this.readMessages(request, body, participantId, invite));
  }

  private async readMessages(request: Request, body: Record<string, unknown>, participantId: string, invite: InviteState): Promise<Response> {
    const readOptions = parseReadOptions(request, body, invite, participantId);
    const messages = invite.messages.filter((msg) => isReadableMessage(msg, participantId, readOptions));
    const updated = withReadReceipt(invite, participantId, invite.nextSeq);
    await this.storage.putInvite(updated);
    return json(buildReadResponse(updated, participantId, messages, readOptions));
  }

  private async handleEvents(request: Request, invite: InviteState): Promise<Response> {
    const url = new URL(request.url);
    const auth = await authenticateParticipant(request, invite);
    if (auth instanceof Response) return auth;
    const participantId = auth.participantId;
    if (!isParticipantJoined(invite.participants, participantId)) return json({ error: "participant has not joined" }, 403);
    const includeSelf = url.searchParams.get("include_self") === "true";

    return this.events.subscribe(participantId, includeSelf, invite.nextSeq);
  }

  private async handleParticipants(request: Request, invite: InviteState): Promise<Response> {
    return withAuth(request, invite, async () =>
      json({ room: roomInfo(invite), participants: activeParticipants(invite.participants) }),
    );
  }

  private async handleStatus(request: Request, invite: InviteState): Promise<Response> {
    return withAuth(request, invite, async () =>
      json({
        ...roomStatus(invite),
        closed: invite.phase === "closed",
      }),
    );
  }

  private async handleClose(request: Request, invite: InviteState): Promise<Response> {
    const hostCheck = await requireHost(request, invite, "close room");
    if (hostCheck instanceof Response) return hostCheck;
    await this.storage.putInvite({ ...invite, phase: "closed" } satisfies InviteState);
    return json({ ok: true, closed: true });
  }

  private async handleExport(request: Request, invite: InviteState): Promise<Response> {
    const hostCheck = await requireHost(request, invite, "export room");
    if (hostCheck instanceof Response) return hostCheck;
    return json(roomExport(invite));
  }
}
