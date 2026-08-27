# Remove OpenClaw Program Design

Specification authority: [`specification.md`](specification.md)

## Structural crux

Removing the three OpenClaw packages is insufficient. OpenClaw participates in
configuration unions, private protocol identities, boot metadata, CLI and
scaffold generation, controller composition, Gateway Runtime attachment,
portable contracts, build inputs, documentation, test projects, and release
inventories. A package-only deletion would leave a product that still claims or
accepts OpenClaw at other boundaries.

The selected design contracts the existing architecture around its retained
owners:

```text
Agent VM
  ├── Hermes managed Gateway
  │     ├── hermes-gateway lifecycle
  │     ├── Hermes Python adapter
  │     ├── Gateway Runtime / Tool Portal service
  │     └── controller-owned Tool VM and host actions
  └── Worker task Gateway
        └── existing worker-gateway and agent-vm-worker path
```

Framework-neutral capability, sandbox, authority, storage, recovery, and VM
boundaries remain common. OpenClaw variants and owners disappear. No new
framework registry, compatibility layer, migration service, persistence, or
runtime selection mechanism is introduced.

## Current system and constraints

### Current owners

| Current owner | Current responsibility | Constraint |
| --- | --- | --- |
| `agent-vm` CLI/config | Admits `openclaw`, `hermes`, and `worker` configuration but scaffolds only `openclaw` and `worker` | Hermes needs a supported scaffold without adding a third parallel recipe path |
| `gateway-lifecycle` | Owns Gateway type vocabulary, lifecycle interface, managed framework boot contract, auth and interactive-SSH shape | Common lifecycle and boot semantics remain authoritative; OpenClaw variants do not |
| `openclaw-gateway` | Produces OpenClaw VM requirements, host state, boot inputs, auth commands, diagnostics, mounts, and shell behavior | Entire owner is removed |
| `openclaw-agent-vm-plugin` | Maps OpenClaw native agent and SandboxBackend calls to Gateway Runtime | Entire owner is removed |
| `openclaw-mcp-portal-plugin` | Historical private MCP Portal plugin | Entire owner is removed; managed OpenClaw already rejects it |
| `hermes-gateway` | Produces Hermes VM requirements, profile state, boot metadata/inputs, and interactive shell | Runtime behavior remains; the admin-shell interface narrows to its one supported default session and loses the OpenClaw-only rejection branch |
| Hermes Python adapter | Maps routed profile identity to Gateway Runtime Tool Portal and sandbox operations | Retained and becomes the sole managed-plugin adapter; the separately owned control-reattachment recovery from integrated master remains authoritative |
| Gateway Runtime and portable contracts | Admit OpenClaw/Hermes framework identities and plugin client kinds, then route both to common services | Narrow to exact Hermes identities while preserving common semantics |
| Controller managed-Gateway runtime | Treats OpenClaw and Hermes as managed Gateways, with an OpenClaw-only runtime-status extension | Retain the managed path; remove the extension and OpenClaw branches |
| Worker runtime | Owns on-demand tasks separately from managed Gateways | Protected and intentionally unchanged |

### Representative current paths

```text
CLI scaffold
  agent-vm dispatcher
    -> init operation
    -> scaffoldAgentVmProject(gatewayType=openclaw|worker)
    -> OpenClaw or Worker files
    <- created/skipped result or error

managed Gateway startup
  loaded system config(openclaw|hermes)
    -> controller managed-Gateway zone runtime
    -> loadGatewayLifecycle(type)
    -> gateway-zone orchestrator
    -> lifecycle VM requirements + exact-two-role boot inputs
    -> managed VM / Gateway Runtime / framework service
    <- readiness, health, recovery, or typed start failure

managed adapter request
  OpenClaw SandboxBackend or Hermes BaseEnvironment
    -> GatewayRuntimeClient
    -> private UDS attachment(openclaw-managed-plugin|hermes-managed-plugin)
    -> ToolPortalService
    -> controller-authorized Tool VM / capability backend
    <- canonical result or typed failure
```

Source anchors include:

- `packages/agent-vm/src/cli/commands/init-command-operation.ts`
- `packages/agent-vm/src/cli/init-command.ts`
- `packages/agent-vm/src/config/system-config.ts`
- `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/gateway-lifecycle/src/managed-gateway-boot-contract.ts`
- `packages/gateway-runtime/src/production/gateway-runtime-production-service.ts`
- `packages/hermes-gateway/src/hermes-lifecycle.ts`
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_runtime_environment.py`

The design is compatibility-bound by the retained Hermes, Worker, portal,
controller, storage, managed VM, and protocol contracts. It is not migration-
bound because OpenClaw data and configuration receive no forward reader.

## Alternatives and selection

| Alternative | Gain | Cost and failure consequence | Disposition |
| --- | --- | --- | --- |
| Contract the existing architecture in place | Removes OpenClaw completely while reusing proven Hermes and Worker paths | Mechanically broad schema, source, docs, test, and release cut | Selected |
| Retain dormant OpenClaw variants without implementation packages | Smaller initial schema diff | Contracts continue to claim impossible identities; stale inputs fail late; maintenance residue remains | Rejected by clean-cutover requirements |
| Introduce a dynamic framework registry before deleting OpenClaw | Makes another future framework pluggable | Adds discovery, selection, versioning, and failure policy with no current consumer | Rejected as unauthorized complexity |
| Rename every common managed-Gateway concept to Hermes | Makes the retained framework visually explicit | Collapses real Tool Portal, Tool VM, controller, boot, recovery, and managed VM abstractions into one upstream name and obstructs Worker/common ownership | Rejected; only framework-specific discriminants narrow |
| Upgrade Hermes while cutting over | Gains current upstream fixes | Couples a 3,000-plus-commit upstream change with structural deletion and destroys regression attribution | Rejected by R9 |

The selected design spends complexity only on a Hermes scaffold recipe and a
missing real filesystem proof seam. The repository maintainer pays the broad
one-time contraction cost and receives a smaller permanent ownership and proof
surface. Revisit a framework registry only when a second managed framework has
an authorized consumer and a proven adapter, not merely a hypothetical future.

## Target ownership and dependency direction

```text
agent-vm application
  owns: CLI, config composition, controller, build/release composition
  consumes:
    hermes-gateway ────────┐
    worker-gateway ────────┼──> gateway-lifecycle ──> managed-vm
                            │                           ^
    gateway-runtime ────────┘                           │
    gondolin-vm-adapter ───────────────────────────────┘

Hermes guest process
  Hermes Python adapter
    -> Python GatewayRuntimeClient
    -> private UDS
    -> Gateway Runtime / ToolPortalService

Worker guest process
  agent-vm-worker
    -> existing worker control session and task APIs
```

Allowed dependencies remain those of the accepted managed VM and Gateway
Runtime contracts. The following edges are removed:

- any package or application dependency on `openclaw-gateway`;
- any dependency or runtime load of `openclaw-agent-vm-plugin`;
- any workspace, build, test, or publish dependency on
  `openclaw-mcp-portal-plugin`;
- any contract branch from a retained package to an OpenClaw identity;
- any controller or CLI branch that calls an OpenClaw-only operation.

No Hermes or common package may absorb OpenClaw plugin SDK types, OpenClaw
state, auth profiles, diagnostics configuration, token environment, or native
sandbox policy while those edges are deleted.

## Components and interfaces

### Hermes scaffold recipe

Owner: the Agent VM CLI scaffold domain.

Consumers: `agent-vm init`, black-box scaffold validation, generated manuals,
and deployment operators.

The existing generic scaffold coordinator continues to resolve presets, target
paths, overwrite policy, incremental generated-file reporting, schema artifacts,
and manual generation. Hermes-specific image content is produced by its pure
recipe; existing Worker content remains selected by the coordinator:

```text
HermesScaffoldRecipe
  -> Hermes system-zone projection
  -> profile and secret-projection placeholders
  -> Hermes config path and contents
  -> Hermes managed image build/overlay inputs
  -> Hermes operator guidance

Worker content selection
  -> existing Worker zone/config/prompts/image inputs
```

This keeps one generic incremental write owner and one Hermes image-content
owner without adding runtime discovery. Gateway-type selection remains an
exhaustive compile-time switch over `hermes | worker`. Unsupported CLI inputs and
invalid Hermes recipe construction fail before the first write. After writes
begin, existing `writeFileIfMissing` and manual-generation behavior remains
incremental; no transaction, rollback owner, or staging directory is added.

### Gateway type and lifecycle contract

Owner: `gateway-lifecycle`.

The public Gateway type remains an exhaustive union but narrows to:

```text
GatewayType = 'hermes' | 'worker'
```

`GatewayLifecycle` retains its current behavioral interface. The static loader
maps `hermes` to `hermesLifecycle` and `worker` to `workerLifecycle`. Managed
framework metadata retains explicit provenance literals rather than deleting
identity fields:

```text
framework       = 'hermes'
bootEntry       = 'hermes-gateway'
clientKind      = 'hermes-managed-plugin'
frameworkIdentity = { kind: 'hermes', profileName }
```

Keeping exact literals preserves strict parsing, attachment fencing, telemetry
identity, and malformed-input rejection. There is no framework union or
registry behind those fields.

OpenClaw-specific auth configuration and interactive SSH secret modes are
removed from `GatewayLifecycle`. The remaining interactive-SSH contract has one
Hermes session shape and no `all-secrets` or `gateway-token` variants. Worker
continues to reject managed-Gateway SSH through its execution model.

### Portable managed-agent contracts

Owners: `agent-portal-sdk`, Python `agent-vm-agent-portal-sdk`,
`gateway-control-contracts`, and `gateway-runtime`, each for its existing
language or protocol boundary.

The TypeScript source schemas remain the semantic starting point and generated
or mirrored Python contracts retain parity. Framework identity, managed-plugin
client kind, readiness metadata, attachment policy, semantic revision input,
and telemetry identity narrow to Hermes-only values. OpenClaw-only
adapter-envelope enum members are deleted without inventing a Hermes replacement
when no retained producer emits that field value.

The existing public operation groups, result algebra, projection fields,
capability policy, sandbox handles, generation fences, and bounded message
rules remain unchanged. Contract version changes follow the existing portable-
contract generation and parity boundary; no parser accepts the removed values.

### Hermes Tool Portal orientation

Owner: the existing managed Tool Portal plugin in the Hermes Python adapter.

The controller-authored `toolPortalNamespaceNames` projection remains part of
the profile assignment revision and projection-cohort identity. Managed Hermes
bootstrap constructs one `InventoryCoordinator` and typed injection-state cache,
starts one inventory population per admitted profile and Gateway epoch, then
installs the existing `pre_llm_call` hook without awaiting inventory.

```text
managed Hermes bootstrap
  -> validate exact Hermes projections and Gateway epoch
  -> construct profile inventory projections
  -> start bounded background InventoryCoordinator populations
  -> install managed Tool Portal hooks
  -> continue framework startup

pre_llm_call(profile, session_id)
  -> read one process-local inventory snapshot
  -> unresolved / invalid authority / no rendered orientation: no context, no mark
  -> ready: mark_if_absent(epoch, profile identity, session_id)
       inserted        -> return bounded orientation context
       already present -> return no context
```

`InventoryCoordinator`, `PluginStateCache`, the deterministic renderer, and the
hook retain their accepted retry, deadline, typing, concurrency, failure, and
prompt-cache behavior. Contract narrowing may remove OpenClaw projection
variants, but it may not remove or recompute Hermes namespace names, inventory
identity, session-once marks, or this startup/hook call path.

### Managed Gateway composition

Owner: `agent-vm` composition and controller runtime.

The controller retains two zone-runtime branches:

```text
zone.gateway.type === 'hermes'
  -> managed Gateway zone runtime

zone.gateway.type === 'worker'
  -> Worker zone runtime
```

The managed branch continues to construct the Gateway Runtime, controller
control/lease/approval authorities, Tool VM facilities, health/recovery state,
runtime records, and exact-two-role Gateway VM. OpenClaw runtime-status storage,
diagnostic extensions, workspace-path translation, auth-profile preparation,
and plugin bundle materialization disappear.

Managed-Gateway controller operations for health, service health, logs, destroy,
upgrade, credential refresh, diagnosis, recovery, command execution under
existing admin authorization, and protected SSH remain owned by the managed
zone runtime and apply to Hermes. Their support derives from the managed
execution model or Hermes lifecycle rather than an OpenClaw type check.
OpenClaw-only auth operations have no retained caller.

### Build and managed-image composition

Owner: Agent VM build composition.

Gateway image profiles narrow to Hermes and Worker. The exact-two-role boot
projection has one managed framework entry, Hermes. OpenClaw managed base image
metadata, plugin synchronization, package overrides, Dockerfile generation,
cache inspection, and E2E cache preparation disappear.

The Hermes image recipe remains deployment-owned and derived from the immutable
Hermes distribution pin plus Agent VM public package artifacts. Worker and Tool
VM managed image metadata remain unchanged.

### Documentation and release projections

Owners: canonical repository documentation and the existing release/package
orchestration respectively.

Canonical docs describe Hermes and Worker progressively. Generated manuals
contain Hermes operating guidance and no OpenClaw procedure. Current schema,
package, test-project, local-tarball, managed-image, and publish inventories are
projections of the same retained package graph.

Historical release records are not runtime or documentation authority and may
retain accurate OpenClaw references. Active residue has no allowlist by default;
each surviving occurrence must point to immutable history or it is a cutover
defect.

## Current-to-target call-path deltas

| Behavior | Current path | Target path and edge disposition | Result/error |
| --- | --- | --- | --- |
| Scaffold | dispatcher → init operation → generic scaffold → OpenClaw/Worker branches → incremental files | dispatcher → init operation → generic scaffold → exhaustive Hermes/Worker content selection → existing incremental writes. OpenClaw branch removed; Hermes image recipe added; generic preset/path/write edges intentionally unchanged. | Complete created/skipped result on success; unsupported input or invalid Hermes recipe fails before writes; later I/O failure may leave already-created files. |
| Config load | system schema → OpenClaw/Hermes/Worker discriminated union → refinements | system schema → Hermes/Worker union → same shared refinements. OpenClaw schema and refinements removed. | Removed type/fields are strict validation errors, never translated. |
| Gateway startup | controller → managed/Worker branch → lifecycle loader(OpenClaw/Hermes/Worker) → orchestrator → VM | controller → Hermes-managed/Worker branch → lifecycle loader(Hermes/Worker) → same orchestrator → VM. OpenClaw lifecycle and runtime-status edges removed; common managed edges unchanged. | Existing readiness or typed startup failure. |
| Managed request | OpenClaw or Hermes adapter → client-kind union → Gateway Runtime ternary framework identity → common service | Hermes adapter → exact Hermes attachment → Gateway Runtime exact Hermes identity → same common service. OpenClaw adapter and conditional removed. | Existing canonical result or typed bounded failure. |
| Control reattachment | Hermes cached environment → accepted replacement control session → replacement-session use-end and fresh controller-authorized binding → same common service | Retain the separately owned integrated-master recovery unchanged; the cutover only ports its new test principal from the removed OpenClaw identity shape to the existing Hermes identity contract. | First affected operation succeeds within the bounded deadline without command replay, stale-generation reuse, or a replacement Tool VM process. |
| Hermes orientation | Hermes bootstrap → controller-authored namespace projection → background inventory coordinator → typed cache; `pre_llm_call` → snapshot → atomic session mark → optional context | Intentionally unchanged. OpenClaw contract narrowing must preserve namespace projection, profile/epoch/session identity, nonblocking hook behavior, and existing failure results. | Zero or one bounded orientation block; failures never block the turn or broaden authority. |
| Tool VM | common service/controller → agent binding → SSH Sandbox API → Tool VM | Intentionally unchanged. Only the impossible OpenClaw caller disappears. | Existing generation-fenced result, cancellation, ambiguity, or denial. |
| Build | image type → OpenClaw/Hermes/Worker boot projection → image plan; OpenClaw may sync plugins | image type → Hermes/Worker projection → image plan. OpenClaw projection, plugin sync, and managed-image input removed. | Existing build result/fingerprint semantics for retained images. |
| Admin | auth dispatcher → 1Password/Codex-harness/OpenClaw login; SSH lifecycle chooses token/all-secrets/Hermes shell | auth dispatcher retains 1Password only; protected SSH loads Hermes lifecycle and opens Hermes shell. OpenClaw and all-secrets edges removed. | Missing removed command is a CLI usage error; Hermes SSH retains controller/admin authorization errors. |
| Worker task | worker task API → Worker zone runtime → worker VM/task pipeline | Intentionally unchanged. | Existing task states and errors. |

## State and cutover model

No runtime state migration or dual-reader phase exists. Deployment operators
have one mandatory release boundary because the post-cutover runtime record
schema cannot parse an OpenClaw predecessor safely:

```text
pre-cutover release + valid OpenClaw config
  -> stop controller-managed OpenClaw Gateway
  -> release Tool VM leases and stop recorded Tool VM processes
  -> exact-process cleanup consumes the still-valid OpenClaw runtime records
	-> operator verifies Gateway/Tool VM records are cleared and ingress is no longer owned

only after that proof
  -> replace binaries, package train, generated contracts, and config together
  -> start cutover release with valid Hermes or Worker config
```

The cutover release never parses legacy records compatibly and never signals a
process whose exact ownership it cannot prove. This repository cutover does not
boot or operate OpenClaw as a PR-readiness proof. The old-release shutdown is a
deployment prerequisite performed by an operator before installing the new
release; the repository proves that guidance is generated and that the new
release rejects legacy inputs safely.

| State | Authority | Permitted behavior | Illegal behavior and handling |
| --- | --- | --- | --- |
| Pre-cutover release | Its shipped schemas and binaries | Existing OpenClaw, Hermes, and Worker behavior | None introduced by this design |
| Pre-cutover termination | Pre-cutover controller, config, runtime-record schema, and exact-process authority | Stop and clean the complete OpenClaw Gateway/Tool VM tree; prove records cleared and ingress released | Replacement is blocked while any exact-process cleanup, record removal, lease release, or ingress release is unproved |
| Cutover release | Hermes and Worker schemas/binaries only | New Hermes deployments and existing valid Hermes/Worker deployments | OpenClaw config is rejected before build/start; OpenClaw data is ignored and untouched |
| Rollback to pre-cutover release | The explicitly installed older release | Older binaries may read their own compatible OpenClaw data | Mixed new-controller/old-contract or old-controller/new-contract operation is unsupported |

Repository source, generated schemas, built packages, controller, Gateway VM
overlay, and deployment configuration are one release-coherent contract. The
design does not support a mixed-version managed Gateway during cutover.

OpenClaw state remains operator-owned on disk. No retained runtime semantically
interprets, migrates, mutates, deletes, or claims it as Hermes state. Existing
backup behavior continues to copy a configured zone's complete `stateDir`
opaquely and this cutover adds no OpenClaw-aware backup filter, restore policy,
or semantic guarantee for legacy bytes. Rollback is replacement of the complete
software/configuration set, not reconciliation by the cutover release.

## Normal runtime flow

```text
operator starts valid Hermes zone
  -> strict config identifies Hermes profile assignments and image
  -> controller selects managed Gateway zone runtime
  -> hermesLifecycle prepares profile directories and VM requirements
  -> controller authorizes paths, secrets, resources, ingress, and image
  -> managed VM boots exact Tool Portal + Hermes sibling services
  -> Hermes adapter authenticates routed profile and exact attachment
  -> Hermes bootstrap starts profile/epoch Tool Portal inventory and installs
     the nonblocking session-once orientation hook
  -> Gateway Runtime resolves controller-authored agent projection
  -> Tool Portal or sandbox operation reaches the current agent binding
  -> controller-authorized Tool VM or backend performs the operation
  <- canonical result, artifact, event, or typed failure
```

Worker requests bypass this flow and continue through the existing Worker task
runtime.

## Failure, recovery, and concurrency

| Failure or overlap | Detection and containment | Recovery owner | Proof seam |
| --- | --- | --- | --- |
| OpenClaw config or field supplied | Strict schema rejects before host-state or VM mutation | Operator authors a Hermes or Worker config; no automatic migration | CLI/config negative contract |
| Hermes scaffold input unsupported or recipe construction invalid | CLI parsing or Hermes recipe construction fails before writes | Operator corrects input and reruns | Black-box negative scaffold state inspection |
| Scaffold filesystem or manual generation fails after writes begin | Existing incremental writer reports failure; already-created files remain visible | Operator corrects the cause and reruns with existing overwrite behavior or removes the incomplete target | Failure-injection unit/integration evidence for the existing partial-write contract |
| OpenClaw artifact accidentally remains reachable | Static contract/package/residue enforcement fails the cutover | Maintainer removes or explicitly classifies immutable history | Structural and packed-artifact inspection |
| Hermes attachment claims removed client/framework kind | Exact literal schema rejects handshake/attachment | Gateway replacement under existing recovery authority | Contract and integration denied-case evidence |
| Orientation inventory is unresolved, exhausted, malformed, or loses authority | Existing typed inventory state either defers injection, publishes ready all-unavailable orientation, or suppresses invalid-authority orientation; user turn continues | Existing Hermes managed Tool Portal plugin | Orientation unit/integration/E2E seams |
| Hermes runtime or Tool VM failure | Existing health vector, typed operation state, fencing, and recovery classify it | Existing controller/Gateway Runtime owners | Green integrated-baseline paths use integration and real-VM recovery seams, including first-operation recovery after control reattachment |
| Replacement is attempted while an OpenClaw Gateway or Tool VM remains | Deployment guidance requires pre-cutover exact-process cleanup before replacement; the post-cutover controller fails closed on legacy record parse and never signals an unproved process | Pre-cutover controller and operator own safe termination; cutover controller owns fail-closed refusal | Generated old-release shutdown guidance plus new-release legacy-input/record rejection evidence; live OpenClaw operation is a deployment acceptance step, not a repository PR gate |
| Concurrent Hermes agents operate | Existing profile projection, agent binding, generation, and per-agent connection isolation apply | Existing controller and ToolPortalService owners | Multi-agent isolation evidence |
| Worker and Hermes run concurrently | Existing zone-runtime and managed VM ownership keep them independent | Existing controller owners | Combined runtime/e2e evidence |
| Package publication partially succeeds | Existing synchronized release recovery republishes only missing retained artifacts | Existing release workflow | Registry and packed-artifact verification |

No new retry, lock, queue, state store, recovery loop, scaffold transaction, or
rollback mechanism is introduced. Runtime concurrency remains owned by existing
managed Gateway and Worker mechanisms, and scaffold writes retain their existing
incremental behavior.

## Trust and data boundaries

```text
operator-authored config
  -> strict Hermes/Worker schema
  -> controller authorization
      ├── host paths and storage ownership
      ├── secret resolution and HTTP mediation
      ├── admin authorization
      ├── Gateway/Tool VM lifecycle and recovery
      └── exact process and generation fencing
  -> managed VM
      ├── Tool Portal/Gateway Runtime service
      └── Hermes framework service
            -> exact profile identity
            -> exact controller-authored projection
            -> filtered workspace and Tool VM authority

outside retained trust graph:
  OpenClaw config, tokens, auth profiles, plugins, registry state,
  Gateway files, images, processes, and protocol identities
```

Removed OpenClaw data is not reclassified as harmless framework input; it is
outside the new parser and trust graph. The retained runtime cannot interpret it
as Hermes configuration, identity, auth, plugin, or framework state. Generic
whole-directory backup may copy opaque bytes already placed inside a configured
`stateDir`; it gains no OpenClaw semantics or deletion authority. Historical
files remain under operator custody.

## Cross-cutting realization

| Obligation | Structural owner and mechanism | Failure behavior | Proof |
| --- | --- | --- | --- |
| Security and trust | Existing strict schemas, controller authority, profile projection, secret mediation, admin auth, egress/path policy, and generation fencing; impossible OpenClaw identities removed | Reject before authority or contain through existing typed failure/recovery | Allowed/denied integration and real-VM cases plus source/package enforcement |
| Data lifecycle | No retained semantic OpenClaw config/state reader or writer; operator custody and existing opaque whole-`stateDir` backup remain | Legacy data is not interpreted, migrated, mutated, or deleted; no backup filter or restore promise is added | Negative semantic-reader/source inspection, backup-boundary inspection, and deployment-state observation |
| Reliability | Existing Hermes exact-two-role boot, health vector, Gateway recovery, Tool VM replacement, and Worker lifecycle, including separately owned reattachment recovery from integrated master | Current bounded degraded/failed states remain visible; the integrated recovery is retained without a second implementation | Hermes and Worker integration/live proof, including the first Tool VM operation after control reattachment |
| Performance | Compile-time exhaustive Hermes/Worker selection; exact Hermes attachment removes a runtime framework branch | No compatibility or translation fallback | Runtime call-path and performance-regression observation where already required |
| Observability | Existing controller, Hermes, Gateway Runtime, Tool Portal, and Tool VM identities; OpenClaw identity removed | Unknown/removed identity rejected rather than mislabeled | Schema/telemetry tests and runtime trace inspection |
| Platform compatibility | Hermes recipe projects existing preset, architecture, image, and host prerequisites | Unsupported prerequisite fails in validate/doctor before readiness | Generated deployment plus platform-appropriate runtime proof |
| Accessibility | No visual interface changes | Not applicable | Specification records the reasoned exclusion |

## Proof architecture

| Requirement | Realization owner | Observable seam | Real versus replaceable boundary | Enforcement class |
| --- | --- | --- | --- | --- |
| R1, R8, R10 | Gateway schemas, package graph, CLI/build/docs/release projections plus ordered predecessor guidance | Supported values, active-residue inventory, generated old-release shutdown procedure, and new-release rejection | Source/generated artifacts, current cleanup safety tests, and new-release rejection are repository proof; live old-release cleanup is operator-owned deployment acceptance | Types, schema, static rule, runtime cleanup guard, generated manual, artifact and deployment inspection |
| R2 | Generic incremental scaffold coordinator + Hermes image recipe | Fresh generated deployment, CLI result, unsupported-input rejection, and documented partial-write failure behavior | Filesystem and built CLI real; secret values may use test-safe placeholders | Schema, integration, host E2E, manual CLI transcript |
| R3, R4 | Hermes adapter, Gateway Runtime, ToolPortalService, controller Tool VM binding | Managed portal/sandbox result and workspace side effect | Gateway Runtime, Hermes adapter, managed VM, and Tool VM real for final proof; provider/model may use deterministic test boundary where the operation path remains real | Types, runtime guards, integration, Hermes E2E |
| R3a | Hermes managed Tool Portal plugin, inventory coordinator, typed caches, renderer, and `pre_llm_call` hook | Per-profile startup inventory and zero-or-one session context result | Existing process-local state and hook integration real; bounded Tool Portal responses may use controlled fixtures, with managed Hermes E2E observing the production hook path | Types, atomic cache boundary, unit, integration, Hermes E2E |
| R5, R6 | Controller and existing health/recovery/telemetry owners | Denied authority, health transition, recovery record, telemetry identity | Real controller/VM for green recovery and mediation claims, including integrated-master control-reattachment recovery; injected clocks/fakes remain valid for deterministic policy decisions | Schema, runtime guard, health check, integration, E2E |
| R7 | Existing Worker runtime | Worker task API and production-shaped result | Worker host/VM boundary real according to existing taxonomy | Existing unit, integration, host/Worker E2E |
| R9 | Hermes distribution contract and image recipe | Source revision, version, digest, image fingerprint | Exact pin and packed image inputs real | Type literal, artifact inspection, build/E2E |
| C4 | Release/package orchestration | Packed dependency graph and registry train | Tarballs/registry responses real for release claim | Static guard, pack inspection, release verification |

Retained proof must keep each former framework-neutral real boundary visible.
The live Hermes filesystem seam traverses the production adapter, Gateway
Runtime, and selected Tool VM workspace. Protected controller-mediated Hermes
SSH has a retained live seam. Removed OpenClaw lifecycle scenarios that do not
map to current Hermes caching, active-use, idle-retirement, or automatic-recovery
semantics are recorded in the post-removal WIP with a separate runtime owner;
they do not authorize a Hermes runtime change or block the deletion-only
cutover. The post-reattachment case remains independently runnable and green
through the separately owned recovery integrated from master. This cutover adds
no second runtime repair.

## Accepted-requirement realization

| Accepted need | Disposition | Structural anchor |
| --- | --- | --- |
| U1 | covered | OpenClaw owners and every active projection edge are removed; residue enforcement closes alternate paths |
| U2 | covered | Exhaustive Hermes/Worker config, lifecycle, controller, and scaffold composition |
| U3 | covered | Retained Hermes adapter, Tool Portal orientation startup/hook state, and common Gateway Runtime/ToolPortalService/Tool VM behavior |
| U4 | covered | Existing controller, managed VM, storage and opaque backup, security, observability, health, and recovery owners remain authoritative |
| U5 | covered | Hermes scaffold recipe, strict generated config, managed build, protected SSH, and generated operating guidance |
| U6 | covered | No parser alias, semantic state reader, forwarding package, plugin adapter, feature flag, or dual path; old release proves safe predecessor termination before replacement |
| U7 | covered | Worker zone-runtime and task call paths intentionally unchanged |
| U8 | covered | Hermes distribution pin is a protected literal and image input |
| U9 | covered | Positive Hermes/Worker runtime and orientation seams, ordered predecessor-cleanup proof, active-residue and release-artifact enforcement, and the explicit live filesystem seam |

## Design debt and revisit signals

- The scaffold coordinator remains responsible for generic incremental
  filesystem writing. If future Gateway types or an all-or-nothing scaffold
  guarantee become authorized, revisit whether a complete staged file-plan
  owner is justified; do not add transactions or dynamic discovery now.
- Historical published OpenClaw artifacts remain externally available until a
  separately authorized deprecation or retention decision. They are not part of
  the active product or release train.
- The common Gateway Runtime contract retains explicit Hermes provenance fields
  even though only one managed framework remains. Remove those fields only if
  evidence shows they no longer serve attachment fencing, telemetry identity,
  portable contract validation, or incident diagnosis.
- Any requested Hermes version change, OpenClaw state migration, second managed
  framework, or mixed-version rollout reopens the Requirements and Specification
  boundary rather than extending this design.
- Idle-retirement, stale-reacquisition, fatal-framework replacement, and
  repeated-recovery qualification that requires new Hermes lifecycle behavior
  belongs to the separate runtime owner recorded in
  `docs/wip/2026-08-26-post-openclaw-removal-follow-ups.md`.

## Explicit exclusions

No compatibility layer, data migration, OpenClaw state cleanup, framework
registry, Hermes upgrade, Worker redesign, common runtime redesign, new
persistence, or destructive external registry cleanup belongs in this design.
