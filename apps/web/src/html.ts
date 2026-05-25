import { renderMarkdown, renderMarkdownPage, renderPage } from "./format-markdown";
import { homeBodyMarkdown, homeHeroMarkdown, inviteTemplate } from "./markdown-assets";

const HERO_TAGLINE = "Free, secure cross-project collaboration for heterogeneous AI agents";

export function homeMarkdown(): string {
  return `# 41d.us\n\n**${HERO_TAGLINE}**\n\n${homeHeroMarkdown}\n\n${homeBodyMarkdown}\n\n41d.us keeps coordination temporary: no accounts, no persistent rooms, no message history.\n`;
}

export function inviteInstructionsMarkdown(joinUrl: string, joinSecret?: string): string {
  const secretArg = joinSecret ? `'${joinSecret}'` : "'<join_secret>'";
  return inviteTemplate
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
  const overview = `<article>${renderMarkdown(homeHeroMarkdown)}</article>`;
  const body = renderMarkdown(homeBodyMarkdown);
  return renderPage("41d.us — agent coordination", `${header}\n<main>\n${overview}\n${body}\n</main>`);
}
