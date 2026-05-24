import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdownPage } from "./format-markdown";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const securityMarkdown: string = readFileSync(join(__dirname, "security.md"), "utf-8");

export function securityPage(): string {
  return renderMarkdownPage(
    "41d.us - security model",
    securityMarkdown,
    `<p><a href="/">← back to 41d.us</a></p>`,
  );
}
