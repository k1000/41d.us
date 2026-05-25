import type { InviteState } from "../types";

type HandlerResult = Promise<Response>;
type MethodHandlers = Partial<Record<string, () => HandlerResult | undefined>>;
type PrefixRoute = {
  prefix: string;
  handlers: Partial<Record<string, (value: string) => HandlerResult>>;
};

interface RoomRouteHandlers {
  read(): HandlerResult;
  send(): HandlerResult;
  close(): HandlerResult;
  export(): HandlerResult;
  extend(): HandlerResult;
  transition(): HandlerResult;
  getBoard(): HandlerResult;
  patchBoard(): HandlerResult;
  getBoardKey(key: string): HandlerResult;
  setBoardKey(key: string): HandlerResult;
  deleteBoardKey(key: string): HandlerResult;
  join(participantId: string): HandlerResult;
  updateParticipant(participantId: string): HandlerResult;
  deleteParticipant(participantId: string): HandlerResult;
  participants(): HandlerResult;
  status(): HandlerResult;
  events(): HandlerResult;
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

export function routeRoomRequest(request: Request, url: URL, invite: InviteState, handlers: RoomRouteHandlers): HandlerResult | undefined {
  const subpath = roomSubpath(url, invite.roomId);
  return routeExact(request.method, subpath, exactRoutes(request, handlers))
    ?? routePrefixed(request.method, subpath, prefixedRoutes(handlers));
}

function exactRoutes(request: Request, handlers: RoomRouteHandlers): Record<string, MethodHandlers> {
  return {
    "": {
      GET: () => request.headers.has("authorization") ? handlers.read() : undefined,
      POST: handlers.send,
      DELETE: handlers.close,
    },
    "/export": { GET: handlers.export },
    "/status": { GET: handlers.status },
    "/events": { GET: handlers.events },
    "/extend": { POST: handlers.extend },
    "/transition": { POST: handlers.transition },
    "/board": { GET: handlers.getBoard, PATCH: handlers.patchBoard },
    "/participants": { GET: handlers.participants },
  };
}

function prefixedRoutes(handlers: RoomRouteHandlers): PrefixRoute[] {
  return [
    {
      prefix: "/board/",
      handlers: {
        GET: handlers.getBoardKey,
        PUT: handlers.setBoardKey,
        DELETE: handlers.deleteBoardKey,
      },
    },
    {
      prefix: "/participants/",
      handlers: {
        PUT: handlers.join,
        PATCH: handlers.updateParticipant,
        DELETE: handlers.deleteParticipant,
      },
    },
  ];
}

function routeExact(method: string, subpath: string, routes: Record<string, MethodHandlers>): HandlerResult | undefined {
  return routes[subpath]?.[method]?.();
}

function routePrefixed(method: string, subpath: string, routes: PrefixRoute[]): HandlerResult | undefined {
  const route = routes.find((candidate) => subpath.startsWith(candidate.prefix));
  if (!route) return undefined;
  const value = decodeURIComponent(subpath.slice(route.prefix.length));
  if (!value) return undefined;
  return route.handlers[method]?.(value);
}
