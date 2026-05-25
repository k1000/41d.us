import type { InviteState } from "../types";

interface RoomRouteHandlers {
  read(): Promise<Response>;
  send(): Promise<Response>;
  close(): Promise<Response>;
  export(): Promise<Response>;
  extend(): Promise<Response>;
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

/**
 * Extract the subpath after the room root (/r/:roomId).
 * Returns "" for the root, or "/subpath[/more]" for sub-routes.
 */
function roomSubpath(url: URL, roomId: string): string {
  const root = `/r/${roomId}`;
  const path = url.pathname.replace(/\/$/, "");
  if (path === root) return "";
  if (path.startsWith(root + "/")) return path.slice(root.length);
  return path;
}

export function routeRoomRequest(request: Request, url: URL, invite: InviteState, handlers: RoomRouteHandlers): Promise<Response> | undefined {
  const subpath = roomSubpath(url, invite.roomId);

  if (subpath === "") {
    if (request.method === "GET" && request.headers.has("authorization")) return handlers.read();
    if (request.method === "POST") return handlers.send();
    if (request.method === "DELETE") return handlers.close();
    return undefined;
  }

  // /export
  if (subpath === "/export" && request.method === "GET") return handlers.export();

  // /status, /events, /extend
  if (request.method === "GET") {
    if (subpath === "/status") return handlers.status();
    if (subpath === "/events") return handlers.events();
  }
  if (subpath === "/extend" && request.method === "POST") return handlers.extend();

  // /board or /board/:key
  if (subpath === "/board") {
    if (request.method === "GET") return handlers.getBoard();
    if (request.method === "PATCH") return handlers.patchBoard();
    return undefined;
  }
  const boardPrefix = "/board/";
  if (subpath.startsWith(boardPrefix)) {
    const key = decodeURIComponent(subpath.slice(boardPrefix.length));
    if (!key) return undefined;
    if (request.method === "GET") return handlers.getBoardKey(key);
    if (request.method === "PUT") return handlers.setBoardKey(key);
    if (request.method === "DELETE") return handlers.deleteBoardKey(key);
    return undefined;
  }

  // /participants or /participants/:id
  if (subpath === "/participants" && request.method === "GET") return handlers.participants();
  const participantPrefix = "/participants/";
  if (subpath.startsWith(participantPrefix)) {
    const participantId = decodeURIComponent(subpath.slice(participantPrefix.length));
    if (!participantId) return undefined;
    if (request.method === "PUT") return handlers.join(participantId);
    if (request.method === "PATCH") return handlers.updateParticipant(participantId);
    if (request.method === "DELETE") return handlers.deleteParticipant(participantId);
    return undefined;
  }

  return undefined;
}
