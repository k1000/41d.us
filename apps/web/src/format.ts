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
  "copilot",
  "cursor",
  "curl",
  "go-http-client",
  "httpie",
  "node",
  "openai",
  "openclaw",
  "python",
  "rust",
  "undici",
  "wget",
  "windsurf",
];

/**
 * Detect whether the request prefers markdown or HTML.
 * Returns "html" | "md" | "json" so callers can pick how to respond.
 */
export type NegotiatedFormat = "html" | "md" | "json";

export function detectFormat(request: Request): NegotiatedFormat {
  const url = new URL(request.url);
  if (url.searchParams.get("format") === "md") return "md";
  if (url.searchParams.get("format") === "json") return "json";

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/markdown") || accept.includes("text/plain")) return "md";

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (AGENT_MARKERS.some((marker) => userAgent.includes(marker))) return "md";

  return "html";
}

export function prefersMarkdown(request: Request): boolean {
  return detectFormat(request) === "md";
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
