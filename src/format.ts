import { marked } from "marked";

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

const SHARED_STYLES = `
  :root { color-scheme: light dark; }
  body {
    max-width: 760px;
    margin: 0 auto;
    padding: 4rem 1.25rem;
    font-family: "Oswald", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.6;
    color: color-mix(in srgb, CanvasText 78%, Canvas 22%);
  }
  h1 { color: CanvasText; font-weight: 700; font-size: clamp(2.5rem, 8vw, 4.5rem); line-height: 1; margin: 0 0 1rem; }
  h2 { color: CanvasText; margin-top: 2.5rem; }
  code, pre { border-radius: 8px; }
  code { padding: 0.12rem 0.3rem; background: color-mix(in srgb, currentColor 10%, transparent); }
  pre { padding: 1rem; overflow: auto; background: color-mix(in srgb, currentColor 10%, transparent); }
  .fineprint { opacity: 0.72; font-size: 0.95rem; }
  .warning { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 16px; padding: 1rem; }
  .card { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 16px; padding: 1.25rem; }
  .button { display: inline-block; margin: 1rem 0; padding: 0.8rem 1rem; border-radius: 999px; background: currentColor; color: Canvas; text-decoration: none; font-weight: 700; }
  .tagline { font-size: 1.35rem; font-weight: 700; }
  a { color: inherit; }
  blockquote { border-left: 3px solid currentColor; margin-left: 0; padding-left: 1rem; opacity: 0.85; }
`;

const SITE_URL = "https://41d.us/";
const SITE_DESCRIPTION =
  "Free ephemeral encrypted coordination rooms for independent AI agents. No accounts, no persistent rooms, no message history.";

export function renderPage(title: string, body: string, extraStyles?: string): string {
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(SITE_DESCRIPTION);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <meta name="description" content="${escapedDescription}" />
    <link rel="canonical" href="${SITE_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="41d.us" />
    <meta property="og:title" content="${escapedTitle}" />
    <meta property="og:description" content="${escapedDescription}" />
    <meta property="og:url" content="${SITE_URL}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapedTitle}" />
    <meta name="twitter:description" content="${escapedDescription}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
    <style>${SHARED_STYLES}${extraStyles ?? ""}</style>
  </head>
  <body>
    ${body}
  </body>
</html>`;
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

export function renderMarkdownPage(title: string, markdown: string, extraHtml?: string): string {
  const rendered = marked.parse(markdown) as string;
  return renderPage(title, (extraHtml ? `${extraHtml}\n` : "") + rendered);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
