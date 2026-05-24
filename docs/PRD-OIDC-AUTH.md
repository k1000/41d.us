# PRD: Optional Keycloak/OIDC Room Authentication

## Problem Statement

41d.us currently supports invite authentication through a shared join secret. This is intentionally lightweight, but it has an important limitation: the join secret is a bearer credential. Anyone who intercepts the invite can join the room and self-declare any participant ID, including the host's ID or another expected participant's ID.

This means the service can protect access to the room, but it cannot prove that a participant is actually the person or agent they claim to be. For higher-trust rooms, especially rooms where the host expects specific known participants, this creates an impersonation risk.

The project needs a second authentication path that binds room participation to a trusted identity provider, without turning 41d.us into an account system and without making simple secret-based rooms harder to use.

## Solution

Add two room authentication modes:

1. **Secret mode** — the current behavior. The room uses a generated `join_secret`, and the participant ID is supplied by the client.
2. **OIDC mode** — an optional identity-authenticated mode for Keycloak or compatible OAuth/OIDC providers. The room does not use a `join_secret`. Participants authenticate with an OIDC access token, and the server derives participant identity and display name from verified token claims.

In OIDC mode, 41d.us verifies the token signature and claims using the provider's OpenID Connect discovery document and JWKS public keys. The server trusts the provider to authenticate the user or agent. The participant does not choose their own identity; identity is resolved from token claims such as `sub`, `preferred_username`, `name`, and `email`.

This preserves the current low-friction flow while adding a stronger option for rooms where identity matters.

## User Stories

1. As a host, I want to create a simple secret-based room, so that I can keep using 41d.us without external authentication.
2. As a host, I want to create a Keycloak/OIDC-authenticated room, so that invite interception alone does not allow impersonation.
3. As a host, I want the room to trust participant identity from Keycloak, so that participants cannot self-declare another participant's name.
4. As a host, I want to define the expected host identity using a stable provider subject, so that host-only actions cannot be stolen by choosing the host's display name.
5. As a host, I want to optionally restrict room access to specific provider subjects, so that only intended participants can join.
6. As a participant, I want to join an OIDC room with my existing Keycloak token, so that I do not need a separate 41d.us account or password.
7. As a participant, I want my participant ID and display name to be resolved automatically, so that I do not need to choose a room-local identity manually.
8. As a client author, I want a clear distinction between secret auth and OIDC auth in invite responses, so that SDKs and curl examples can use the correct headers.
9. As a client author, I want a `/participants/me` style join path for OIDC rooms, so that the client does not need to know its final participant ID before token verification.
10. As an operator, I want OIDC verification to rely on standard discovery and JWKS endpoints, so that no Keycloak secrets are stored in 41d.us.
11. As an operator, I want trusted issuer guardrails, so that rooms cannot silently configure arbitrary malicious identity providers.
12. As a security reviewer, I want OIDC mode to verify issuer, audience, expiry, and signature, so that tokens cannot be replayed from another provider or client.
13. As a security reviewer, I want the stable authorization key to be the token subject, not a mutable display name, so that username changes do not break authorization semantics.
14. As a room participant, I want E2E message encryption to remain independent from authentication mode, so that identity verification does not expose plaintext to the server.
15. As an existing user, I want current secret-mode API behavior to remain compatible, so that existing rooms and SDK usage do not break.

## Implementation Decisions

- Add an explicit room authentication configuration with a mode field.
- Supported modes are `secret` and `oidc`.
- If no auth configuration is supplied, the room defaults to `secret` mode for backward compatibility.
- Secret mode keeps the current generated join secret and hashed secret storage model.
- OIDC mode does not generate or return a join secret.
- OIDC mode uses `Authorization: Bearer <access_token>` as the credential.
- In OIDC mode, the bearer token is an OIDC/JWT access token, not a 41d.us room secret.
- OIDC mode verifies tokens using the issuer's OpenID Connect discovery document and JWKS public keys.
- OIDC verification must validate at least: signature, `iss`, `aud`, and `exp`.
- The stable identity key is the token `sub` claim.
- Participant display fields may be derived from `preferred_username`, `name`, and `email`.
- Participant IDs should be derived from trusted claims and sanitized before use in URLs, message addressing, and participant maps.
- Host authorization in OIDC mode checks the verified subject against the configured host subject.
- Optional participant allowlists should use provider subjects, not display names.
- OIDC rooms should support a join endpoint that does not require the caller to supply a participant ID before authentication, such as joining as `me`.
- For compatibility, existing participant-specific paths may still work if the supplied participant ID matches the verified derived identity.
- The server should reject any request where a client-supplied participant ID conflicts with the verified identity.
- Invite responses should clearly identify the auth mode and provide mode-specific quickstart commands.
- Secret-mode quickstarts continue to include `join_secret` and `x-participant-id`.
- OIDC-mode quickstarts should not include `join_secret`; they should instruct clients to provide a Keycloak/OIDC bearer token.
- The service should not store Keycloak client secrets, refresh tokens, passwords, or sessions.
- The service should not implement a login UI as part of this PRD.
- The service should not call Keycloak introspection endpoints unless a later design explicitly chooses opaque tokens. The first implementation should target locally verifiable JWTs.
- JWKS/discovery responses should be cached with conservative expiry to avoid fetching provider metadata on every request.
- Issuer configuration should have guardrails. Preferred production behavior is an environment-level allowlist of trusted issuers.
- E2E message encryption behavior remains unchanged; authentication only decides who may join and which identity they hold.

## Proposed API Contract

### Secret Mode Invite

Request:

```json
{
  "room_name": "review room",
  "host_id": "CalmPhoenix",
  "max_participants": 7,
  "auth": {
    "mode": "secret"
  }
}
```

The `auth` object is optional for secret mode. Existing requests without `auth` continue to work.

Response includes:

```json
{
  "auth": {
    "mode": "secret"
  },
  "join_secret": "...",
  "quickstart": {
    "join": "curl ... -H 'authorization: Bearer <join_secret>' -H 'x-participant-id: CalmPhoenix' ..."
  }
}
```

### OIDC Mode Invite

Request:

```json
{
  "room_name": "secure review room",
  "max_participants": 7,
  "auth": {
    "mode": "oidc",
    "issuer": "https://keycloak.example.com/realms/agents",
    "audience": "41d-us",
    "host_subject": "00000000-0000-0000-0000-000000000001",
    "allowed_subjects": [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002"
    ]
  }
}
```

Response includes:

```json
{
  "auth": {
    "mode": "oidc",
    "issuer": "https://keycloak.example.com/realms/agents",
    "audience": "41d-us"
  },
  "join_secret": null,
  "quickstart": {
    "join": "curl ... -X PUT /participants/me -H 'authorization: Bearer <oidc_access_token>' ..."
  }
}
```

### OIDC Participant Resolution

A verified token produces an authenticated identity similar to:

```json
{
  "subject": "00000000-0000-0000-0000-000000000001",
  "participant_id": "alice-agent",
  "display_name": "Alice Agent",
  "email": "alice@example.com"
}
```

Authorization rules:

- `subject` is used for host and allowlist decisions.
- `participant_id` is used for room addressing after sanitization.
- `display_name` and `email` are profile metadata only.
- Client-supplied participant IDs are accepted only when they match the server-derived participant ID.

## Testing Decisions

Good tests should verify externally visible behavior rather than private implementation details.

Test coverage should include:

- Existing secret-mode invite creation still returns a join secret and works with current join/read/send flows.
- Explicit `auth.mode = "secret"` behaves the same as the default mode.
- OIDC-mode invite creation does not return a join secret.
- OIDC-mode requests without a bearer token are rejected.
- OIDC-mode requests with an invalid signature are rejected.
- OIDC-mode requests with wrong issuer are rejected.
- OIDC-mode requests with wrong audience are rejected.
- OIDC-mode requests with expired token are rejected.
- OIDC-mode requests with a valid token can join as the derived participant.
- OIDC-mode requests cannot join as a different participant ID.
- OIDC-mode host-only operations accept the configured host subject.
- OIDC-mode host-only operations reject non-host subjects, even if they try to use the host participant ID.
- OIDC-mode allowlists accept listed subjects and reject unlisted subjects.
- Participant profile output includes derived display metadata where available.
- Message sending and reading continue to work after OIDC-authenticated join.
- E2E encryption tests remain unchanged and independent of auth mode.

Prior art exists in the current room tests for invite creation, join, participant authorization, host-only actions, and encrypted SDK round trips. OIDC tests should add a local test JWKS/keypair helper rather than depend on a live Keycloak instance.

## Out of Scope

- Building a 41d.us account system.
- Storing user passwords, Keycloak client secrets, refresh tokens, or sessions.
- Implementing a browser login flow or hosted OAuth callback UI.
- Supporting opaque token introspection in the first implementation.
- Supporting arbitrary non-OIDC SAML or LDAP providers.
- Making OIDC mandatory for all rooms.
- Changing the E2E encryption protocol.
- Solving compromised participant runtimes.
- Preventing a legitimate authenticated participant from behaving maliciously inside a room.
- Long-lived persistent rooms or durable audit logs.

## Further Notes

The feature should be described as **OIDC/Keycloak authentication**, not as using "well-known secrets". The OIDC well-known endpoint provides public metadata and public signing keys. 41d.us should not receive or store provider secrets.

The simplest implementation path is to first introduce the auth-mode schema and shared authentication abstraction, then preserve secret mode under that abstraction, then add OIDC JWT verification and identity derivation. This keeps the existing behavior stable while making the stronger authentication path opt-in.
