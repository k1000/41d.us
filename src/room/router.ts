import type { InviteState } from "../types";
import { boardKeyFromUrl, isRoomRoot, pathLastSegment } from "./routing";

interface RoomRouteHandlers {
  read(): Promise<Response>;
  send(): Promise<Response>;
  close(): Promise<Response>;
  export(): Promise<Response>;
  getBoard(): Promise<Response>;
  patchBoard(): Promise<Response>;
  getBoardKey(key: string): Promise<Response>;
  setBoardKey(key: string): Promise<Response>;
  deleteBoardKey(key: string): Promise<Response>;
  join(participantId: string): Promise<Response>;
  updateParticipant(participantId: string): Promise<Response>;
  deleteParticipant(participantId: string): Promise<Response>;
  participants(): Promise<Response>;
  status(): Promise<Response>;
  events(): Promise<Response>;
}

export function routeRoomRequest(request: Request, url: URL, invite: InviteState, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  return routeRoot(request, url, invite, handlers)
    ?? routeExport(request, url, handlers)
    ?? routeBoard(request, url, handlers)
    ?? routeParticipants(request, url, handlers)
    ?? routeMeta(request, url, handlers);
}

function routeRoot(request: Request, url: URL, invite: InviteState, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  if (!isRoomRoot(url, invite.inviteId)) return undefined;
  if (request.method === "GET" && request.headers.has("authorization")) return handlers.read();
  if (request.method === "POST") return handlers.send();
  if (request.method === "DELETE") return handlers.close();
  return undefined;
}

function routeExport(request: Request, url: URL, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  return url.pathname.endsWith("/export") && request.method === "GET" ? handlers.export() : undefined;
}

function routeBoard(request: Request, url: URL, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  if (url.pathname.endsWith("/board")) {
    if (request.method === "GET") return handlers.getBoard();
    if (request.method === "PATCH") return handlers.patchBoard();
    return undefined;
  }

  const key = boardKeyFromUrl(url);
  if (!key) return undefined;
  if (request.method === "GET") return handlers.getBoardKey(key);
  if (request.method === "PUT") return handlers.setBoardKey(key);
  if (request.method === "DELETE") return handlers.deleteBoardKey(key);
  return undefined;
}

function routeParticipants(request: Request, url: URL, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  if (url.pathname.endsWith("/participants") && request.method === "GET") return handlers.participants();
  if (!url.pathname.match(/\/participants\/[^/]+$/)) return undefined;
  const participantId = pathLastSegment(url);
  if (request.method === "PUT") return handlers.join(participantId);
  if (request.method === "PATCH") return handlers.updateParticipant(participantId);
  if (request.method === "DELETE") return handlers.deleteParticipant(participantId);
  return undefined;
}

function routeMeta(request: Request, url: URL, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  if (url.pathname.endsWith("/status") && request.method === "GET") return handlers.status();
  if (url.pathname.endsWith("/events") && request.method === "GET") return handlers.events();
  return undefined;
}
