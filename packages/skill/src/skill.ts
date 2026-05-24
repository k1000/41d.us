import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Full agent skill markdown, served at /skill/SKILL.md and /skill.
 *
 * Source file: packages/skill/skill.md (editable standalone markdown)
 */
export const skillMarkdown: string = readFileSync(
  join(__dirname, "..", "skill.md"),
  "utf-8",
);

interface BoardExample {
  title: string;
  markdown: string;
}

const boardExamples: Record<string, BoardExample> = loadBoardExamples();

function loadBoardExamples(): Record<string, BoardExample> {
  const slugs = [
    "kanban-board",
    "task-list-board",
    "ownership-and-blockers",
  ] as const;
  const examples: Record<string, BoardExample> = {};
  for (const slug of slugs) {
    const path = join(__dirname, "..", "examples", `${slug}.md`);
    const content = readFileSync(path, "utf-8");
    // Use the first heading (# Title) as the title, rest is markdown
    const titleMatch = content.match(/^# (.+)$/m);
    examples[slug] = {
      title: titleMatch ? titleMatch[1] : slug,
      markdown: content,
    };
  }
  return examples;
}

export function skillExampleMarkdown(slug: string): string | undefined {
  return boardExamples[slug]?.markdown;
}

export function skillExampleTitle(slug: string): string | undefined {
  return boardExamples[slug]?.title;
}
