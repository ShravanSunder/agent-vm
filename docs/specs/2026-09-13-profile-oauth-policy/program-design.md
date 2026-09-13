# Profile-owned OAuth policy design

[Specification](specification.md) defines the observable contract; [Requirements](requirements.md) defines its authorized boundary.

## Configuration and runtime ownership

```text
OAuth file: registrations, credentials, website, human admission
                         │
Tool Portal file         │
  agents → profiles      │
             ├─ commands │
             └─ oauthApplications → registered application ID
                         │
                         ▼
                 compileOAuthPolicy (synchronous, no I/O)
                 ├─ validate references, catalog and executable limits
                 ├─ resolve per-application selections and defaults
                 └─ derive per-agent runtime authorization inputs
                         │
                         ▼
                 Controller OAuth composition
                 ├─ broker: enrollment and granted consent
                 └─ policy service: live defaults and account overrides
                         │
                         ▼
                 Existing encrypted account catalog
```

`config-contracts` owns authored schemas and compilation. Profiles own authored role policy. OAuth registrations own provider bindings, not agent policy. Controller composition supplies compiler-derived inputs to the broker. The broker and account-policy services retain their existing account state and runtime enforcement responsibilities.

## Separate authored and resolved inputs

The authored `OAuthConfig` no longer has `agents`. A distinct resolved runtime type combines the authored connection configuration with a derived agent/application ceiling map. It is not an accepted deployment file format or a compatibility reader. Only compilation creates the production resolved value. Broker/website APIs that need agent policy accept that resolved type; credential-only consumers may accept the authored base type.

Each managed profile has optional `oauthApplications`. Application entries contain a required ceiling plus independently optional consent recommendation and policy defaults. The schema stays generic in property naming while retaining currently supported application IDs and Google catalog behavior. No new provider framework is introduced.

Each collection reference is resolved independently against the application's registered family. Explicit recommendation group IDs use existing identifier and uniqueness constraints. Explicit defaults use the existing service-disposition schema. The compiler rejects invalid references and values before startup. Profiles without OAuth declarations remain valid for non-OAuth tools; reachable OAuth commands without declarations fail.

Agent admission is derived from selected profiles with nonempty application maps. Owner/editor agent references must resolve to that derived set. Unused profile declarations are validated against registrations, catalog groups and collection references too. Any profile-level `oauthApplications` declaration requires the sibling OAuth file and compilation, including unused or commandless profiles. Static validation, effective-config preparation, and controller startup must detect declaration presence as well as OAuth commands; missing required OAuth files fail closed. Executable validation covers each selected profile.

## Current-to-target calls

Current source anchors are `packages/config-contracts/src/oauth-tool-portal-config.ts`, `packages/agent-vm/src/controller/oauth/controller-oauth-runtime.ts`, and `packages/oauth-broker/src/google/google-oauth-permission-policy.ts`.

```text
CHANGED: authored OAuth agents + Tool Portal agent defaults
      → profile oauthApplications → compiler-derived per-agent inputs

CHANGED: loadSelectedOAuthConfiguration
      → compileOAuthPolicy → pass resolved configuration to runtime
      ← validation error aborts startup, before credential catalog boot

UNCHANGED: agent begin/reauthorize → broker validates offered selections
      → browser transaction → human consent → encrypted account grant
      ← authorization URL / status / failure

CHANGED INPUT ONLY: enrollment view → compiled recommendation selections
      ← new enrollment preselection; existing grant selection preserved

UNCHANGED: Tool Portal call → controller policy service → catalog account state
      → resolveGoogleAccountInvocationPolicy → deny / consent-required / ask / allow
      ← preflight binding; dispatch revalidates freshness
```

CHANGED discovery edge: profile application declarations, as well as configured OAuth commands, trigger sibling OAuth loading and compilation in static validation and effective-config preparation. Controller startup also rejects a missing OAuth file when such declarations or commands require it.

PRESERVED projection edge: compilation consumes full authored profiles; prepared, effective, MCP Portal and Gateway Runtime projections then omit `oauthApplications`. The full authored inputs remain in OAuth configuration-revision calculation. Gateway and credentialed-runtime projection revisions retain their existing runtime material rather than acquiring controller-only policy.

All compilation edges are synchronous and pure. Broker/controller operations remain async at their existing HTTP, catalog, credential and publication boundaries. Tool definitions do not choose arbitrary effect mappings: the pinned Gog catalog still resolves command family to the declared application.

## Defaults and stored state

No account key, override cell, authorization record, or encryption format changes. Compilation still outputs per-agent/application defaults because runtime decisions and account identity are agent-scoped. Agents sharing a profile receive equal configured values but retain independent account records.

Retain the existing defaults snapshot format and activation mechanism. Its per-agent source is a shared collection only when all declared defaults come from the same collection/version; mixed or explicit defaults are normalized to an explicit resolved map; entirely absent defaults use missing. The effective default map and stable source summary participate in the existing revision calculation; consent recommendations do not. This avoids adding per-application persisted provenance that no runtime consumer uses. Collection changes affecting default values still change the revision. The source summary is resolved-map provenance, not an additional policy authority.

Configuration revision continues to include full authored profile inputs, so recommendation/ceiling changes still invalidate stale ceremonies and dispatch bindings through existing fencing. Defaults activation continues to publish an existing-format snapshot under the existing publication guard. Existing account override revisions are not rewritten by moving configuration.

## Failure, trust, and cutover

Malformed or contradictory role configuration fails closed during compilation. Unknown application/collection, foreign groups, ceiling violations, or non-deny defaults without executable support produce errors rather than silently reducing permissions. No new retry or recovery path is introduced. Runtime account-policy and consent guards remain authoritative; profiles cannot impersonate account owners or change command effects.

Old authored locations are rejected in the new schema. Deployment authors move each agent's policy into its selected complete profile, splitting profiles when policies differ. Named recommendations and named defaults must be declared separately. OAuth registrations and existing account state remain in place. Rollback requires restoring the matching older config and binary together; no dual config reader is provided.

The alternative of adding selections under agent-level defaults is smaller but leaves the ownership confusion unresolved. Complete profiles eliminate that ambiguity at the cost of repeating tool definitions for differing roles; deployment authors bear that cost. Profile inheritance is deliberately excluded. Revisit only if concrete deployment duplication warrants a separately designed mechanism.

## Proof seams

- R1–R5: real authored parsers/compiler, per-agent outputs, unknown/foreign/excessive inputs, shared and distinct profiles. Types plus strict schemas and runtime compilation guards enforce ownership.
- R2/R6: compiler output → real broker enrollment/view model → observable selected group IDs; Google identity/token exchange may use the existing external adapter seam. This proves local enrollment wiring, not live Google consent.
- R6/R7: existing real encrypted catalog/account-policy integration paths exercise inherited defaults, explicit overrides, cross-agent isolation, activation and dispatch fencing. External VM execution need not run to prove a configuration ownership change.
- R8: actual built CLI validates temp-root configs and generates deployment manuals. Real filesystem/CLI observations complement pure schema tests.

UI layout, provider protocols, VM lifecycle, concurrency primitives and performance behavior are unchanged; no new mechanisms are required for those concerns.
