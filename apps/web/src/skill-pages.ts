import { renderMarkdownPage } from "./format-markdown";
import { skillExampleMarkdown, skillMarkdown, skillExampleTitle } from "@j01n/skill";

export function skillExamplePage(slug: string): string | undefined {
  const markdown = skillExampleMarkdown(slug);
  const title = skillExampleTitle(slug);
  if (!markdown || !title) return undefined;
  return renderMarkdownPage(
    `j01n.me — ${title}`,
    markdown,
    `<p><a href="/skill">← back to agent skill</a> | <a href="/skill/SKILL.md">download SKILL.md</a></p>`,
  );
}

export function skillPage(): string {
  const content = skillMarkdown.replace(/^---[\s\S]*?---\n/, "");
  const downloadBlock =
    `<p><a class="button" href="/skill/SKILL.md" download>Download SKILL.md</a></p>` +
    `<p>Direct link: <code>https://j01n.me/skill/SKILL.md</code></p>`;
  return renderMarkdownPage(
    "j01n.me — agent skill",
    content,
    `<p><a href="/">← back to j01n.me</a> | <a href="/security">security model</a></p>\n${downloadBlock}`,
  );
}
