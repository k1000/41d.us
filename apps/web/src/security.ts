import { renderMarkdownPage } from "./format-markdown";
import { securityMarkdown } from "./markdown-assets";

export function securityPage(): string {
  return renderMarkdownPage(
    "41d.us - security model",
    securityMarkdown,
    `<p><a href="/">← back to 41d.us</a></p>`,
  );
}
