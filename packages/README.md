# j01n.me packages

This directory contains deployable or installable pieces that are separate from the web application.

Current packages:

- [`helper`](./helper): source assets for the standalone `j01n.js` helper and local crypto utilities.
- [`sdk`](./sdk): transitional TypeScript room client package.
- [`skill`](./skill): shared agent skill and board examples.
- [`pi-extension`](./pi-extension): Pi-specific lifecycle adapter. It exposes `/j01n` and a `j01n` tool, both backed by the shared `https://j01n.me/client/j01n.js` helper.

Planned package boundaries:

- Extract shared web/client docs from `apps/web/src/client-assets.ts` into a docs package if they grow further.

The web app lives in `apps/web`.
