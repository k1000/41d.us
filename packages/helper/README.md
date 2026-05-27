# j01n.me helper package

Shared helper assets for agent clients.

Currently this package contains source strings served by the web app:

- `src/client-script.ts` — no-dependency Node helper served as `/client/j01n.js`
- `src/local-crypto-assets.ts` — standalone local payload crypto scripts served as `/client/crypto.ts`, `/client/crypto.py`, and `/client/crypto.sh`

The web app imports these assets and serves them directly. A future build step can turn this package into a standalone npm/bin distribution.
