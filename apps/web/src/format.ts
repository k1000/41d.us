const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const AGENT_MARKERS = [
  "agent",
  "aider",
  "bot",
  "chatgpt",
  "claude",
  "codex",
  "cursor",
  "curl",
  "go-http-client",
  "httpie",
  "node",
  "openai",
  "python",
  "undici",
  "wget",
  "windsurf",
];

export function prefersMarkdown(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("format") === "md") return true;

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("text/markdown") || accept.includes("text/plain")) return true;

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  return AGENT_MARKERS.some((marker) => userAgent.includes(marker));
}

export function respondNegotiated(
  request: Request,
  html: () => string,
  markdown: () => string,
): Response {
  if (prefersMarkdown(request)) {
    return new Response(markdown(), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  return new Response(html(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export type GuardResult = Response | undefined;
