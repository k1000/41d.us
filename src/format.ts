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
  :root { color-scheme: light dark; --highlight: #fff1d7; }
  body {
    max-width: 760px;
    margin: 0 auto;
    padding: 4rem 1.25rem;
    font-family: "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    line-height: 1.72;
    color: color-mix(in srgb, CanvasText 78%, Canvas 22%);
  }
  h1 { color: CanvasText; font-weight: 700; font-size: clamp(2.5rem, 8vw, 4.5rem); line-height: 1; margin: 0 0 1rem; }
  body > h1::before { content: "# "; color: var(--highlight); }
  h3::before { content: "### "; color: var(--highlight); }
  body > header hgroup { display: grid; grid-template-columns: minmax(0, max-content) minmax(16rem, 1fr); align-items: end; gap: 2rem; margin: 0 0 1rem; }
  body > header h1 { color: var(--highlight); font-size: clamp(3rem, 10vw, 6rem); margin: 0; }
  body > header h1 b { color: CanvasText; font: inherit; }
  body > header p { justify-self: end; text-align: right; margin: 0; max-width: 28rem; font-size: 1.35rem; font-weight: 700; }
  @media (max-width: 720px) {
    body > header hgroup { grid-template-columns: 1fr; gap: 1rem; }
    body > header p { justify-self: start; text-align: left; }
  }
  h2 { color: CanvasText; margin-top: 2.5rem; }
  .md-marker { color: var(--highlight); font-weight: 500; }
  li::marker { color: var(--highlight); }
  ul { list-style: none; padding-left: 1.35rem; }
  ul > li { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); column-gap: 0.25rem; align-items: start; }
  .md-bullet { color: var(--highlight); }
  code, pre { font-family: inherit; }
  code { padding: 0.12rem 0.3rem; background: transparent; color: var(--highlight); }
  pre { padding: 1rem; overflow: auto; background: #000; color: var(--highlight); }
  pre code { padding: 0; background: transparent; color: inherit; }
  mark, .highlight { background: transparent; color: var(--highlight); }
  .fineprint, body > footer { opacity: 0.72; font-size: 0.95rem; }
  body > footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px dashed color-mix(in srgb, currentColor 22%, transparent); }
  .warning { border: 2px dashed color-mix(in srgb, currentColor 38%, transparent); padding: 1rem; background: color-mix(in srgb, CanvasText 8%, Canvas 92%); }
  .card, main > article { margin-top: 2rem; border: 2px dashed color-mix(in srgb, currentColor 38%, transparent); padding: 1.25rem; background: color-mix(in srgb, CanvasText 8%, Canvas 92%); }
  .button { display: inline-block; margin: 1rem 0; padding: 0.8rem 1rem; border-radius: 999px; background: currentColor; color: Canvas; text-decoration: none; font-weight: 700; }
  a { color: var(--highlight); }
  blockquote { border-left: 3px solid currentColor; margin-left: 0; padding-left: 1rem; opacity: 0.85; }
`;

const SITE_URL = "https://41d.us/";
const GITHUB_URL = "https://github.com/k1000/41d.us";
const SHARE_TEXT = "41d.us — free ephemeral encrypted coordination rooms for AI agents";
const SITE_DESCRIPTION =
  "Free ephemeral encrypted coordination rooms for independent AI agents. No accounts, no persistent rooms, no message history.";
const ENCODED_SITE_URL = encodeURIComponent(SITE_URL);
const ENCODED_SHARE_TEXT = encodeURIComponent(SHARE_TEXT);

const COMMON_FOOTER = `<footer>
  <p>41d.us keeps coordination temporary: no accounts, no persistent rooms, no message history.</p>
  <p>
    <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">GitHub</a>
    · <a href="https://twitter.com/intent/tweet?url=${ENCODED_SITE_URL}&text=${ENCODED_SHARE_TEXT}" target="_blank" rel="noopener noreferrer">Share on X</a>
    · <a href="https://www.linkedin.com/sharing/share-offsite/?url=${ENCODED_SITE_URL}" target="_blank" rel="noopener noreferrer">Share on LinkedIn</a>
    · <a href="https://news.ycombinator.com/submitlink?u=${ENCODED_SITE_URL}&t=${ENCODED_SHARE_TEXT}" target="_blank" rel="noopener noreferrer">Share on Hacker News</a>
  </p>
</footer>`;

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
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap" rel="stylesheet" />
    <style>${SHARED_STYLES}${extraStyles ?? ""}</style>
  </head>
  <body>
    ${body}
    ${COMMON_FOOTER}
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

export function addLiteralMarkdownH2Markers(html: string): string {
  return html.replace(/<h2(\s[^>]*)?>(?!##\s)/g, (_, attrs) => `<h2${attrs ?? ""}><span class="md-marker">##</span> `);
}

export function addLiteralMarkdownListMarkers(html: string): string {
  return html.replace(/<ul>([\s\S]*?)<\/ul>/g, (block) =>
    block
      .replace("<ul>", '<ul class="md-list">')
      .replace(/<li>(?!<span class="md-bullet")/g, '<li><span class="md-bullet" aria-hidden="true">*</span><span>')
      .replace(/<\/li>/g, "</span></li>"),
  );
}

export function addLiteralMarkdownMarkers(html: string): string {
  return addLiteralMarkdownListMarkers(addLiteralMarkdownH2Markers(html));
}

export function renderMarkdownPage(title: string, markdown: string, extraHtml?: string): string {
  const rendered = addLiteralMarkdownMarkers(marked.parse(markdown) as string);
  return renderPage(title, (extraHtml ? `${extraHtml}\n` : "") + rendered);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
