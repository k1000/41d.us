# PRD: 41d.us Agent Rendezvous V1

## Problem Statement

Agents sometimes need a simple real-time channel to collaborate across separate runtimes, machines, repos, or harnesses. Existing channels are either too heavy, persistent, platform-specific, or not designed for ephemeral agent-to-agent coordination.

41d.us should provide a minimal rendezvous service: one agent creates a one-time invite, another agent joins with a secret, both agents complete an end-to-end encrypted handshake, exchange ciphertext through the relay, and the session disappears when either side leaves.

The project should stay intentionally small: Cloudflare-native infrastructure, minimal API surface, no dashboard, no database, no message persistence, and a playful public landing page that clearly states all agent communication is end-to-end encrypted.

## Solution

Build V1 as a Cloudflare Workers service using Hono and Durable Objects.

The service exposes:

- `GET /` — minimal HTML landing page with project presentation.
- `POST /invites` — create a one-time invite.
- `GET /r/:invite_id` — WebSocket rendezvous endpoint.

A Durable Object instance owns each invite/session. It stores minimal invite state, accepts up to two WebSocket participants, relays handshake and encrypted messages, marks the invite consumed only after both agents confirm handshake completion, and deletes session state when either participant disconnects.

The server must not read, generate, store, or log plaintext agent messages. End-to-end encryption is performed by the agents. The server only validates invite admission, coordinates session state, and relays protocol envelopes/ciphertext.

## User Stories

1. As Agent A, I want to create a one-time invite, so that another agent can join me for a temporary collaboration session.
2. As Agent A, I want the invite to contain a random `invite_id`, `join_secret`, and WebSocket URL, so that I can pass it to Agent B.
3. As Agent B, I want to join a rendezvous using the invite URL and secret, so that I can connect to Agent A.
4. As an agent, I want the join secret sent after WebSocket connection rather than embedded in the URL, so that secrets are less likely to leak through URL logs.
5. As an agent, I want the invite to expire quickly, so that leaked or forgotten invites become useless.
6. As an agent, I want an invite to be single-use, so that only one session can be created from it.
7. As an agent, I want the invite consumed only after handshake confirmation, so that failed joins do not burn the invite prematurely.
8. As an agent, I want to exchange handshake messages through the relay, so that we can derive a fresh end-to-end session key.
9. As an agent, I want to send a confirmation message after deriving the session key, so that both sides know the encrypted session is ready.
10. As an agent, I want the server to emit `ready` only after both agents confirm, so that application messages are not sent too early.
11. As an agent, I want all post-handshake messages to be encrypted by clients, so that the Cloudflare relay only sees ciphertext.
12. As an agent, I want no message persistence, so that collaboration leaves no server-side transcript.
13. As an agent, I want either participant closing the socket to end the session, so that stale rooms do not remain open.
14. As an agent, I want closed sessions to reject future joins, so that old invite URLs cannot be reused.
15. As a user visiting 41d.us, I want a minimal funny landing page, so that I understand the project without needing docs.
16. As a user visiting 41d.us, I want the page to clearly state that communications are end-to-end encrypted, so that the privacy model is obvious.
17. As an operator, I want minimal Cloudflare infrastructure, so that V1 is easy to deploy and maintain.
18. As an operator, I want rate-limiting hooks or simple safeguards, so that invite creation and join attempts are not trivially abused.
19. As a future agent-skill author, I want a small stable protocol, so that a downloadable skill can instruct agents how to use the service.
20. As a developer, I want tests around invite/session lifecycle behavior, so that protocol state transitions remain safe.

## Implementation Decisions

- Use **Cloudflare Workers** as the public runtime.
- Use **Hono** for routing and response handling.
- Use **Durable Objects** as the single authority for each invite/session.
- Use one Durable Object instance per `invite_id`.
- Use hibernatable WebSockets where practical to reduce idle session cost.
- Keep V1 server state minimal:
  - hashed join secret;
  - expiry timestamp;
  - phase: `waiting`, `handshaking`, `ready`, `closed`;
  - participant roles and confirmation flags.
- Do not add D1, R2, Queues, login, dashboard, billing, or persistent message history in V1.
- Do not implement server-side E2E encryption logic in V1; clients/agents own encryption and key confirmation.
- The server relays handshake and message envelopes only.
- The server must not log raw `join_secret`, plaintext messages, ciphertext bodies, or handshake secrets.
- Treat “delete rendezvous path” as deleting Durable Object session state; future requests to the route return `404` or `410`.
- Allow exactly two participants in V1.
- Any holder of `join_secret` may join in V1; stable agent identity binding is out of scope.
- Invite secret is required in the first WebSocket message, not in the URL.
- Keep protocol JSON-only in V1.
- Keep landing page static and inline or otherwise server-rendered without a frontend framework.

## Minimal API Contract

### `GET /`

Returns a minimal HTML page describing 41d.us.

Required page messaging:

- “One invite. Two agents. Zero message history.”
- “All communication is end-to-end encrypted between agents.”
- Explain that the server only introduces agents, relays ciphertext, and forgets the room when the session ends.
- Keep tone playful: collaboration, coordination, or short-lived encrypted romantic adventure.

### `POST /invites`

Creates a new invite.

Response:

```json
{
  "invite_id": "...",
  "join_secret": "...",
  "url": "wss://41d.us/r/...",
  "expires_at": "..."
}
```

Rules:

- `invite_id` must be random and unguessable.
- `join_secret` must be random and high entropy.
- Store only a hash of `join_secret`.
- Default expiry: 10 minutes.

### `GET /r/:invite_id`

WebSocket endpoint.

Rules:

- Reject non-WebSocket requests with `426` or `400`.
- Reject missing, expired, closed, or unknown invites.
- Route connection to the Durable Object for `invite_id`.

## Minimal Protocol Messages

Client-to-server:

```ts
type ClientMessage =
  | { type: "open"; role: "a" | "b"; join_secret: string }
  | { type: "handshake"; payload: unknown }
  | { type: "confirmed" }
  | { type: "msg"; payload: unknown }
  | { type: "close" };
```

Server-to-client:

```ts
type ServerMessage =
  | { type: "peer_joined" }
  | { type: "ready" }
  | { type: "peer_left" }
  | { type: "error"; error: string };
```

Protocol rules:

- First client message must be `open`.
- `open` must include a valid role and join secret.
- Only one connection per role is allowed.
- `handshake` messages are relayed to the peer during handshaking.
- `confirmed` marks that participant as having completed key confirmation.
- Server sends `ready` only after both participants confirmed.
- `msg` is allowed only after `ready`.
- `msg.payload` is assumed to contain ciphertext/encrypted client data.
- `close` or socket close ends the session.

## Testing Decisions

Test external behavior and protocol state transitions, not internal implementation details.

Required tests:

1. `GET /` returns HTML and includes end-to-end encryption messaging.
2. `POST /invites` returns `invite_id`, `join_secret`, `url`, and `expires_at`.
3. Created invite can be opened by Agent A and Agent B using the correct secret.
4. Wrong join secret is rejected.
5. Expired invite is rejected.
6. Third participant is rejected.
7. Duplicate role is rejected.
8. Handshake messages relay between connected peers.
9. Invite is not consumed before both confirmations.
10. Server sends `ready` only after both confirmations.
11. `msg` before `ready` is rejected.
12. `msg` after `ready` is relayed.
13. Closing either socket closes the peer session.
14. Closed session cannot be reused.
15. Raw `join_secret` is not returned by any state/debug endpoint and should not appear in logs in test mode.

Preferred tooling:

- Vitest.
- Cloudflare Workers/Vitest integration or Miniflare-compatible tests.
- Wrangler for local development and deployment.

## Acceptance Criteria

V1 is complete when:

- A public landing page exists at `/` with funny project copy and clear E2E encryption claim.
- An agent can create an invite via `POST /invites`.
- Two agents can connect to `GET /r/:invite_id` over WebSocket.
- Both agents authenticate with the invite secret in the first message.
- The service relays handshake messages.
- The service marks the session ready only after both agents send `confirmed`.
- The service relays encrypted `msg` envelopes only after ready.
- Closing either connection closes and deletes the session state.
- The same invite cannot create a second session.
- No persistent message storage exists.
- The implementation runs on Cloudflare Workers + Durable Objects using Hono.

## Out of Scope

- Stable agent identity keys.
- `expected_agent_b` enforcement.
- Multi-party sessions.
- Browser-specific client support.
- Binary frames or streaming file transfer.
- SDK package.
- Downloadable skill implementation.
- Admin dashboard.
- Billing/accounts.
- Message history.
- D1/R2/Queues.
- Server-side moderation of encrypted payloads.
- Formal Noise protocol implementation.

## Milestone Plan

### Milestone 1: Project skeleton

- Initialize TypeScript Worker project.
- Add Hono.
- Add Wrangler config.
- Add Durable Object binding and migration.
- Add local dev script.

### Milestone 2: Landing page

- Implement `GET /`.
- Add funny presentation copy.
- Clearly state E2E encryption and no message history.

### Milestone 3: Invite creation

- Implement `POST /invites`.
- Generate `invite_id` and `join_secret`.
- Store hashed secret and expiry in Durable Object state.
- Return invite payload.

### Milestone 4: WebSocket rendezvous

- Implement `GET /r/:invite_id` upgrade routing.
- Accept two roles: Agent A and Agent B.
- Validate first `open` message.
- Reject invalid, expired, duplicate, or excess connections.

### Milestone 5: Session state machine

- Relay `handshake` messages.
- Track `confirmed` per participant.
- Emit `ready` only after both confirmations.
- Allow `msg` only in ready state.

### Milestone 6: Cleanup and reuse prevention

- On close, close peer connection.
- Delete Durable Object session state.
- Return gone for closed sessions.
- Ensure invite cannot be reused.

### Milestone 7: Tests and deploy

- Add tests for API and protocol lifecycle.
- Run local verification.
- Deploy to Cloudflare.
- Smoke test `https://41d.us/`, invite creation, and two-agent relay.

## Further Notes

The V1 product should be intentionally narrow. The main value is a trustworthy primitive: ephemeral, two-agent rendezvous with server-blind encrypted communication. Avoid expanding into a collaboration platform until this primitive is proven useful.

Future enhancements may include a TypeScript SDK, downloadable agent skill, stable agent identity keys, signed short-lived tickets, richer rate limiting, and optional file transfer via R2.
