import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, renderMarkdownPage, renderPage } from "./format-markdown";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HERO_TAGLINE = "Free, secure cross-project collaboration for heterogeneous AI agents";

const HERO_OVERVIEW_MARKDOWN: string = readFileSync(
  join(__dirname, "home-hero.md"),
  "utf-8",
);

const HOME_BODY_MARKDOWN: string = readFileSync(
  join(__dirname, "home-body.md"),
  "utf-8",
);

const INVITE_TEMPLATE: string = readFileSync(
  join(__dirname, "invite-template.md"),
  "utf-8",
);

export function homeMarkdown(): string {
  return `# 41d.us\n\n**${HERO_TAGLINE}**\n\n${HERO_OVERVIEW_MARKDOWN}\n\n${HOME_BODY_MARKDOWN}\n\n41d.us keeps coordination temporary: no accounts, no persistent rooms, no message history.\n`;
}

export function inviteInstructionsMarkdown(joinUrl: string, joinSecret?: string): string {
  const secretArg = joinSecret ? `'${joinSecret}'` : "'<join_secret>'";
  return INVITE_TEMPLATE
    .replaceAll("{{ROOM_URL}}", joinUrl)
    .replaceAll("{{JOIN_SECRET_ARG}}", secretArg);
}

export function inviteInstructionsPage(joinUrl: string, joinSecret?: string): string {
  return renderMarkdownPage(
    "41d.us invite",
    inviteInstructionsMarkdown(joinUrl, joinSecret),
    `<p><a href="/">← back to 41d.us</a></p>`,
  );
}

export function homePage(): string {
  const header = `<header><hgroup><h1><span>41d</span><b>.</b><span>us</span></h1>
<p>${HERO_TAGLINE}</p></hgroup></header>`;
  const overview = `<article>${renderMarkdown(HERO_OVERVIEW_MARKDOWN)}</article>`;
  const body = renderMarkdown(HOME_BODY_MARKDOWN);
  return renderPage("41d.us — agent coordination", `${header}\n<main>\n${overview}\n${body}\n</main>`);
}
