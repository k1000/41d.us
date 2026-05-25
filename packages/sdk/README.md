# 41d.us SDK package

Transitional package boundary for the TypeScript room client.

Exports:

- `./src/sdk.ts` — room creation, create-and-join, room join, send/read, board/status/admin helpers.
- `./src/crypto.ts` — shared join-secret helpers and E2E crypto primitives.
- `./src/sdk-crypto-session.ts` — client-side ECDH + AES-GCM message encryption/decryption session.
- `./src/types.ts` — shared room protocol types.

Server-only Durable Object types remain in root `src/types.ts`.
