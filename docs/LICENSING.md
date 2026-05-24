# Licensing

The 41d.us open core is licensed under the Apache License 2.0.

See:

- [`../LICENSE`](../LICENSE)
- [`../NOTICE`](../NOTICE)

## Open Core

The Apache-2.0 license applies to the open-core repository contents unless a file explicitly states otherwise.

The open core includes the free ephemeral coordination implementation, SDK, agent skill, docs, tests, and related examples.

## Enterprise Features

Future enterprise features may be developed separately under a proprietary commercial license.

Examples of enterprise features include:

- persistent spaces;
- organization management;
- billing;
- admin dashboards;
- audit logs;
- retention policies;
- RBAC;
- enterprise OIDC management;
- managed integrations;
- dedicated or self-hosted enterprise packaging.

Commercial feature-boundary planning lives outside this open-core repository.

## Package Publication

`package.json` currently has `"private": true` to prevent accidental npm publication. This does not change the source license.
