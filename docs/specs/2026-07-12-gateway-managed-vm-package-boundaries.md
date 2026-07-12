# Gateway lifecycle and managed VM package boundaries

Date: 2026-07-12

## Decision summary

Replace the current `gateway-interface` and `gondolin-adapter` package boundary
with three explicit owners:

```text
@agent-vm/gateway-lifecycle
  owns gateway-kind lifecycle vocabulary, shared policy, and behavior

@agent-vm/managed-vm
  owns backend-neutral VM creation and runtime contracts

@agent-vm/gondolin-vm-adapter
  implements managed-vm using stock Gondolin
```

OpenClaw and Worker remain concrete `GatewayLifecycle` implementations. A
future Hermes integration adds a TypeScript host lifecycle implementation even
if its guest runtime, plugin, or Tool Portal SDK is Python.

The `agent-vm` package remains the shipping application, composition root, and
controller authority root. It has a regular package dependency on
`gondolin-vm-adapter`; a peer dependency would change installation resolution,
not source coupling. Concrete-adapter imports are confined to a closed
production allowlist, and composition projects the provider into narrow neutral
capabilities before passing them to controller domains. This is a
behavior-preserving package hard cut, not a lease, health, recovery, ingress,
or VM-backend redesign.

## Product intent

This design serves maintainers adding or changing gateway kinds without making
them depend on Gondolin, and maintainers changing the VM implementation without
propagating backend SDK types through gateway and controller domains.

Success means:

- gateway-kind implementations describe workload behavior without importing a
  concrete VM adapter;
- controller and lease code operate on an agent-vm-owned managed VM contract;
- Gondolin SDK types and translation behavior have one implementation owner;
- current OpenClaw, Worker, Tool VM, lease, SSH, ingress, mount, secret, health,
  recovery, and termination behavior remains unchanged;
- the package graph makes the intended dependency direction mechanically
  enforceable.

## Current-state problem

The existing names and dependency graph hide two distinct lifecycle domains:

```text
gateway-interface ──> gondolin-adapter ──> @earendil-works/gondolin
       ^                       ^
       |                       |
OpenClaw / Worker        controller and Tool VM orchestration
```

`gateway-interface` is broader than an interface package. It owns
`GatewayLifecycle`, gateway configuration projections, process and VM specs,
health and request policies, lease vocabulary, runtime-path mapping, secret
splitting, audience policy, and WebSocket policy.

Its `GatewayVmSpec` imports Gondolin-adapter-owned `VfsMountSpec` and
`ManagedSshEgressOptions`. OpenClaw and Worker also import Gondolin adapter
helpers directly. The supposed abstraction therefore depends on its concrete
implementation.

The existing `ManagedVm` surface is contract-shaped but not backend-neutral.
It aliases Gondolin exec, filesystem, SSH, and ingress types and exposes a raw
`getVmInstance()` escape hatch. Moving those declarations unchanged would
rename the coupling rather than remove it.

The rejected `gateway-contracts` plus `gondolin-gateway-types` shape is not an
acceptable target. It isolates the leak by name while keeping gateway packages
dependent on Gondolin-specific vocabulary.

## First principles

1. Gateway lifecycle and managed VM lifecycle are different domains.
2. Gateway kinds define the workload recipe; they do not select the VM backend.
3. The selected VM adapter implements machine mechanics; it does not own
   Gateway or Tool VM authority.
4. The `agent-vm` composition boundary owns backend construction. The
   controller owns policy authorization, lifecycle ordering, leases, health,
   recovery, runtime records, and termination proof.
5. Only Gondolin exists today. A second backend is permitted by the boundary
   but is neither required nor simulated by a provider registry.
6. Guest implementation language is independent of the host lifecycle
   contract.
7. Backend neutrality cannot weaken mount pinning, secret mediation, egress,
   SSH identity, ingress admission, or process-identity termination.

## Requirements

### Package ownership

R1. `gateway-interface` is replaced by `gateway-lifecycle`.

The package remains an intentional gateway-domain umbrella. It is not described
as a types-only package.

R2. `gateway-lifecycle` owns:

- `GatewayLifecycle` and its host-state hooks;
- `GatewayZoneConfig` and gateway-kind configuration projections;
- gateway VM requirements and gateway process specifications;
- gateway auth configuration;
- gateway health, lease, path, audience, secret-routing, request, and WebSocket
  policies currently shared across gateway kinds.

R3. OpenClaw, Worker, and future Hermes packages implement
`GatewayLifecycle`.

R4. `managed-vm` owns the backend-neutral VM contract and its semantics. It is
not a provider registry and does not select an implementation.

R5. `gondolin-adapter` is replaced by `gondolin-vm-adapter` and remains the
only production package that imports `@earendil-works/gondolin`.

R6. `agent-vm` has a regular dependency on `gondolin-vm-adapter` and contains a
closed concrete-adapter integration allowlist:

- `packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts` constructs
  the selected provider and projects its neutral capabilities;
- `packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts` owns the
  Gondolin-specific application build/tooling integration that cannot be
  expressed as backend-neutral controller-domain behavior.

No other `agent-vm` production module imports, re-exports, or dynamically loads
`gondolin-vm-adapter`. CLI commands and controller domains consume projected
`managed-vm` capabilities rather than importing the adapter themselves.

### Dependency direction

R7. The allowed package graph is:

```text
openclaw-gateway ─┐
worker-gateway   ─┼──> gateway-lifecycle ──> managed-vm
hermes-gateway   ─┘                              ^
                                                |
agent-vm ───────────────────────────────────────┤
   |                                            |
   └──> gondolin-vm-adapter ────────────────────┘
               |
               └──> @earendil-works/gondolin
```

R8. These dependency edges are forbidden:

- `managed-vm` to gateway packages, controller packages, Gondolin, or a
  concrete adapter;
- `gateway-lifecycle` to a concrete VM adapter or controller;
- OpenClaw, Worker, or Hermes gateway packages to a concrete VM adapter;
- `gondolin-vm-adapter` to gateway lifecycle or a gateway-kind package;
- controller domain modules to `gondolin-vm-adapter`, including Gateway
  orchestration, Tool VM orchestration, leases, health, runtime records,
  recovery, process supervision, resource compilation, and zone runtime state;
- any public declaration outside `gondolin-vm-adapter` that exposes a Gondolin
  SDK type.

Concrete adapter imports inside `agent-vm` are allowlisted only for the two
production modules named by R6. Backend-specific E2E tests may import the
concrete adapter to prove the real backend, but test imports do not widen
production ownership. The package dependency matrix and the production-source
import allowlist are separate invariants and require separate enforcement.

R9. The cutover is complete. There are no forwarding packages, compatibility
exports, deprecated aliases, dual package names, or parallel old/new paths.

### Gateway lifecycle contract

R10. `GatewayLifecycle` continues to define:

```text
authConfig?
buildVmRequirements(...)
buildProcessSpec(...)
preflightHostState?(...)
prepareHostState?(...)
```

The existing `buildVmSpec` name may remain if it is still truthful after the
cut. `buildVmRequirements` is preferred when needed to distinguish
gateway-owned workload intent from controller-owned image and resource
selection.

R11. Gateway lifecycle implementations own guest intent:

- guest environment;
- guest mounts and access mode;
- guest network and egress intent;
- mediated-secret placement intent;
- root filesystem behavior required by the workload;
- guest process commands, health check, log path, auth, and host-state
  preparation.

R12. Gateway lifecycle implementations do not own:

- image selection and build/cache mechanics;
- CPU and memory authority;
- VM construction or backend selection;
- controller path authorization or secret resolution;
- Gateway epoch, Tool VM lease, slot, SSH binding, health recovery, or runtime
  record authority;
- ingress admission ordering or process termination.

R13. The static gateway-kind registry remains exhaustive over configured
`GatewayType`. This spec does not introduce dynamic discovery or a plugin
  protocol.

### Managed VM contract

R14. `managed-vm` defines agent-vm-owned structural contracts. It must not
re-export, alias, or wrap public declarations around Gondolin SDK types.

R15. The neutral provider contract exposes the capabilities currently required
by production:

- managed VM creation;
- managed VM image preparation/build results needed by controller workflows;
- owned host-directory acquisition;
- backend runtime/toolchain compatibility diagnostics required by the CLI.

These are injected capabilities, not a backend registry. The aggregate
`ManagedVmProvider` is composition-local. Composition projects it into the
narrowest neutral capability required by each consumer:

- Gateway orchestration, Tool VM lifecycle, and lease management receive
  `ManagedVmFactory`;
- the Tool VM construction coordinator additionally receives the owned-host-
  directory acquisition capability;
- image preparation/build consumers receive only the neutral image capability;
- CLI compatibility checks receive only the neutral diagnostics capability.

Controller domains must not receive the aggregate provider. Backend-specific
metadata stays opaque unless controller behavior has a concrete neutral need
for it.

The neutral VM creation request describes:

- image reference;
- CPU and memory resources;
- rootfs mode and optional runtime rootfs size;
- environment;
- mediated-secret descriptors and allowed hosts;
- explicit TCP host mappings;
- declarative guest SSH egress policy;
- guest mount declarations;
- request/response mediation hooks expressed with platform types;
- session label.

The contract is closed and fail-closed. Unsupported variants cause construction
failure rather than being ignored.

R16. The neutral runtime handle exposes only justified capabilities:

```text
ManagedVm
  id
  start()
  exec(...)
  enableSsh(...)
  configureIngressRoutes(...)
  enableIngress(...)
  getHostProcessId()
  close()
```

Exact names may follow repository conventions, but semantics remain explicit.

R17. Exec, result, SSH, ingress, route, access-handle, and server-host-key
types are owned structural types. No native alias is acceptable.

R18. `ManagedVm` does not expose `getVmInstance()`, `ManagedVmInstance`, a
native filesystem object, `nativeOptions`, `backendData`, an `unknown` payload,
or another concrete-handle escape hatch.

R19. `getHostProcessId()` remains required in the first contract because
current durable recovery and sibling-safe termination require a host PID plus
recorded process identity. Generalizing this requirement is deferred until a
real backend cannot implement it and the recovery model is deliberately
revisited.

The process ID may be unavailable before `start()` succeeds. After successful
start, `getHostProcessId()` must return a positive, stable host PID. The
controller must capture that PID, process start identity, and command in a
durable runtime record before ingress enablement, lease delivery, or another
authority-admission step. Missing or invalid identity triggers rollback, while
records, slots, and authority remain held until cleanup is proven.

R20. `ManagedVm.close()` is mechanical resource cleanup. It is not proof that
controller-owned durable lifecycle reconciliation or process termination
succeeded.

### Backend-neutral host-directory ownership

R21. A host directory mount that requires TOCTOU protection is represented by
an owned, backend-neutral host-directory capability, not by a raw path and not
by a Gondolin provider or file descriptor type.

The selected managed VM provider exposes an operation with these semantics:

```text
openHostDirectory(path)
  -> owned capability with canonical identity

controller
  -> validates that canonical identity against zone/deployment policy

ManagedVm creation
  -> consumes ownership exactly once
```

R22. The provider implementation must:

- open without following a substituted final symlink;
- expose enough canonical identity for controller authorization;
- revalidate the opened identity when constructing the backend mount;
- close the capability on pre-transfer failure;
- close it on construction failure after transfer;
- retain and close it when the VM closes;
- reject double consumption or ambiguous ownership.

This contract preserves the current pinned RealFS defense without exporting
`PinnedRealFsRoot` or reducing a pinned root back to a string.

R23. Ordinary gateway path mounts may remain declarative path inputs after
controller authorization. Security-sensitive Tool VM work mounts use the owned
host-directory capability.

### Gondolin implementation

R24. `gondolin-vm-adapter` owns:

- Gondolin SDK imports, native instances, and SDK error translation;
- VM option construction;
- VFS provider construction and owned host-directory implementation;
- HTTP mediation hooks;
- synthetic DNS and internal-IP enforcement;
- explicit TCP-host translation;
- ingress defaults and route translation;
- Git read-only SSH policy compilation;
- SSH access creation and exact server-host-key extraction;
- pinned-resource cleanup;
- Gondolin image build, fingerprint, and cache mechanics;
- Gondolin-specific host-network defaults.

R25. The adapter exposes one concrete provider satisfying the injected
`managed-vm` provider contract. The provider supplies the neutral VM factory,
image builder, owned-directory acquisition, and required compatibility
diagnostics. It does not expose a generic registry, backend discriminator, or
native handle to domain consumers. The aggregate provider remains local to the
composition and build/tooling integration boundaries named by R6; those
boundaries inject only narrow capability projections into downstream consumers.

R26. Generic host utilities such as atomic file writing are not owned by the VM
adapter. Gateway-specific use remains with the owning gateway package or an
existing appropriate host-filesystem owner.

### Controller and Tool VM authority

R27. The `agent-vm` application composition boundary is the sole owner of
backend selection, concrete provider construction, and capability projection.
The controller remains the sole owner of:

- image/profile and resource selection;
- raw secret resolution and policy authorization;
- host-path authorization;
- reserve-before-create ownership fencing;
- Gateway epoch and Tool VM parentage;
- lease, active-use, TCP slot, and SSH binding authority;
- runtime records and exact process identity;
- health-before-ingress and ingress-drain-before-termination ordering;
- recovery decisions and fail-closed process termination.

Controller domain modules receive narrow managed VM capabilities through
dependency injection. Gateway orchestration, Tool VM lifecycle, and lease
management receive `ManagedVmFactory`, not the aggregate `ManagedVmProvider`.
Additional consumers receive only the separately justified image,
owned-directory, or diagnostics capability. They must not import the concrete
provider or access unrelated provider capabilities, even when Gondolin is the
only shipping implementation.

R28. Tool VM orchestration remains in `agent-vm` and consumes `managed-vm`
contracts. It does not move into `gateway-lifecycle` or
`gondolin-vm-adapter`.

R29. Tool VMs remain leaves owned by one exact Gateway epoch. Splitting packages
must not change Gateway replacement, Tool VM replacement, SSH re-establishment,
lease renewal, or cleanup behavior.

### Hermes and guest languages

R30. A future `hermes-gateway` is a TypeScript host package implementing
`GatewayLifecycle`.

R31. Hermes may run Python inside the Gateway VM and may use a Python guest
plugin or Tool Portal SDK. That guest language does not create a Python host
lifecycle API or dynamic cross-language lifecycle loader.

R32. `gateway-lifecycle` and `managed-vm` contain no Node/OpenClaw-specific
assumptions that belong to concrete gateway packages.

## Spec boundary and separability map

```text
gateway-lifecycle
  owns: gateway-kind vocabulary, shared policy, lifecycle semantics
  exposes: GatewayLifecycle, GatewayVmRequirements, GatewayProcessSpec
  excludes: concrete VM creation and controller authority

            gateway workload intent
                     |
                     v

managed-vm
  owns: backend-neutral creation/runtime/owned-resource contracts
  exposes: ManagedVmProvider, ManagedVmFactory, ManagedVm,
           image/owned-directory capabilities, closed structural types
  rule: ManagedVmProvider is composition-local; consumers receive projections
  excludes: workloads, backend registry, leases, recovery, native handles

                     ^
                     | implements

gondolin-vm-adapter
  owns: Gondolin SDK translation and backend resource mechanics
  exposes: concrete managed VM provider
  excludes: gateway meaning and controller authorization

                     ^ selected and injected by
                     |

agent-vm composition
  allowed adapter imports:
    composition/gondolin-managed-vm-provider.ts
    build/gondolin-managed-vm-build-tooling.ts
  constructs: composition-local ManagedVmProvider
  projects: ManagedVmFactory, image, owned-directory, diagnostics capabilities

agent-vm controller domains
  imports: managed-vm only
  receives: only the narrow capability required by each domain
  owns: policy authority, lifecycle ordering, leases, health, recovery,
        runtime evidence, and Tool VM parentage
```

The boundaries are independently separable:

- a new gateway kind depends on gateway and managed VM contracts but not a
  concrete backend;
- a new VM backend implements managed VM contracts but does not import gateway
  kinds;
- guest language changes do not affect host composition;
- controller authority remains unchanged when either extension axis changes.

## Security context

The Gateway VM is semi-trusted. Tool VMs execute untrusted agent-generated code.
The controller host, the two allowlisted `agent-vm` integration boundaries, and
the selected VM provider implementation are trusted for the specific authority
described below. Adapter provenance remains fixed by the regular synchronized
package dependency; this spec does not permit arbitrary runtime provider
injection by deployment code.

### Required security invariants

1. Raw secret resolution remains host-only.
2. Host-only secrets never enter a VM creation request.
3. Tool VM secrets remain HTTP-mediated and audience/agent-access filtered.
4. Gateway raw environment secrets remain explicit exceptions, not a generic
   managed VM default.
5. Allowed hosts, TCP hosts, mediated-secret bindings, and WebSocket rules
   remain explicit and fail-closed.
6. Controller path authorization and provider-side no-follow pinning remain two
   separate checks.
7. Exact Ed25519 Tool VM server identity is captured before SSH access is
   returned; failure closes access and fails lease delivery.
8. Ingress is enabled only after service health, and ingress drain begins
   before process termination.
9. VM ID, host PID, process start identity, and command remain required for
   destructive recovery actions.
10. Process identity is rechecked immediately before each signal.
11. Unproven termination does not release records, slots, or authority as if
    destruction succeeded.
12. Gateway replacement remains the security reset boundary for Tool VM leaves
    and SSH capabilities.

## Lifecycle and data flow

```text
Gateway kind implementation
  -> builds gateway VM requirements and process specification

Controller
  -> receives the projected ManagedVmFactory from agent-vm composition
  -> resolves/authorizes secrets and paths
  -> selects image/resources
  -> reserves exact ownership
  -> composes ManagedVmCreateRequest

Gondolin VM adapter
  -> validates closed request variants
  -> translates policy to Gondolin options/providers/hooks
  -> creates ManagedVm

Controller
  -> starts VM
  -> requires a positive stable host PID after start
  -> records VM id, host PID, process start identity, and command
  -> bootstraps and starts guest process
  -> proves health
  -> enables ingress/control paths
  -> owns leases and recovery until proven teardown
```

No package split may reorder those operations.

## Alternatives considered

### Rename-only two-package cut

```text
gateway-lifecycle -> gondolin-vm-adapter
```

Rejected because the gateway abstraction would still depend on its concrete
backend and Tool VM/controller code would still consume native types.

### `gateway-contracts` plus `gondolin-gateway-types`

Rejected because it gives Gondolin leakage a dedicated package without
creating a reusable managed VM owner. It also incorrectly frames managed VM
contracts as gateway-only despite Tool VM consumers.

### Put managed VM contracts inside `gateway-lifecycle`

Rejected because managed VM lifecycle has an independent owner and is consumed
by Tool VM orchestration. Gateway lifecycle should not own the repository's VM
abstraction.

### Copy current `ManagedVm` declarations into `managed-vm`

Rejected because native aliases, `getVmInstance()`, and filesystem escape
hatches would preserve semantic backend coupling.

### Full provider registry or plugin architecture

Rejected because only Gondolin exists. The composition root can inject one
concrete factory directly. A registry adds indirection without current product
value.

### Peer dependency with composition inside `agent-vm`

Rejected because dependency classification does not remove the source import,
emitted declaration, or runtime module edge. It adds package-manager-dependent
installation and missing-provider failure modes without changing architectural
coupling. Gondolin is the sole shipping backend and is not a host-owned shared
singleton, so a peer dependency has no current product role.

### External application composition package

Rejected for the current single-backend product. Moving provider construction
to a new executable package would make `agent-vm` source independent of the
adapter, but it would also move or duplicate the shipping CLI, image tooling,
diagnostics, version synchronization, publication, tarball, and E2E packaging
surfaces. Revisit this only when a second production backend or a real
adapter-free `agent-vm` library consumer makes that package boundary truthful.

### Python host lifecycle implementations

Rejected as unnecessary. Python Hermes code runs inside the guest boundary;
the controller-facing lifecycle remains a TypeScript data and behavior
contract.

## Tradeoffs

### Gains

- truthful package names and ownership;
- enforceable one-way dependency direction;
- Gondolin SDK churn contained to one adapter;
- OpenClaw, Worker, and Hermes gateway code isolated from backend mechanics;
- Tool VM/controller code uses one deliberate runtime contract;
- security-sensitive translation and ownership boundaries become inspectable;
- a future backend can be evaluated against explicit semantics.

### Costs

- exec, ingress, SSH, mount, owned-resource, and result semantics must be
  defined deliberately rather than inherited from Gondolin types;
- a mechanically broad hard cut touches manifests, exports, test doubles,
  tarball tooling, path maps, docs, architecture audits, and release inputs;
- neutral contracts initially reflect capabilities proven by one backend;
- host PID remains a required v1 capability and may constrain a future backend;
- owned host-directory semantics add an abstraction to preserve current
  pinning safety without leaking backend types.

## Proof expectations

The implementation plan must operationalize these proof modalities without
weakening or deleting existing coverage.

### Structural and declaration proof

- a workspace-manifest audit proves the allowed dependency matrix independently
  of source imports;
- a production-source import audit proves that only the two exact R6 modules
  import, re-export, or dynamically load `gondolin-vm-adapter`;
- negative structural fixtures reject forbidden manifest-only edges, forbidden
  source imports enabled by path maps, and concrete-adapter re-exports;
- only `gondolin-vm-adapter` imports the Gondolin SDK;
- Gateway orchestration, Tool VM orchestration, leases, health, runtime
  records, recovery, process supervision, resource compilation, and zone
  runtime modules import only `managed-vm`;
- emitted declarations and public exports outside the adapter contain no
  Gondolin names, native aliases, native handles, `getVmInstance`, or backend
  data escape hatches;
- compile-time negative fixtures prove runtime-domain consumers cannot access
  image, diagnostics, owned-directory, or aggregate-provider capabilities that
  were not projected into their contracts;
- OpenClaw, Worker, and a minimal Hermes-shaped compile fixture satisfy
  `GatewayLifecycle` without importing a concrete adapter;
- a fake non-Gondolin implementation can satisfy `managed-vm` at compile time;
- gateway-type registry coverage is exhaustive;
- workspace path maps, package exports, synchronized package-version checks,
  local tarball inventories, and publish inputs include the new package names
  and reject the removed names.

### Behavioral unit proof

- OpenClaw and Worker VM/process outputs retain behavioral parity;
- secret splitting, audience filtering, allowed-host rules, WebSocket policy,
  Git read-only SSH policy, and ingress defaults remain fail-closed;
- Gondolin translation preserves VM options, mounts, mediation hooks, TCP
  hosts, environment, resources, and session labels;
- injected image preparation and compatibility diagnostics preserve current
  build results, fingerprints, cache behavior, and CLI outcomes;
- SSH key capture and cleanup-on-failure remain exact;
- owned host-directory acquisition, validation, transfer, double-consumption
  refusal, construction failure, and final cleanup are proven;
- unsupported neutral contract variants fail before VM start.

### Controller integration proof

- reserve-before-create, start/bootstrap/process, health-before-ingress,
  ingress-drain-before-termination, rollback, and recovery ordering remain
  unchanged;
- pre-start host PID absence is allowed, but successful start requires a
  positive stable PID;
- runtime records retain VM ID, host PID, process start identity, and command
  before ingress, lease delivery, or another authority-admission step;
- absent or invalid post-start identity triggers rollback without releasing
  records, slots, or authority before cleanup is proven;
- Tool VM lease, slot, active-use, SSH binding, and Gateway epoch ownership
  remain controller-owned;
- ambiguous identity and unproven termination remain fail-closed and
  sibling-safe.

### Real-boundary proof

- Worker and OpenClaw Gateway VMs boot and perform production-shaped behavior;
- Tool VM creation, lease renewal/replacement, exact SSH identity, mount access,
  and teardown work through the real Gondolin path;
- cross-VM SSH rejects stale keys after same-slot replacement;
- HTTP mediation injects secrets only for allowed hosts;
- ingress streaming, WebSocket behavior, mount behavior, controller restart
  cleanup, and sibling VM preservation remain intact.

## Documentation obligations

Canonical architecture and subsystem docs must reflect:

- the new package names and dependency graph;
- the distinction between Gateway lifecycle and managed VM lifecycle;
- `agent-vm` application composition as the concrete-provider construction
  root, and the controller as the policy and durable-lifecycle authority root;
- the narrower truthful claim that `GatewayLifecycle` hides gateway-kind spec
  construction, not all gateway-specific controller behavior;
- Gondolin as the current implementation rather than the domain contract.

Current docs disagree with code about Tool VM `rootfsMode` (`memory` in prose,
`cow` in runtime construction). This package spec does not choose or change the
mode. The implementation must preserve current runtime behavior and reconcile
the stale documentation separately within the same documentation update.

## Non-goals

- Implementing another VM backend.
- Adding backend discovery, a provider registry, or runtime backend selection.
- Moving provider composition into a new executable/deployment package or
  accepting arbitrary deployment-supplied providers.
- Making `gondolin-vm-adapter` a peer or optional dependency of `agent-vm`.
- Adding dynamic gateway discovery or a cross-language host plugin protocol.
- Designing Hermes guest protocol, Python plugin, or Python Tool Portal SDK.
- Changing Gondolin or carrying a package-manager patch.
- Redesigning leases, control sessions, health, readiness, recovery, metrics,
  ingress, SSH, mounts, secrets, images, or termination behavior.
- Moving Tool VM orchestration or durable authority out of the controller.
- Splitting every health, lease, policy, or path module into a new package.
- Providing compatibility shims for old package names.
- Defining implementation task order or exact verification commands.

## Revisit triggers

Revisit the managed VM contract only when concrete evidence shows one of these:

- a second backend prototype cannot provide required host process identity,
  ingress, SSH identity, mount, or rootfs semantics;
- a second adapter duplicates the same policy translation;
- a second production backend or an adapter-free library consumer makes an
  external application composition package a truthful owner;
- a backend requires asynchronous provisioning or teardown states not captured
  by the current handle;
- production code needs streaming exec or a neutral filesystem capability;
- Hermes needs host lifecycle behavior not expressible as gateway VM
  requirements plus process and host-state hooks;
- backend conditionals appear outside the two R6 `agent-vm` integration
  boundaries and `gondolin-vm-adapter`;
- `gateway-lifecycle` changes as unrelated subdomains often enough that its
  retained umbrella ownership becomes release or dependency friction.

## Open decisions

No product-level decision blocks planning. The regular dependency, closed R6
source allowlist, composition-local provider aggregate, and narrow downstream
capability projections are fixed design decisions. Symbol names such as
`GatewayVmRequirements`, `ManagedVmCreateRequest`, and
`OwnedHostDirectory` may be refined in the implementation plan, provided their
ownership and semantics remain exactly as specified here.
