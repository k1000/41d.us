export function isRoomRoot(url: URL, inviteId: string): boolean {
  return url.pathname.replace(/\/$/, "") === `/r/${inviteId}`;
}

export function pathLastSegment(url: URL): string {
  return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
}

export function boardKeyFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/board\/[^/]+$/) ? pathLastSegment(url) : undefined;
}
