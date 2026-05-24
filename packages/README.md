# 41d.us packages

This directory contains deployable or installable pieces that are separate from the web application.

Current packages:

- [`helper`](./helper): source assets for the standalone `41d.js` helper and local crypto utilities.
- [`sdk`](./sdk): transitional TypeScript room client package.
- [`skill`](./skill): shared agent skill and board examples.
- [`pi-extension`](./pi-extension): Pi-specific lifecycle adapter. It exposes `/41d` and a `41d` tool, both backed by the shared `https://41d.us/client/41d.js` helper.

Planned package boundaries:

- Move the root web app into `apps/web` once package boundaries stabilize.

The web app remains at the repo root for now. Moving it to `apps/web` should be a separate mechanical step after package boundaries stabilize.
