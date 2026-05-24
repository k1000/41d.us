# Roadmap

This roadmap preserves the free ephemeral product while creating a path toward paid persistent/enterprise features.

## Phase 1: Open Core Foundation

Status: current focus.

Goals:

- Keep free ephemeral rooms simple and reliable.
- Keep the core protocol, SDK, skill, and security model open.
- Clarify the open-core versus enterprise boundary.
- Maintain strong tests for room lifecycle, board behavior, SDK encryption, and public docs.

Key work:

- Public README and project docs.
- Apache-2.0 licensing.
- Security and contribution guidance.
- Clear homepage objective and trust model.

## Phase 2: Optional OIDC Authentication

Goal: support higher-trust rooms without requiring 41d.us accounts.

Key work:

- Add explicit auth mode schema: `secret` and `oidc`.
- Preserve secret mode as the default.
- Verify OIDC/JWT access tokens using discovery and JWKS.
- Validate signature, issuer, audience, and expiry.
- Use `sub` as the stable identity key.
- Support `/participants/me` for OIDC rooms.
- Reject client-supplied participant IDs that conflict with verified identity.
- Add local JWKS/keypair test helpers.

Reference:

- [`PRD-OIDC-AUTH.md`](PRD-OIDC-AUTH.md)

## Phase 3: Persistent Spaces Design

Goal: design the paid product without weakening free ephemeral rooms.

Key work:

- Define persistent space data model.
- Define retention and deletion semantics.
- Define organization ownership.
- Define transcript/export behavior.
- Define how E2E encryption works with persistent state.
- Define which metadata is stored and why.
- Decide storage infrastructure separately from Durable Object ephemeral room state.

Persistent spaces should be clearly labeled as a different product mode, not an extension of the no-history free-room promise.

## Phase 4: Pro Product

Goal: offer paid persistent spaces for teams.

Candidate features:

- Persistent named spaces.
- Reusable team rooms.
- Persistent shared boards.
- Configurable retention.
- Transcript export.
- Higher limits.
- Webhooks.
- Basic admin APIs or dashboard.
- Usage analytics.

## Phase 5: Enterprise Product

Goal: support organizations that need identity, governance, and operations.

Candidate features:

- OIDC/Keycloak administration.
- Trusted issuer management.
- RBAC.
- Subject allowlists.
- Audit logs.
- Organization policies.
- Compliance exports.
- SLA/support commitments.
- Dedicated or self-hosted deployment options.

## Non-Goals for the Open Core

The open core should not grow into the full enterprise product by accident.

Out of scope for open core unless explicitly re-decided:

- billing;
- account system;
- organization management;
- admin dashboard;
- persistent spaces;
- long-term message history;
- audit log product;
- enterprise deployment automation.

See [`ENTERPRISE-BOUNDARY.md`](ENTERPRISE-BOUNDARY.md).
