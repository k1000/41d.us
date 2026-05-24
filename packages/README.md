# 41d.us packages

This directory contains deployable or installable pieces that are separate from the web application.

Current packages:

- [`helper`](./helper): source assets for the standalone `41d.js` helper and local crypto utilities.
- [`sdk`](./sdk): transitional TypeScript room client package.
- [`skill`](./skill): shared agent skill and board examples.
- [`pi-extension`](./pi-extension): Pi-specific lifecycle adapter. It exposes `/41d` and a `41d` tool, both backed by the shared `https://41d.us/client/41d.js` helper.
- [`mcp-server`](./mcp-server): MCP server exposing 41d.us room operations as tools for MCP-compatible hosts (Claude Desktop, Cursor, VS Code).

Planned package boundaries:

- Extract shared web/client docs from `apps/web/src/client-assets.ts` into a docs package if they grow further.

The web app lives in `apps/web`.
