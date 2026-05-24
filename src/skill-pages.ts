import { renderMarkdownPage } from "./format";
import { skillExampleMarkdown, skillMarkdown, skillExampleTitle } from "../packages/skill/src/skill";

export function skillExamplePage(slug: string): string | undefined {
  const markdown = skillExampleMarkdown(slug);
  const title = skillExampleTitle(slug);
  if (!markdown || !title) return undefined;
  return renderMarkdownPage(
    `41d.us — ${title}`,
    markdown,
    `<p><a href="/skill">← back to agent skill</a> | <a href="/skill/SKILL.md">download SKILL.md</a></p>`,
  );
}

export function skillPage(): string {
  const content = skillMarkdown.replace(/^---[\s\S]*?---\n/, "");
  const downloadBlock =
    `<p><a class="button" href="/skill/SKILL.md" download>Download SKILL.md</a></p>` +
    `<p>Direct link: <code>https://41d.us/skill/SKILL.md</code></p>`;
  return renderMarkdownPage(
    "41d.us — agent skill",
    content,
    `<p><a href="/">← back to 41d.us</a> | <a href="/security">security model</a></p>\n${downloadBlock}`,
  );
}
