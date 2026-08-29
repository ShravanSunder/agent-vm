# Remove OpenClaw Specification

Requirements authority: [`requirements.md`](requirements.md)

## Observable target

```text
deployment operator
  -> Agent VM CLI and generated deployment
  -> Hermes managed Gateway or Worker task Gateway

managed Hermes agent
  -> framework-neutral portal and sandbox behavior
  -> controller-authorized Tool VM and host actions

release operator
  -> remaining Agent VM artifacts only
```

OpenClaw is absent from the active product. Historical Git records and already
published immutable artifacts are not active product surfaces.

## Problems and outcomes

| ID | Problem | Required outcome |
| --- | --- | --- |
| P1 | Agent VM exposes and maintains two managed interactive-agent frameworks. | O1: Hermes is the sole managed interactive-agent Gateway implementation. |
| P2 | Hermes is implemented but lacks a supported scaffold/default journey. | O2: operators can create and operate a Hermes deployment through supported CLI and documentation. |
| P3 | Shared schemas and runtime contracts encode OpenClaw variants. | O3: active contracts describe only Hermes and Worker truth without OpenClaw compatibility residue. |
| P4 | Deleting OpenClaw could accidentally delete framework-neutral capabilities or weaken safety boundaries. | O4: Hermes and Worker retain their authorized observable behavior and proof. |
| P5 | OpenClaw artifacts can remain active through build, test, docs, or release metadata after runtime code disappears. | O5: active repository and release surfaces no longer offer or publish OpenClaw. |

## Context and negative space

```text
                        ┌──────────────────────────────┐
deployment operator ──►│                              │──► Hermes Gateway
managed Hermes agent ─►│       Agent VM product       │──► Tool Portal / Tool VM
Worker API caller ─────►│        (opaque here)         │──► Worker task result
release operator ──────►│                              │──► remaining artifacts
                        └──────────────────────────────┘

not a consumer after cutover:
  OpenClaw configuration, plugins, state, commands, images, or clients

protected external boundaries:
  controller authority, secret mediation, storage/workspace isolation,
  approvals, observability, recovery, termination, and Worker task APIs
```

## Normative requirements

### R1 — Supported Gateway types

Agent VM MUST expose exactly two supported Gateway types:

- `hermes` for long-running managed interactive agents; and
- `worker` for on-demand task execution.

No public configuration, CLI help, generated schema, runtime record, or
operating documentation may present OpenClaw as a supported Gateway type.

If configuration declares an OpenClaw Gateway or an OpenClaw-only field, static
validation MUST reject it before build or controller startup. Rejection MUST NOT
silently reinterpret the configuration as Hermes or Worker.

Basis: U1, U2, U6, U7. Proof: V1, V3, V4.

### R2 — Hermes operator journey

The supported init surface MUST allow an operator to scaffold a complete Hermes
deployment for every currently supported host preset and architecture
combination that applies to managed Gateways.

The generated deployment MUST pass static validation without hand-editing and
MUST contain the configuration, image recipe, profile assignment, secret
projection placeholders, and operating guidance needed to build and start the
managed Hermes Gateway.

Hermes administration MUST use Hermes-native behavior. OpenClaw provider login,
OpenClaw auth-profile management, Codex-harness auth, and OpenClaw
all-secrets-shell behavior MUST NOT remain as supported commands or aliases.
Ordinary protected interactive administration for Hermes MUST remain available.

If required secrets, profile assignments, image inputs, or host prerequisites
are missing, validation or doctor output MUST identify the unsupported or
missing prerequisite before an unauthenticated or partially configured Gateway
is admitted as ready.

Basis: U2, U5, U6. Proof: V1, V2.

### R3 — Managed Hermes capability behavior

A managed Hermes agent MUST retain its current authorized operations through
the common managed runtime:

- Tool Portal list, search, describe, and call;
- artifact readback;
- sandbox environment open, close, and status;
- direct execution start, wait, and cancellation;
- filesystem stat, list, read, write, mkdir, rename, and remove;
- managed process start, status, wait, logs, and cancellation;
- bounded stream read, write, and close;
- terminal behavior required by Hermes' managed environment;
- controller-authorized Tool VM runner and host-action capabilities.

The caller-visible result, error, cancellation, ambiguity, artifact, and
approval meanings defined by the accepted Gateway Runtime contract MUST remain
unchanged for Hermes.

If a capability is unavailable or denied, the managed Hermes agent MUST receive
the existing typed bounded failure rather than a Gateway-local fallback or
OpenClaw compatibility path.

Basis: U3. Proof: V2, V5.

### R3a — Hermes Tool Portal orientation

The accepted Hermes Tool Portal orientation contract MUST remain unchanged.
Managed Gateway startup MUST begin one background namespace-availability
inventory per admitted Hermes profile and Gateway epoch without delaying
Gateway readiness or user turns. Inventory MUST remain bounded to one initial
attempt plus at most two retries within one 60-second overall deadline and MUST
use only the profile's controller-authored namespace projection.

For the exact identity `(Gateway epoch, admitted profile identity, Hermes
session_id)`, the existing `pre_llm_call` hook MUST return the deterministic
orientation at most once. The hook path MUST perform only nonblocking
process-local observations and MUST perform no Tool Portal I/O, wait on no
inventory future, and mutate neither the system prompt nor registered tool
schemas. The orientation MUST retain its existing 20-name and 2,000-byte limits
and must contain no schemas, tool descriptions, credentials, arguments,
results, or complete catalog.

Retry, deadline, or malformed-response exhaustion MUST retain the existing
ready all-unavailable orientation behavior. Invalid or withdrawn profile
authority MUST suppress orientation without consuming the session injection
identity. Different profiles, sessions, and Gateway epochs MUST remain
independent, and concurrent first ready turns for one identity MUST produce
exactly one orientation result.

Basis: U3, U4, U9 and the accepted Hermes Tool Portal orientation Requirements
and Specification. Proof: V7.

### R4 — Identity, workspace, and isolation

Hermes profile identity MUST remain the managed framework identity used to bind
each configured agent to exactly its controller-authored projection. Different
agents and profiles MUST NOT share Tool VM bindings, SSH connections,
environment/process/stream handles, Tool Portal authority, workspace state, or
secret projections.

Managed Hermes filesystem and command behavior MUST continue to use the
controller-selected workspace and Tool VM paths defined by the current storage
contract. Removing OpenClaw MUST NOT restore raw host-path authority,
Gateway-local execution fallback, or cross-profile state access.

Basis: U3, U4. Proof: V2, V5.

### R5 — Controller and trust boundaries

The controller MUST remain the sole durable authority for Gateway and Tool VM
lifecycle, leases, credentials, approval freshness, recovery, and termination.
The managed VM adapter boundary, HTTP secret mediation, egress allowlists,
ingress admission, admin authorization, and exact-process containment
guarantees MUST remain unchanged except for removing OpenClaw-specific inputs.

No removed OpenClaw token, auth profile, plugin configuration, registry record,
or diagnostics setting may be loaded into Hermes, a Tool VM, Worker, or a
generated image.

Basis: U4, U6. Proof: V2, V5.

### R6 — Reliability, observability, and recovery

Hermes Gateway readiness, framework liveness, Tool Portal readiness, control
attachment, channel/provider health, Tool VM status, and recovery observations
MUST retain their current distinct meanings. Removing OpenClaw MUST NOT collapse
these health surfaces into one success signal or weaken the current bounded
recovery, fencing, no-flap, or sibling-containment guarantees.

This cutover MUST NOT independently change Hermes cache retirement, retry,
reconnect, reacquisition, or binding-publication behavior. Separately owned
Hermes recovery already merged into the integrated master baseline MUST be
retained rather than reverted or reimplemented. Recovery paths that pass on that
integrated baseline MUST remain green, including the first Tool VM operation
after control reattachment.

An OpenClaw E2E scenario MUST NOT become a new Hermes lifecycle obligation when
the retained Hermes runtime has different existing cache, active-use, idle, or
automatic-recovery semantics. Such a scenario MUST be recorded with its
observed gap and separate runtime owner. Its deferral is acceptable cutover
evidence only when the branch preserves current Hermes behavior and retains the
strongest same-or-equivalent proof that actually fits the retained product.

Hermes framework, Gateway Runtime, Tool Portal, controller, and Tool VM
telemetry MUST remain attributable to their current service and agent/profile
identities. OpenClaw telemetry identities and diagnostics extensions MUST NOT be
emitted by the retained product.

Basis: U4. Proof: V2, V5.

### R7 — Worker preservation

Worker configuration, task submission, task-state observation, controller-backed
git operations, task cancellation, VM lifecycle, and proof classification MUST
remain behaviorally unchanged.

A Worker deployment MUST NOT require Hermes configuration or managed-framework
profile material. Removing OpenClaw MUST NOT move Worker into the managed
interactive Gateway runtime or change its on-demand lifecycle.

Basis: U2, U7. Proof: V4.

### R8 — Clean compatibility boundary

The cutover MUST provide no OpenClaw compatibility alias, forwarding package,
deprecated enum value, feature flag, dual parser, runtime migration, state
reader, plugin adapter, or fallback branch.

Existing OpenClaw deployment configuration, state, auth profiles, conversations,
plugin registry data, images, and generated files are outside the supported
post-cutover product. Agent VM MUST leave them untouched rather than importing,
rewriting, or deleting operator-owned data automatically.

Previously published registry packages and container images MAY remain available
as historical artifacts, but the retained repository and release train MUST NOT
build or publish new OpenClaw artifacts.

Basis: U1, U6. Proof: V3, V6.

### R9 — Upstream version separation

The cutover MUST retain the exact packaged Hermes `0.20.0` source revision and
immutable OCI digest. A different Hermes source revision, project version, or
container digest is a separate product change and cannot be admitted as part of
this removal without new owner authority and qualification evidence.

Basis: U8. Proof: V3, V6.

### R10 — Active artifact completeness

Active source, schemas, portable contracts, generated declarations, fixtures,
CLI surfaces, manuals, canonical architecture and configuration documentation,
test projects, build inputs, package dependencies, publish inventories, and
managed image manifests MUST agree that OpenClaw is unsupported and Hermes is
the managed interactive Gateway.

Historical release records MAY retain accurate OpenClaw references. Any other
remaining occurrence MUST be classified as either required historical evidence
or an incomplete cutover; an unclassified residue fails this requirement.

Basis: U1, U5, U6, U9. Proof: V3, V6.

## Observable contracts

### C1 — CLI and generated deployment

| Case | Observable result |
| --- | --- |
| Valid Hermes init request | A complete deployment is generated and can be validated without hand-editing. |
| Valid Worker init request | Existing Worker output and behavior remain unchanged. |
| OpenClaw init request | The CLI rejects the unsupported type; it does not emit partial files. |
| Config containing `gateway.type: openclaw` | Static validation rejects it before build or controller startup. |
| Hermes admin shell | Opens the protected Hermes-native interactive environment without exposing raw framework secrets by default. |
| Removed OpenClaw auth command | The CLI reports the command as unsupported or absent; it never forwards to Hermes. |

Unsupported CLI input is rejected before scaffold writes begin. Once a valid
scaffold starts writing, the command retains its existing incremental-write
behavior: a later filesystem or manual-generation failure may leave files
created before the failure. The cutover adds no transactional staging or
rollback guarantee; the operator may correct the cause and rerun with the
existing overwrite behavior or remove the incomplete target.

### C2 — Managed runtime

For a valid Hermes profile and admitted request, the existing canonical result
and runtime state are returned. For stale identity, invalid authority, denied
capability, unavailable Tool VM, lost control attachment, timeout, cancellation,
or ambiguous side effect, the existing bounded typed outcome remains visible.

The profile-scoped Tool Portal orientation remains a startup-populated,
session-once user-context result with the failure and prompt-cache boundaries in
R3a; it is not a fifth Tool Portal operation and does not broaden capability
authority.

No failure may route work into the Gateway VM, another agent's workspace, or a
removed OpenClaw adapter.

### C3 — Configuration compatibility

Only current Hermes and Worker configuration is supported. Unknown fields are
rejected according to existing strict-schema behavior. OpenClaw fields receive
no compatibility interpretation. Agent VM provides no automatic state or config
migration and makes no promise that an OpenClaw deployment can be rolled forward
without operator-authored replacement configuration.

### C4 — Release contents

The remaining synchronized Agent VM package train contains no dependency on or
packed copy of an OpenClaw package, plugin, managed image recipe, or configuration
asset. Removed package names receive no new version in the cutover release.

Registry deprecation of historical packages and destructive removal of
historical artifacts are undefined until separately authorized.

## Cross-cutting obligations

- Security: removal MUST preserve fail-closed authorization, secret custody,
  egress, path, workspace, approval, and process-containment boundaries.
- Reliability: the retained Hermes and Worker paths MUST be proven at their real
  runtime boundaries; lower-layer mocks cannot substitute for live VM behavior.
- Data lifecycle: the cutover MUST neither import nor delete OpenClaw-owned
  operator data automatically.
- Observability: retained service and profile identities MUST remain queryable;
  no OpenClaw telemetry identity may be emitted by current runtime behavior.
- Performance: removing OpenClaw MUST NOT add a second framework selection,
  compatibility, or translation step to Hermes or Worker runtime calls.
- Accessibility and visual UI: not applicable; this cutover changes CLI,
  configuration, runtime, and documentation surfaces rather than a visual UI.
- Platform compatibility: supported Hermes host presets and architectures MUST
  be explicit in generated output and proven according to their existing
  prerequisites.

## Proof obligations

| ID | Requirement coverage | Evidence class and pass condition |
| --- | --- | --- |
| V1 | R1, R2, C1, C3 | CLI transcript and generated-state inspection show Hermes init succeeds, generated output validates, Worker init is unchanged, and OpenClaw input is rejected without partial output. |
| V2 | R2–R6 | Real managed Hermes runtime evidence shows Gateway boot, authenticated profile routing, Tool Portal calls, Tool VM execution, filesystem write/read, process/stream behavior, observability, green integrated-baseline recovery after control reattachment, and protected admin SSH. Non-equivalent OpenClaw lifecycle scenarios are classified with a separate runtime owner rather than converted into new Hermes behavior. |
| V3 | R1, R8–R10 | Static source, schema, declaration, package-graph, generated-artifact, documentation, test-inventory, and build/release inspection finds no unclassified active OpenClaw surface and confirms the immutable Hermes pin. |
| V4 | R1, R7 | Existing Worker automated and production-shaped behavior evidence remains green with unchanged external task contracts. |
| V5 | R3–R6 | Allowed and denied security/recovery cases at real or integration boundaries prove profile isolation, secret mediation, approval and admin authorization, stale-generation fencing, typed failure, sibling-safe containment, and bounded first-operation recovery after control reattachment. |
| V6 | R8–R10, C4 | Packed and published-artifact inspection proves only remaining packages participate in the synchronized release and contain no OpenClaw runtime assets or dependencies. |
| V7 | R3a | Existing typed cache, inventory, renderer, hook, concurrency, prompt-cache, and managed Hermes orientation evidence proves bounded per-profile startup, deterministic content, nonblocking session-once injection, failure behavior, and unchanged system/tool prefixes. |

## Requirement coverage

| Need | Problem | Outcome | Requirements | Contracts | Proof |
| --- | --- | --- | --- | --- | --- |
| U1 | P1, P5 | O1, O5 | R1, R8, R10 | C3, C4 | V3, V6 |
| U2 | P1, P2 | O1, O2 | R1, R2, R7 | C1 | V1, V2, V4 |
| U3 | P4 | O4 | R3, R3a, R4 | C2 | V2, V5, V7 |
| U4 | P4 | O4 | R3a, R4, R5, R6 | C2 | V2, V5, V7 |
| U5 | P2, P5 | O2, O5 | R2, R10 | C1, C4 | V1, V2, V3 |
| U6 | P1, P3, P5 | O1, O3, O5 | R1, R5, R8, R10 | C1, C3, C4 | V1, V3, V6 |
| U7 | P4 | O4 | R7 | C1 | V4 |
| U8 | P4 | O4 | R9 | C4 | V3, V6 |
| U9 | P2–P5 | O2–O5 | R2–R10, including R3a | C1–C4 | V1–V7 |

## Explicitly undefined behavior

- Reading, converting, backing up, deleting, or restoring legacy OpenClaw state.
- Continuing an OpenClaw conversation in Hermes.
- Mapping OpenClaw agents, auth profiles, plugins, or workspaces to Hermes
  profiles.
- Availability or retention duration of historical external registry artifacts.
- Compatibility with a future Hermes version.
- Recovery changes beyond the separately owned post-control-reattachment fix
  already present in the integrated master baseline.
- New behavior for Worker, standalone MCP Portal, or external Tool Portal
  clients beyond the absence of OpenClaw-specific adapter enum values.

No undefined behavior may weaken the retained authorization, isolation, data
custody, or failure-reporting guarantees.
