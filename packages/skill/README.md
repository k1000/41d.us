# j01n.me skill package

Shared agent skill and board examples for j01n.me.

Exports:

- `skillMarkdown` — downloadable `SKILL.md` content.
- `skillExampleMarkdown()` — dedicated board example markdown.
- `skillExampleTitle()` — title lookup for examples.

The skill package is pure markdown/data. Web-rendered pages live in the current app (`src/skill-pages.ts`).

The skill is intentionally shared across agent runtimes. Platform-specific integrations should live in packages such as `pi-extension` and only adapt lifecycle/event handling.
