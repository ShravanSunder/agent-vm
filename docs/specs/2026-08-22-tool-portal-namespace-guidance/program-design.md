# Tool Portal Namespace Discovery Summary Program Design

Specification authority: [`specification.md`](specification.md)

## Structural overview

```text
authored configuration
  ├── mcp.config provider discovery.summary
  └── non-MCP Tool Portal namespace discovery.summary
                    │
                    ▼
namespace discovery compiler
  └── one frozen effective discovery value per Tool Portal namespace
                    │
          ┌─────────┬─────────┴─────────┐
          ▼         ▼                   ▼
 managed config  standalone         managed-agent
 materialization composition         projection
          │         │                   │
          └────┬────┘                   ▼
               ▼                  Hermes inventory
       Tool Portal discovery            │
       list/search/describe              ▼
                                  session-once orientation
```

The design adds no service, store, refresh loop, or prompt pipeline. One pure
compiler owns the join between MCP provider metadata and cross-backend Tool
Portal policy; managed and standalone runtimes call it at their existing
configuration-composition boundaries.

## Current system and changed edges

The current production paths are:

```text
configuration
  mcp-portal-effective-config.ts
    -> loads mcp.config.jsonc and tool-portal.config.jsonc
    -> preserves provider discovery in effective MCP config
    -> preserves Tool Portal policy separately

Tool Portal discovery
  ToolPortalCapabilityCore.list/search/describe
    -> backend ports
    -> tool-portal-result-router merges capability results
    -> portable item values contain tools and namespace names only

Hermes orientation
  gateway-runtime-portal-admission-material.ts
    -> projects sorted toolPortalNamespaceNames
    -> ManagedAgentProjection portable contract
    -> CanonicalManagedAgentProjection Python boundary
    -> InventoryProjection(namespace_names)
    -> live namespace existence probes
    -> NamespaceInventory(name, availability)
    -> renderer emits name + availability once per session identity
```

Target deltas:

| Edge | Status | Target behavior |
| --- | --- | --- |
| MCP config + Tool Portal config → namespace discovery compiler | Added | Resolve one frozen discovery value per namespace from its sole authored source. |
| Compiler → managed effective Tool Portal config | Changed | Materialize resolved discovery before Gateway startup. |
| Compiler → standalone Tool Portal composition | Added | Build one frozen profile-scoped discovery projection at standalone startup. |
| Effective Tool Portal config → Tool Portal list/search/describe | Changed | Project represented namespace discovery beside existing backend results. |
| Backend read results → final public Tool Portal results | Changed | Parse backend-owned internal results first; attach discovery and validate the required public result only after merge. |
| Effective Tool Portal config → Managed Agent Projection | Changed | Carry sorted namespace discovery entries instead of bare names. |
| Managed Agent Projection → Hermes inventory | Changed | Preserve optional summary while probing availability by namespace name. |
| Hermes inventory → renderer | Changed | Render complete name/status/summary entries within existing bounds. |
| Tool Portal call/approval/backend dispatch | Intentionally unchanged | Discovery metadata never enters execution authority or arguments. |
| Hermes cache/injection lifecycle | Intentionally unchanged | Same profile/epoch/session identity, single flight, nonblocking hook, and atomic mark. |

## Structural crux and selected direction

The crux is where MCP provider metadata becomes cross-backend namespace
metadata.

### Selected: compile once at each existing composition boundary

`agent-vm` already loads both authored files and produces the immutable effective
MCP and Tool Portal generation before Gateway startup. It resolves MCP-backed
summaries into the effective Tool Portal namespace at that boundary. Non-MCP
summaries pass through from authored Tool Portal policy.

Standalone Tool Portal already composes its policy and MCP backend at startup.
It uses the same pure compiler there and freezes the result in its existing
semantic snapshot. The resolution rule exists once in code; each runtime calls
it once at its existing configuration boundary.

Gain:

- one summary source per backend kind;
- all downstream consumers read one effective shape;
- profile, semantic revision, Gateway boot, and generated-file behavior stay on
  existing paths.

Cost:

- authored and effective Tool Portal namespace schemas differ for
  `mcp_provider`: authored policy rejects `discovery`, while effective policy
  contains the resolved provider discovery value.

The shared compiler owns that distinction. Revisit only if a future backend
supplies dynamic namespace metadata that cannot be fixed before runtime
composition.

### Rejected: join MCP metadata independently in every consumer

Passing effective MCP config into Tool Portal routing, managed projections, and
Hermes would create repeated provider-to-namespace resolution and inconsistent
failure behavior.

### Rejected: new namespace metadata registry/service

The summaries are immutable configuration. A registry adds lifecycle,
consistency, and recovery machinery without serving a requirement.

## Components and ownership

| Component | Owns | Consumers | Reason to change |
| --- | --- | --- | --- |
| Shared discovery schemas | Strict `{ summary? }` and effective `{ namespace, summary? }` portable shapes and bounds | Config loaders, Tool Portal, Gateway contracts, Python adapter | Namespace discovery contract changes. |
| Effective namespace discovery compiler | Pure single-source resolution from MCP provider or non-MCP Tool Portal policy | Managed materialization, standalone composition, and semantic snapshots | Authored-source or resolution rules change. |
| Backend read-result contracts | Pre-projection list/search/describe values returned by backend ports | Tool Portal result router | Backend discovery contract changes independently of public projection metadata. |
| Tool Portal discovery projector | Merges internal backend results, filters effective discovery to represented namespaces, and validates final public results | Managed and standalone Tool Portal callers | Portable discovery result behavior changes. |
| Managed Agent Projection compiler | Complete protected-UDS namespace discovery entries for one profile | Framework adapters | Profile/surface projection changes. |
| Hermes inventory coordinator | Availability joined with immutable projected summary | Hermes renderer and hook | Inventory probe or availability semantics change. |
| Hermes orientation renderer | Deterministic bounded name/status/summary text | `pre_llm_call` hook | Model-facing orientation format or bound changes. |

These are responsibilities added to existing owners, not seven new runtime
services.

## Schema and interface contracts

### Authored configuration

`mcpProviderSchema.discovery` and non-MCP Tool Portal namespace discovery use
the shared strict schema. Tool Portal authored validation applies this rule:

```text
backend.kind = mcp_provider
  discovery present -> reject duplicate source

backend.kind = controller_execution | tool_vm_runner
  discovery absent/present -> accept strict optional summary
```

### Effective namespace discovery compiler

The pure compiler accepts:

- parsed authored MCP config;
- parsed authored managed or standalone Tool Portal config;
- the profile/surface namespace selection supplied by the composing owner.

It returns frozen sorted namespace-discovery projections and deterministic
missing, ambiguous, and duplicate-source errors. It performs no I/O and owns no
lifecycle.

Managed materialization consumes the compiler output to produce:

- effective MCP config unchanged except existing secret/image materialization;
- effective Tool Portal config with `discovery` present as `{}` or
  `{ summary }` on every namespace policy.

For each MCP-backed namespace, the compiler requires the existing unique
provider namespace resolution, copies only `provider.discovery`, and fails on
missing or ambiguous resolution. It does not copy transport, secrets, provider
identity, or backend state into Tool Portal policy.

Standalone Tool Portal composition calls the same compiler after loading its
Tool Portal policy and the MCP config already used to construct the
`mcp_provider` backend. It freezes one discovery projection per complete profile
inside the standalone semantic snapshot and passes only the selected projection
to each invocation. Privileged backend availability remains unchanged.

### Backend and public discovery-result interfaces

Backend ports MUST NOT return the final public list/search/describe result
types after those types require `namespaceDiscovery`. The portable SDK owns
strict internal backend read-result schemas containing exactly the current
pre-projection values:

```text
BackendListItemValue
  namespaces + nextCursor? + tools

BackendSearchItemValue
  tools

BackendDescribeItemValue
  tools
```

Backend ports and pre-merge router parsing use the internal result contracts.
The result router merges those values, attaches the selected effective
`namespaceDiscovery`, and only then parses the final public
`PortalListResult | PortalSearchResult | PortalDescribeResult`. Call results are
unchanged and need no internal/public split.

### Portable discovery results

The portable SDK adds `EffectiveNamespaceDiscoverySchema`, the internal backend
read-result contracts, and a required `namespaceDiscovery` array to successful
list/search/describe item values.
The array carries every represented namespace, with summary omitted on entries
that have none. Tool Portal owns filtering and deterministic sorting after
backend results are merged. Backends remain unaware of the field.

### Managed Agent Projection

The hard-cut portable field is:

```text
removed: toolPortalNamespaceNames: string[]
added:   toolPortalNamespaces: EffectiveNamespaceDiscovery[]
```

The projection schema enforces sorted unique namespace entries. Profile
assignment revision and projection cohort digest already hash the full
projection, so summary changes automatically refresh both identities.

Python `CanonicalManagedAgentProjection` mirrors the same strict field. No
compatibility alias or dual parser remains.

## Normal flows

### Effective summary resolution

```text
buildEffectivePlanFromConfig
  -> validate Tool Portal policy and active MCP provider namespaces
  -> for each profile namespace
       mcp_provider
         -> find unique provider by provider.namespace
         -> take provider.discovery
       controller_execution | tool_vm_runner
         -> take namespacePolicy.discovery
  -> parse EffectiveManagedToolPortalConfig
  -> write atomic effective generation
  <- strict config error before Gateway startup on invalid resolution
```

### Tool Portal discovery

```text
trusted Tool Portal list/search/describe invocation
  -> resolve selected profile and surface
  -> select frozen effective namespace discovery projection
  -> route to backend ports returning internal read results
  -> parse and merge internal tool results
  -> derive represented namespace set from merged item
  -> select effective namespace discovery entries
  -> parse final public item with tools + namespaceDiscovery
  <- preserve existing item error/diagnostic on backend failure
```

Managed mode selects the projection from effective Tool Portal config.
Standalone mode selects the profile projection frozen in its semantic snapshot.
Neither mode asks a backend to synthesize namespace discovery metadata.

### Hermes orientation

```text
Gateway startup
  -> Managed Agent Projection carries effective namespace discovery
  -> Hermes InventoryProjection retains entries and probes names only
  -> publish NamespaceInventory(name, summary?, availability)
  -> canonical-JSON encode each displayed summary as one escaped line
  -> render greatest complete sorted entry prefix within 2,000 bytes

pre_llm_call
  -> existing nonblocking inventory observation
  -> existing mark_if_absent(session identity)
  -> one winner returns name/status/summary orientation
  -> later same-session turns return no orientation
```

## State, concurrency, and failure

No new mutable state is introduced.

| State | Owner/lifetime | Change |
| --- | --- | --- |
| Authored summary | Deployment config generation | Existing MCP field or new non-MCP Tool Portal field. |
| Effective discovery | Atomic effective config generation | Derived once before Gateway startup. |
| Managed projection | Gateway epoch/projection cohort | Bare names become immutable discovery entries. |
| Inventory | Existing process-local profile/epoch cache | Availability entry also retains projected summary. |
| Injection mark | Existing process-local profile/epoch/session cache | Unchanged. |

Concurrent managed Tool Portal discovery calls read the same frozen effective
config. Standalone calls read the same frozen per-profile discovery projection.
Concurrent Hermes first turns retain the existing atomic injection winner. No
summary write occurs after Gateway admission, so no new race, lock, or ordering
rule is required.

Failure behavior:

- invalid/duplicate authored summary source fails static materialization;
- absent summary degrades to existing name/status behavior;
- provider probe failure keeps `unavailable` while preserving its configured
  summary;
- a summary that makes one complete entry exceed the remaining byte budget
  causes that entry and all later entries to be omitted by the existing prefix
  policy;
- if even the zero-entry orientation cannot fit, the existing render failure
  suppresses orientation;
- backend list/search/describe errors do not receive fabricated successful
  discovery metadata;
- runtime close and late inventory publication retain existing epoch fencing.

## Dependency and forbidden edges

Allowed:

```text
effective-config compiler -> authored MCP + Tool Portal config
Tool Portal service       -> effective Tool Portal discovery
projection compiler       -> effective Tool Portal discovery
Hermes adapter            -> portable managed projection
```

Forbidden:

```text
Hermes adapter        -X-> authored config files
Tool Portal backends  -X-> discovery-summary resolution
Tool Portal backends  -X-> final public namespaceDiscovery fields
summary text          -X-> call policy / approval / backend payload
mcp_provider policy   -X-> authored Tool Portal summary override
```

Schema validation, strict effective parsing, projection refinement, and payload
regression tests enforce these edges.

## Cutover

The repository cuts over all producers and consumers together:

1. authored/effective config, internal backend results, and public result schemas;
2. shared summary compiler, managed materialization, and standalone semantic snapshots;
3. Tool Portal backend-port and final-result projection cutover;
4. managed-agent projection TypeScript/Python parity;
5. Hermes inventory and renderer;
6. generated schemas, fixtures, manuals, and deployment examples.

No old/new runtime coexistence is supported. An old Gateway image or client
fails strict projection/result parsing rather than silently losing summaries.
Rollback uses the prior complete package/image train and prior configuration;
the optional non-MCP discovery field must be removed before validating against
that train.

## Proof architecture

| Requirement | Realization owner | Proof seam | Required real boundary |
| --- | --- | --- | --- |
| U1 | Projection compiler + Hermes renderer | Captured provider request containing orientation | Real Hermes VM and model HTTP boundary |
| U2 | Effective discovery compiler | Effective config and provider/namespace resolution inspection | Real config materialization; provider connection may be fake |
| U3 | Shared schemas + compiler | Authored/effective config acceptance and output | In-process schema/materializer |
| U4 | Internal backend contracts + Tool Portal discovery projector | Internal pre-merge and final portable results in managed and standalone modes | Real Tool Portal service; backend ports may be controlled |
| U5 | Projection/inventory/renderer | Profile isolation, concurrency, byte-bound and session-once observations | Real adapter for final session proof |
| U6 | Existing call policy/backends | Before/after call and payload regression | Existing integration boundaries |
| U7 | Schemas/materializer | Invalid configuration table | In-process schemas plus startup preflight |

The existing Hermes orientation E2E harness is the production-shaped proof
path: real controller, Gateway VM, Hermes process, adapter, Tool Portal/MCP
upstream boundary, recording model provider, and captured model request. It must
observe both an MCP summary and a non-MCP Tool Portal summary in exactly one
session request. Unit and integration evidence cannot replace that proof.

## Requirement realization coverage

| Requirements | Structural realization | Proof |
| --- | --- | --- |
| U1 | Managed projection → inventory → renderer | Real Hermes captured request |
| U2 | MCP provider discovery → effective compiler | Materialization integration |
| U3 | Non-MCP Tool Portal discovery → effective compiler | Schema/materialization integration |
| U4 | Managed/standalone projections → internal backend results → final Tool Portal result projector | Managed and standalone service integration |
| U5 | Sorted projection + existing cache/injection lifecycle | Projection, renderer, concurrency, and real session proof |
| U6 | Explicit forbidden authority edges | Call-policy/payload regression |
| U7 | Strict schemas and single-source resolution | Invalid-config/preflight tables |

Every requirement is covered. No requirement needs a new service, store,
framework hook, approval path, or backend contract.
