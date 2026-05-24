# Open Source Strategy for 41d.us

## Decision

41d.us should use an **open core** model if the project moves toward monetization.

The free ephemeral coordination product should remain open and inspectable because trust is central to adoption. The paid persistent/enterprise product should remain proprietary because it contains the monetizable implementation: organization management, persistence, governance, auditability, billing, and managed operations.

## Rationale

41d.us makes security-sensitive claims:

- the server should not see plaintext;
- free rooms are ephemeral;
- there are no accounts in the free flow;
- there is no persistent room history in the free flow;
- client-side encryption protects message bodies.

These claims are more credible when the core protocol, SDK, and ephemeral room implementation are open to inspection.

At the same time, opening the full commercial implementation would make it easier for a competitor to clone the hosted product, especially if the paid roadmap includes persistent spaces, OIDC, audit logs, admin dashboards, retention policies, integrations, and billing.

The strategic goal is therefore:

> Open-source the trust and adoption layer. Keep the enterprise product layer proprietary.

## What Should Be Open Source

The open-source core should include the parts needed to understand, verify, and integrate with the free ephemeral room model.

Recommended open components:

- Free ephemeral room protocol.
- Secret-based invite flow.
- Basic room lifecycle implementation.
- Client SDK.
- Agent skill.
- Public API documentation.
- Security model documentation.
- Client-side E2E encryption implementation.
- Tests for the core protocol and encryption behavior.
- Minimal examples and quickstarts.

These components help developers and agent authors trust and adopt 41d.us without exposing the full commercial product.

## What Should Stay Proprietary

The proprietary layer should include features that create enterprise value and operational defensibility.

Recommended closed components:

- Persistent spaces.
- Organization management.
- Billing and plan enforcement.
- Admin dashboard.
- Enterprise OIDC administration UI.
- Organization-level trusted issuer management.
- RBAC and policy management.
- Audit logs.
- Configurable retention policies.
- Compliance exports.
- Usage analytics.
- Managed integrations.
- SLA/operations tooling.
- Dedicated deployment automation.
- Self-hosted enterprise packaging, if offered commercially.

These are the features customers are most likely to pay for, and they are also the easiest for a competitor to reuse if released as-is.

## OIDC Boundary

OIDC/Keycloak support sits on the boundary between trust infrastructure and enterprise monetization.

Recommended split:

### Open

- Protocol-level OIDC documentation.
- JWT verification primitives where useful.
- Clear explanation of identity binding and subject-based authorization.
- Tests or examples showing the security model.

### Proprietary

- Organization-level OIDC configuration.
- Trusted issuer allowlist management UI.
- Enterprise policy enforcement.
- RBAC integration.
- Audit-log integration.
- Admin experience for Keycloak/OIDC setup.

This keeps security-critical behavior reviewable while preserving the commercial value of enterprise identity management.

## Licensing Options

### Option A: Permissive Core

Core license: MIT or Apache-2.0  
Enterprise license: proprietary

Pros:

- Easiest for adoption.
- Friendly to SDK users and agent framework authors.
- Low friction for contributors.

Cons:

- Competitors can host the open core.
- Weak protection against free-tier clones.

### Option B: AGPL Core

Core license: AGPL-3.0  
Enterprise license: commercial/proprietary

Pros:

- Discourages hosted competitors from modifying and running the service without publishing changes.
- Keeps network-service improvements open.

Cons:

- Some companies avoid AGPL dependencies.
- May reduce adoption by enterprise users and SDK consumers.

### Option C: Source-Available Core

Core license: Business Source License or similar  
Enterprise license: commercial/proprietary

Pros:

- Code remains visible for review.
- Stronger protection against direct commercial hosting.

Cons:

- Less community goodwill than true open source.
- More licensing complexity.

## Recommendation

Start with **permissive open core plus proprietary enterprise** unless direct hosted cloning becomes a serious threat.

Selected initial split:

- Core: Apache-2.0.
- Enterprise: proprietary.
- Public docs: open.
- SDK: open.
- Agent skill: open.
- Persistent spaces and organization features: closed.

The repository now includes a root `LICENSE` and `NOTICE` for the open core. The package remains marked `private: true` to prevent accidental npm publication; that flag does not change the source license.

If hosted cloning becomes a major risk, reconsider AGPL or a source-available license for the server core while keeping SDK/protocol packages permissive.

## Repository Strategy

Two practical structures are possible.

### Option 1: Separate Repositories

```text
41d.us-core/          open source
41d.us-enterprise/    proprietary
```

Pros:

- Clear licensing boundary.
- Easier to keep proprietary code private.
- Public repo stays focused and clean.

Cons:

- More integration overhead.
- Shared types/protocol code need package boundaries.

### Option 2: Monorepo with License Boundaries

```text
41d.us/
  packages/protocol/          open
  packages/sdk/               open
  packages/skill/             open
  apps/ephemeral-worker/      open
  enterprise/                 proprietary/private or excluded
```

Pros:

- Easier code sharing.
- Single development workflow.

Cons:

- Higher risk of accidentally exposing proprietary code.
- Requires strict license and release discipline.

Recommended path: begin with the current repository as the open core, and create a separate private repository for enterprise features when they begin.

## Product Boundary

The public/open product should be described as:

> Free ephemeral encrypted coordination rooms for agents.

The paid/proprietary product should be described as:

> Persistent authenticated collaboration spaces for teams and organizations.

This avoids confusing users and preserves the strongest security promise for the free product.

## Risks and Mitigations

### Risk: Competitors clone the free hosted core

Mitigation: Keep the free core useful but limited. Monetize persistence, governance, operations, integrations, and support.

### Risk: Closed enterprise code reduces trust

Mitigation: Keep protocol, SDK, encryption, and security docs open. Document enterprise data retention and metadata behavior clearly.

### Risk: License choice blocks adoption

Mitigation: Start permissive for SDK/protocol. Consider stronger licensing only for server components if needed.

### Risk: Proprietary features leak into open promises

Mitigation: Maintain separate docs for ephemeral mode and persistent enterprise mode. Never claim “no history” for persistent spaces.

## Immediate Next Steps

See also `docs/ENTERPRISE-BOUNDARY.md` for the feature-level open-core versus enterprise split.

1. Keep the current ephemeral implementation as the public/open core.
2. Avoid adding billing, organization management, or persistent spaces to the open core by default.
3. Treat `docs/PRD-OIDC-AUTH.md` as a boundary feature: implement carefully, but decide which pieces belong in open core versus enterprise before release.
4. Keep `docs/PRD-MONETIZATION.md` aligned with this open-core strategy.
5. Add licensing deliberately before public release.
