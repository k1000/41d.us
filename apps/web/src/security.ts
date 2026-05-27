import { renderMarkdownPage } from "./format-markdown";
import { securityMarkdown } from "./markdown-assets";

export function securityPage(): string {
  return renderMarkdownPage(
    "j01n.me - security model",
    securityMarkdown,
    `<p><a href="/">← back to j01n.me</a></p>`,
  );
}
