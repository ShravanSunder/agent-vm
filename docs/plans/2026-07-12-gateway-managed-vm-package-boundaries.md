# Gateway lifecycle and managed VM package boundary implementation plan

Date: 2026-07-12

Source spec:
`docs/specs/2026-07-12-gateway-managed-vm-package-boundaries.md`

Goal id: `2026-07-12-gateway-managed-vm-boundaries`

## Goal

Perform the behavior-preserving hard cut from `gateway-interface` and
`gondolin-adapter` to three truthful owners:

- `@agent-vm/gateway-lifecycle` for gateway-kind lifecycle vocabulary and
  shared gateway policy;
- `@agent-vm/managed-vm` for backend-neutral VM contracts and semantics;
- `@agent-vm/gondolin-vm-adapter` for the stock Gondolin implementation.

Keep `agent-vm` as the shipping application with a regular adapter dependency.
Only the two exact R6 production modules may import the adapter. Keep the
aggregate `ManagedVmProvider` local to those integration boundaries and inject
narrow capabilities into controller domains. Preserve every existing Gateway,
Tool VM, lease, SSH, ingress, mount, secret, health, recovery, and termination
behavior except the spec-required correction that a successfully started VM
must expose a valid host PID before authority admission.

## Non-goals

- another VM backend, backend registry, discovery, or runtime selection;
- a peer, optional, or deployment-supplied adapter;
- an external application composition package;
- dynamic gateway discovery or Hermes guest protocol work;
- Gondolin changes or package-manager patches;
- redesigning leases, health, recovery, ingress, SSH, secrets, images, or
  termination;
- compatibility packages, aliases, forwarding exports, or dual old/new paths;
- publishing packages, merging the PR, or releasing an image.

## Source coverage and current-state anchors

The accepted spec was read in full: 735 of 735 lines. Planning re-anchored on
the current branch `gateway-managed-vm-boundaries` at
`96ff0843b72dfae84c0fb3ebc8598b78e84eb601`.

Load-bearing current surfaces:

- `packages/gateway-interface/src/gateway-vm-spec.ts` imports adapter-owned
  mount and SSH policy types;
- `packages/gondolin-adapter/src/vm-adapter.ts` exposes native aliases,
  `ManagedVmInstance`, filesystem access, and `getVmInstance()`;
- `packages/gondolin-adapter/src/pinned-realfs.ts` owns the current
  `O_NOFOLLOW` and device/inode pinning defense;
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` and
  `packages/worker-gateway/src/worker-lifecycle.ts` import adapter policy;
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`,
  `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`, controller leases,
  runtime records, recovery, build, CLI, and resource code import concrete
  adapter surfaces today;
- Gateway startup already records process identity before health and ingress;
  Tool VM startup currently permits a null PID after start and must be corrected;
- `scripts/audit-vm-ownership-boundaries.ts` proves destruction/close
  invariants but does not prove the new package graph, two-file source import
  allowlist, or declaration neutrality;
- `scripts/sync-local-tarballs-to-deployment.ts`, TypeScript path maps, package
  manifests, exports, lockfile, publish inputs, and E2E harness inventories
  contain the old package names.

## Security and reliability constraints

1. Raw secrets remain host-only. Neutral requests carry mediated descriptors
   and explicit policy, not resolved host-only values.
2. `OwnedHostDirectory` has an explicit ownership lifecycle:

   ```text
   acquired
     ├── close before transfer ──> closed
     └── consume once ───────────> adapter-owned
                                     ├── construction failure ──> closed
                                     └── VM close ──────────────> closed
   ```

3. Controller authorization uses canonical identity; the adapter separately
   performs final-component no-follow opening and identity revalidation.
4. Before start, PID absence is allowed. After successful start, a positive
   stable PID plus process-start identity and command must be durably recorded
   before ingress, SSH return, or lease delivery.
5. `ManagedVm.close()` remains mechanical cleanup. Destructive recovery stays
   controller-owned and identity-fenced, including a fresh identity check before
   both SIGTERM and SIGKILL.
6. Unproven termination retains records, slots, lease authority, and cleanup
   context. It never releases authority as though teardown succeeded.
7. SSH access is not returned until exactly one valid Ed25519 server key is
   captured; identity-read failure closes the created access.
8. Ingress remains health-gated, and drain starts before identity-fenced
   termination.
9. A third production adapter importer, native escape hatch, provider
   discriminator, reusable owned-directory capability, or raw-path fallback is
   a replan trigger rather than an allowed shortcut.

## Execution DAG

```text
P0  repo/source/proof preflight
 |
 v
S1a managed-vm contracts and compile fixtures
 |
 v
S1b gateway-lifecycle hard rename and ownership cut
 |
 v
S1c atomic host-file utility extraction
 |
 v
I0  contract/package-map freeze receipt
 |
 +---------------------------+
 |                           |
 v                           v
S2a Gondolin neutral       S3a OpenClaw/Worker
runtime translation       lifecycle parity cutover
 |
 v                           v
S2b owned-directory       S3b remaining gateway-
state machine             lifecycle consumers
 |                           |
 +-------------+-------------+
               |
               v
I1  package contract/parity integration gate
               |
        +------v------+
        |             |
        v             v
S4a composition     S4b build/tooling
provider projection projection
        |             |
        +------v------+
               |
               v
I2  exact R6 integration-boundary gate
               |
               v
S5a Gateway orchestration and PID/ingress authority
               |
               v
S5b Tool VM owned-directory, PID, SSH, lease, epoch authority
               |
               v
S5c remaining controller/recovery/health/process/resource cutover
               |
               v
I3  complete neutral-domain integration gate
               |
               v
S6a package/name/release-surface hard cut
               |
               v
S6b structural/declaration enforcement and pack audit
               |
               v
S6c canonical docs and conditional generated manuals
               |
               v
S6d full proof closure from exact HEAD
               |
               v
IR1 one implementation-review-swarm cycle
               |
               v
IR2 findings disposition, addressing, and exact-HEAD reproof
               |
               v
PR1 implementation-pr-wrapup; prove ready and leave unmerged
```

Only S2 and S3 work may run in parallel. Their contract is frozen by the I0
receipt after S1a-S1c. S5 is deliberately serialized because the Gateway, Tool VM, lease,
recovery, and process-identity surfaces share authority and rollback ordering.
One integration owner owns physical package renames, the lockfile, shared root
path maps, and cross-lane conflict resolution.

## Task cards

### P0 — Preflight current state and proof prerequisites

Source anchors: whole spec; goal contract; repo test taxonomy.

Actions:

- capture `git status --short`, branch, and HEAD; preserve unrelated work;
- verify the spec, goal details, transition log, and this plan exist;
- inventory all old package-name references and concrete adapter imports;
- verify Node/pnpm and pinned `mise` tools; preflight Docker, QEMU, and Zig
  availability without booting product VMs;
- capture the authoritative test/evidence commands and current package graph;
- record whether OpenClaw and Worker live-lane prerequisites are available.

Checkpoint: current-state inventory and environment prerequisites are recorded;
no files are staged by broad glob.

Proof: read-only commands and current HEAD markers. If a live prerequisite is
missing, continue with plan slices but retain an explicit final-proof blocker;
do not edit unrelated infrastructure.

### S1a — Create backend-neutral managed VM contracts

Source anchors: R4, R7-R9, R14-R23, R32.

Write scope:

- new `packages/managed-vm/**`;
- package-local compile/unit fixtures;
- `scripts/verify-managed-vm-contracts.ts`, its unit test, and isolated fixture
  projects used only by that verifier;
- no shared root path-map, workspace, lockfile, or cross-package manifest edits;
  those belong to the I0 integration owner.

Behavior/capability:

- define owned structural exec/result, SSH/access/server-key, ingress/route,
  mount, mediation, resource, rootfs, process-ID, and create-request types;
- define `ManagedVm`, composition-local `ManagedVmProvider`, and narrow
  `ManagedVmFactory`, image, diagnostics, and owned-directory capabilities;
- make create requests closed and fail-closed;
- forbid native aliases, native handles, filesystem escape, `unknown` backend
  payloads, `getVmInstance`, `nativeOptions`, and `backendData`;
- define the post-start positive/stable PID contract;
- define the explicit owned-directory state and exact-once consumption contract.

Test-first proof:

- add an isolated `scripts/verify-managed-vm-contracts.ts` harness and
  `scripts/verify-managed-vm-contracts.unit.test.ts`; permanent negative fixture
  projects live outside normal workspace compilation, the harness invokes
  `tsc`, asserts nonzero exit plus the expected diagnostic, and proves the
  corresponding clean consumer passes;
- add failing compile-negative fixtures for current native aliases/escape
  hatches and overbroad provider access through that harness;
- add positive fake non-Gondolin provider and lifecycle-independent contract
  fixtures;
- add unit tests for closed variants and ownership-state transitions.

Green gate: package build/typecheck/unit pass; emitted declarations contain only
owned structural types; `managed-vm` has no gateway/controller/Gondolin imports.

Split/replan: any required domain capability can only be expressed through a
native handle, opaque backend payload, or provider discriminator.

### S1b — Hard rename `gateway-interface` to `gateway-lifecycle`

Source anchors: R1-R3, R7-R13, R30-R32.

Write scope:

- physical replacement `packages/gateway-interface/**` →
  `packages/gateway-lifecycle/**`;
- gateway package manifest, exports, package-local tests;
- no shared root path-map, lockfile, or consumer-manifest edits; those belong to
  I0 or the owning consumer slice.

Behavior/capability:

- preserve the intentional gateway-domain umbrella and shared policies;
- replace adapter-owned mount/SSH types with `managed-vm` intent types;
- keep gateway workload intent separate from image/resource/backend authority;
- retain optional language-specific runtime policies when they are shared
  across gateway kinds or gateway-managed VM surfaces, including the current
  Node IPv4-egress policy and future shared Python policy;
- retain gateway-kind configuration projections and shared path policy without
  making Node, Python, OpenClaw, Worker, or Hermes mandatory for every
  `GatewayLifecycle` implementation;
- move only concrete gateway implementation behavior, backend translation, or
  controller authority to its truthful owner;
- add a Python-guest lifecycle compile fixture and retain exhaustive shipping
  `GatewayType` registry coverage;
- remove the old package completely—no shim or forwarding export.

Test-first proof: retarget policy tests; add a permanent package-local compiler
verifier that observes compile/import failures for the old name and
concrete-adapter dependency before completing the rename; prove a Python-guest
lifecycle implementation satisfies the shared host contract without using
optional Node helpers or OpenClaw-only fields while those shared runtime helpers
remain available to consumers that select them. This cut does not add a
shipping Hermes `GatewayType` or configuration projection.

Green gate: gateway-lifecycle build/unit/compile fixtures pass; package depends
on managed-vm but not a concrete adapter or controller.

Split/replan: a gateway-shared policy is discovered to be controller authority
or backend translation rather than gateway lifecycle behavior.

### S1c — Extract atomic host-file utilities from the VM adapter

Source anchors: R26 and the exact R6 import boundary.

Dependencies: S1b naming fixed. This task completes before the parallel fork.

Write scope:

- `packages/openclaw-gateway/src/write-file-atomically.ts` and focused tests for
  OpenClaw-owned host-state writes;
- `packages/agent-vm/src/shared/write-file-atomically.ts` and focused tests for
  Gateway runtime records, Tool VM runtime records, and control-session
  material;
- deletion of `packages/gondolin-adapter/src/write-file-atomically.ts` and its
  export from `packages/gondolin-adapter/src/index.ts`;
- the four current consumers only:
  `openclaw-lifecycle.ts`, `gateway-runtime-record.ts`,
  `tool-vm-runtime-record.ts`, and
  `gateway-control-session-material-store.ts`.

Behavior/capability:

- preserve same-directory temporary write, requested file mode, atomic rename,
  and temporary-file cleanup on failure;
- remove the generic utility from the adapter public surface;
- accept the small package-local duplication because OpenClaw must not depend on
  the application package and no neutral VM contract owns host-file writes.

Test-first proof: mode, atomic replacement, rename failure, and temporary-file
cleanup parity tests fail before extraction and pass for both owners.

Green gate: none of the four consumers imports the adapter for generic file
writing; package-local tests pass.

Split/replan: another cross-package consumer appears that makes duplication
material; choose a truthful existing host-filesystem owner rather than adding a
generic VM/shared package.

### I0 — Freeze contracts, package mappings, and parallel-lane receipt

Parent/integration-owner actions:

- record the exact exported symbols and declaration hashes for `managed-vm` and
  `gateway-lifecycle` plus the passing fake-backend, Hermes-shaped, positive,
  and isolated negative fixture results;
- complete the gateway physical directory/package rename and update root
  workspace, TypeScript, Vitest, and package-manager mappings needed for the
  renamed/new packages to resolve;
- update only the consumer manifest edges required to let S2 and S3 start;
- run one install/lockfile regeneration and record the resulting lockfile
  marker;
- publish a contract receipt in the implementation evidence ledger; S2 and S3
  must run the unchanged receipt fixtures before handoff;
- exclude root mappings, lockfile, and shared manifests from S2/S3 write scopes.

Gate: the new packages and receipt fixtures build together. The workspace is not
yet required to have zero old names or be fully green because adapter and
consumer migrations follow. C1 is not created here.

Rollback: if S2 or S3 finds a missing neutral semantic, pause both lanes, change
S1 only with a failing fixture, rerun I0, record a new receipt/hash, and then
restart both lanes. Do not let either lane mutate the frozen public contract.

### S2a — Implement neutral Gondolin runtime translation

Source anchors: R14-R20, R24-R25.

Dependencies: S1a contract freeze.

Write scope: physical replacement `packages/gondolin-adapter/**` →
`packages/gondolin-vm-adapter/**`, excluding owned-directory work reserved for
S2b where practical. Root mappings, shared manifests, and the lockfile remain
integration-owner-only.

Behavior/capability:

- implement neutral VM creation and runtime handle over stock Gondolin;
- translate closed environment, resources, rootfs, mediation, TCP hosts,
  mounts, SSH policy, ingress/routes, and session label inputs;
- preserve synthetic DNS/internal-IP enforcement, Git read-only SSH policy,
  exact server-key capture, error translation, and cleanup aggregation;
- expose neutral image/diagnostics capabilities without native declaration
  leakage;
- remove `fs`, `ManagedVmInstance`, native aliases, and `getVmInstance()` from
  public contracts;
- reject unsupported variants before backend VM construction.

Test-first proof: translation parity, unsupported variants, SSH identity and
cleanup failure, PID lifecycle, and declaration-leak tests fail first and pass
after implementation.

Green gate: adapter build/unit pass; only this package imports Gondolin SDK;
public declarations expose no native types.

Split/replan: policy meaning must move into the adapter or a concrete handle
must escape to satisfy a domain.

### S2b — Implement `OwnedHostDirectory` pinning and transfer

Source anchors: R21-R23 and security invariants 6, 9-11.

Dependencies: S1a and S2a runtime construction seam.

Write scope: adapter owned-directory/pinning modules and tests only.

Behavior/capability:

- preserve `O_NOFOLLOW`, canonical identity, device/inode capture, and
  revalidation at mount construction;
- make acquired, consumed, adapter-owned, and closed states explicit;
- close on caller pre-transfer failure, adapter construction failure, and VM
  close; reject double consumption and ambiguous ownership;
- never convert the capability back into an authorization-bearing raw path.

Test-first proof: no-follow substitution, canonical identity, revalidation,
pre/post-transfer cleanup, double consume, construction failure, and final
close exact-count tests fail first.

Green gate: complete ownership matrix passes with no native provider/FD type in
neutral declarations.

Split/replan: a raw-path fallback or reusable/cloneable ownership capability is
required.

### S3a — Cut OpenClaw and Worker lifecycle implementations to neutral intent

Source anchors: R3, R10-R13, R30-R32.

Dependencies: S1a and S1b. Parallel-safe with S2.

Write scope: `packages/openclaw-gateway/**` and
`packages/worker-gateway/**` only. The shared lockfile and root mappings are
excluded.

Behavior/capability:

- consume gateway-lifecycle and managed-vm intent types only;
- preserve VM/process requirements, mounts, environment, host hooks, health,
  auth, secret split, allowed hosts, TCP/WebSocket policy, and runtime paths;
- move atomic host-file writing to the concrete OpenClaw owner or appropriate
  host utility per R26;
- eliminate concrete-adapter dependencies/imports.

Test-first proof: preserve exact VM/process output parity assertions and make
the concrete-import ban fail before migration.

Green gate: both packages build; lifecycle parity unit/host tests pass; no
concrete adapter or Gondolin dependency remains.

Split/replan: lifecycle implementation needs backend construction, image
selection, CPU/memory authority, leases, ingress admission, or termination.

### S3b — Migrate all remaining gateway-lifecycle consumers

Source anchors: R1-R13, R30-R32 and hard-cut R9.

Dependencies: S1b; integrate after S3a.

Write scope: remaining gateway-lifecycle consumers in agent-vm,
openclaw-agent-vm-plugin, worker/runtime packages, tests, and their manifests;
one integration owner handles shared path maps/lockfile.

Behavior/capability:

- migrate shared policy, health, lease vocabulary, config projections, runtime
  paths, plugin contracts, and registry consumers to the new package;
- preserve the static exhaustive gateway-kind registry;
- remove all production/test references that would keep the old package alive;
- keep plugin/Gateway boundaries free of managed VM construction authority.

Exact ownership inventory:

- S3b owns every gateway-name source/test/manifest/package-local-tsconfig
  consumer, including `openclaw-agent-vm-plugin` and worker/runtime packages;
- S5 owns adapter-typed controller test helpers and native runtime consumers;
- S6b owns `scripts/audit-portal-architecture.ts` and its tests, including the
  gateway export/index rule and renamed package inventory;
- S6a owns root/release surfaces: tarball and E2E package inventories, root path
  maps, lockfile finalization, exports, and publish/package metadata.

Test-first proof: old-package reference inventory and registry/compile fixtures
start red, then package-focused unit/typecheck gates pass.

Green gate: no remaining import or manifest dependency on gateway-interface;
all gateway-lifecycle consumers compile and their targeted tests pass.

Split/replan: a consumer reveals a domain that does not belong in the retained
gateway umbrella; route ownership deliberately rather than creating a generic
shared helper.

### I1 — Freeze contracts and integrate S2/S3

Parent actions:

- inspect public interfaces and emitted declarations;
- run all new package builds and targeted unit/compile fixtures;
- scan SDK and concrete-adapter imports;
- resolve S2/S3 contract drift before agent-vm composition work;
- regenerate the lockfile once through the integration owner.

Gate: S1-S3 package builds and targeted proof pass together with no native
leakage and no old names in the renamed packages or the production/package
consumers explicitly owned by S1-S3. The parent records the exact remaining
old-name inventory assigned to S4-S6. Full-workspace zero-old-name proof is
reserved for S6b after S6a completes all name mutations.

Checkpoint C1 is created here, after the integrated packages, mappings, and
lockfile are green—not at I0.

### S4a — Add the exact provider composition boundary

Source anchors: R6-R8, R15, R25, R27.

Dependencies: I1 and S2 provider.

Write scope:

- `packages/agent-vm/src/composition/gondolin-managed-vm-provider.ts`;
- neutral composition callers/tests and the agent-vm manifest as necessary.

Behavior/capability:

- construct the single Gondolin `ManagedVmProvider`;
- this module is the only runtime aggregate constructor and returns an
  application-composition object containing only narrow neutral projections;
- keep the aggregate inside composition;
- project only the factory and separately justified capabilities;
- preserve a regular synchronized adapter dependency and fixed provenance;
- forbid arbitrary runtime/deployment provider injection.

Topology rule: S4a does not pass `ManagedVmProvider` to S4b. The aggregate type
may occur only inside the two R6 files, and neither file imports an aggregate
from the other.

Test-first proof: composition tests and compile-negative domain-access fixtures
fail until aggregate containment and projection are correct.

Green gate: the aggregate appears only at the composition/build integration
boundaries; domain constructor signatures cannot access it.

Split/replan: a third adapter importer or public backend selector appears
necessary.

### S4b — Consolidate the exact Gondolin build/tooling boundary

Source anchors: R6, R15, R24-R27.

Dependencies: I1 and S2 image/diagnostics capability.

Write scope:

- `packages/agent-vm/src/build/gondolin-managed-vm-build-tooling.ts`;
- existing build/image cache/fingerprint, CLI build/doctor/init, compatibility,
  and package-spec callers migrated to neutral projections;
- tests for build and diagnostic parity.

Behavior/capability:

- make this the only non-composition production adapter importer;
- construct only backend-specific image-build and diagnostics implementations,
  exporting neutral capability factories/results; do not construct or receive
  the runtime `ManagedVmProvider` aggregate;
- project image preparation/build/cache and compatibility diagnostics through
  neutral interfaces;
- preserve fingerprints, cache results, package-spec behavior, Zig checks, CLI
  outcomes, and managed-image inputs;
- keep generic atomic file writing outside the adapter.

Test-first proof: build/diagnostic parity, third-import negative fixtures, and a
compile fixture proving no aggregate crosses between S4a and S4b start red.

Green gate: build and CLI integration tests pass through neutral projections;
concrete import inventory is reduced to the two exact R6 files, except that the
final audit is enabled only after S5 removes remaining domain imports.

Split/replan: backend-specific build metadata must leak into controller-domain
contracts.

### I2 — Verify composition and build projection

Parent actions: inspect both exact R6 modules, downstream signatures, manifest
dependency, and interim import inventory. Any aggregate provider parameter in a
domain is a hard stop.

Gate: composition/build tests and declarations pass; remaining adapter imports
are enumerated and owned by S5 migration, not silently allowlisted.

### S5a — Cut Gateway orchestration to `ManagedVmFactory`

Source anchors: R19-R20, R27, security invariants 8-11.

Dependencies: I2 and S3.

Write scope: Gateway orchestrator, Gateway runtime record/support, process
epoch/health integration, narrow test helpers, and directly related tests.

Behavior/capability:

- inject `ManagedVmFactory` rather than concrete creation/native handles;
- preserve reserve → create → start → durable VM/PID/start identity/command →
  bootstrap/process → health → ingress;
- reject invalid/unstable post-start PID before later admission;
- preserve ingress drain before identity-fenced termination and rollback record
  retention.

Test-first proof: missing/invalid PID, record-before-ingress, health-before-
ingress, ingress failure rollback, identity mismatch, and sibling-preservation
tests fail first where newly introduced.

Green gate: targeted Gateway unit/integration tests pass and no Gateway domain
imports adapter/native types.

Split/replan: behavior parity requires reordering authority or treating close as
termination proof.

### S5b — Cut Tool VM construction, mount, SSH, and lease authority

Source anchors: R19-R23, R27-R29, security invariants 3, 6-7, 9-12.

Dependencies: S5a and S2b.

Write scope: Tool VM lifecycle, lease manager/authority/runtime record/SSH
identity/recovery modules, Tool VM test helpers, and related tests.

Behavior/capability:

- inject `ManagedVmFactory` and a separate owned-directory opener;
- preserve controller canonical-path authorization and exact Gateway epoch,
  slot, active-use, lease, and SSH binding ownership;
- hard-fail null/invalid PID after start before VM preparation, SSH enablement,
  or lease delivery;
- durably record VM ID/PID/start identity/command before admission;
- capture exact Ed25519 key before returning access;
- close/retain resources correctly on every failure boundary;
- invalidate old-epoch leaves and keys on Gateway replacement.

Test-first proof: post-start null PID, exact-once mount transfer, construction
failure cleanup, double consumption, SSH identity failure, stale-key
replacement, unproven destruction authority retention, and lease ordering tests
fail first.

Green gate: Tool VM/lease unit and integration suites pass; no raw/native mount
or adapter types remain in controller domains.

Split/replan: pinned security cannot be preserved or PID admission requires a
new recovery model.

### S5c — Cut remaining controller domains and recovery plumbing

Source anchors: R7-R9, R14-R20, R27-R29.

Dependencies: S5a and S5b.

Write scope: remaining controller runtime/types, health, recovery, process
supervision, resource compiler, shared process/termination modules, testing
helpers, and related tests.

Behavior/capability:

- replace all remaining adapter imports/native aliases with managed-vm
  contracts and narrow dependencies;
- preserve exact per-signal identity rechecks, runner-detach proof, cleanup
  aggregation, recovery decisions, runtime records, and sibling safety;
- remove the legacy identity-optional, command-only destructive signal path:
  every controller-owned destructive signal requires recorded process identity
  and a live identity match; an identity-less record sends no signal and keeps
  its runtime record, slot, lease authority, and cleanup context quarantined;
- re-read and match identity independently before SIGTERM and again before
  SIGKILL, refusing the second signal if identity changed;
- retain records/slots/authority on unproven termination;
- ensure resource/policy compilation produces neutral intent rather than
  backend options.

Test-first proof: import inventory, identity-fenced termination, an identity-less
record sending no signal, identity changing between SIGTERM and SIGKILL, PID
reuse, unproven cleanup retention, recovery, health, and resource compilation
tests fail before cutover where appropriate.

Green gate: all targeted unit/integration tests pass; all agent-vm controller
domains import managed-vm only; no native declaration/escape remains.

Split/replan: existing behavior proves a genuine lifecycle mismatch rather than
a package migration; stop code edits and reconverge.

### I3 — Complete neutral-domain integration gate

Run and inspect:

- targeted tests for every changed package and controller cluster;
- `pnpm test:unit`;
- `pnpm test:integration`;
- package build/typecheck;
- provisional import/declaration scans.

Gate: lower layers are green before structural closure or live E2E. Behavioral
failures route to their owning slice, not S6.

### S6a — Close package names, provenance, release, and tarball surfaces

Source anchors: R1-R9, documentation/release proof expectations.

Dependencies: I3.

Write scope: manifests/exports/path maps/lockfile, version synchronization,
local tarball inventories/tests, E2E package lists, publish inputs, and existing
package-name architecture audits including `scripts/audit-portal-architecture.ts`
and its tests.

Behavior/capability:

- include all three new packages with synchronized versions and correct
  sibling dependencies;
- require `agent-vm` to declare `@agent-vm/gondolin-vm-adapter` as a regular
  exact synchronized dependency—not peer, optional, range, or deployment input;
- require the adapter manifest and lockfile to resolve the approved stock
  Gondolin version with integrity and no patch, override, replacement protocol,
  or local substitute;
- remove both old names from path maps, manifests, exports, lockfile, tarball
  inventories, publish/package inputs, and generated package metadata;
- migrate the existing portal architecture audit’s package inventory and
  gateway export/index rule so current coverage remains active under the new
  names;
- preserve managed-image metadata separation from npm versions;
- do not publish.

Test-first proof: old-name inventory, missing-new-package, peer/optional/range
adapter dependency, wrong Gondolin pin, patch/override, and stale audit-rule
fixtures fail before updates.

Green gate: package sync, tarball/E2E inventory tests, migrated portal audit,
manifest/path-map/export/lock scans, and package builds pass. Full new-boundary
audit and `pnpm check` remain S6b gates so they run only after all mutations.

Split/replan: publication would be required to prove the change; registry work
is outside this goal.

### S6b — Enforce the hard boundary and inspect exact-HEAD packages

Source anchors: R5-R9 and structural/declaration/release proof expectations.

Dependencies: S6a has removed every old-name/provenance surface.

Write scope:

- `scripts/audit-managed-vm-boundaries.ts` and unit tests;
- `scripts/verify-managed-vm-contracts.ts` and unit tests;
- read-only `scripts/inspect-managed-vm-package-cut.ts` and unit tests;
- isolated permanent fixtures outside normal workspace compilation;
- `scripts/run-check-gate.ts` integration.

Behavior/capability:

- independently audit workspace manifest edges and production source imports;
- enforce exactly the two R6 production adapter importers;
- reject static imports, re-exports, dynamic imports, path-map-enabled imports,
  third importers, forbidden edges, peer/optional/range provenance, wrong stock
  Gondolin resolution, patches/overrides, and old names;
- prove only the adapter imports the Gondolin SDK;
- rebuild and scan emitted public declarations/exports for native names and
  escape hatches;
- run isolated negative `tsc` projects, assert nonzero exit plus the intended
  forbidden-access diagnostic, and prove matching clean consumers pass without
  joining normal workspace compilation;
- add the fast audits/verifiers to `pnpm check`;
- make `inspect-managed-vm-package-cut.ts` derive the affected publishable
  dependency closure from workspace manifests, including at minimum
  `managed-vm`, `gateway-lifecycle`, `gondolin-vm-adapter`,
  `openclaw-gateway`, `worker-gateway`, `openclaw-agent-vm-plugin`, and
  `agent-vm`;
- record `git rev-parse HEAD`, require a fresh build from that HEAD, pack into an
  owned OS-temp directory, and emit a machine-readable receipt covering every
  tar member, packed `package.json`, sibling version/dependency, declarations,
  removed-name absence, and absence of npm-version pins in managed-image
  metadata.

Exact targeted commands:

```text
pnpm vitest run --config vitest.config.ts --project unit \
  scripts/audit-managed-vm-boundaries.unit.test.ts \
  scripts/verify-managed-vm-contracts.unit.test.ts \
  scripts/inspect-managed-vm-package-cut.unit.test.ts
pnpm tsx scripts/audit-managed-vm-boundaries.ts
pnpm tsx scripts/verify-managed-vm-contracts.ts
pnpm tsx scripts/inspect-managed-vm-package-cut.ts \
  --expected-head <git-rev-parse-HEAD>
```

Test-first proof: one isolated negative fixture per forbidden mechanism fails
for the expected reason before implementation; clean counterparts and the
normal workspace build remain green.

Green gate: targeted tests/commands, exact-HEAD pack receipt, declaration
verifier, build, typecheck, and `pnpm check` pass after all S6a mutations.

Split/replan: the audit needs broad exemptions/changed-files scanning, negative
fixtures cannot isolate expected failure, or package proof is ad hoc or
deployment-mutating.

### S6c — Reconcile canonical docs and generated manuals

Source anchors: documentation obligations and R1-R32.

Dependencies: S6b behavior/package graph fixed.

Write scope: canonical architecture/subsystem/config docs and generated manual
templates/tests only when deployment agents need operational guidance.

Behavior/capability:

- document the new graph, lifecycle/VM distinction, application composition
  root, controller authority root, exact R6 allowlist, capability projection,
  and Gondolin-as-implementation claim;
- update package maps and source links;
- correct stale Tool VM `rootfsMode: memory` prose to current runtime `cow`
  without changing runtime behavior;
- update manual templates only if package/runtime behavior affects deployment
  operators, with corresponding unit and built-CLI manual smoke proof.

Green gate: docs reference only new package names except historical/rejected
contexts; manual-template tests and built CLI smoke pass when applicable.

Split/replan: documentation reveals behavior different from the accepted spec
or current proven runtime.

### S6d — Full proof closure

Dependencies: S6a-S6c.

Run from exact final HEAD:

1. `pnpm build` once.
2. `pnpm test:unit`.
3. `pnpm test:integration`.
4. `pnpm check`.
5. `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:host-docker`.
6. `AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:host`.
7. `mise exec -- env AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:vm`.
8. `mise exec -- env AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:vm-mediation`.
9. `mise exec -- env AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:openclaw`.
10. `mise exec -- env AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm test:e2e:worker`.
11. `pnpm test:e2e:inventory`, reported only as inventory—not product proof.
12. `pnpm tsx scripts/inspect-managed-vm-package-cut.ts --expected-head
    <git-rev-parse-HEAD>` and the established
    `manual-cli.host.e2e.test.ts` proof through the host lane; if manual
    templates changed, inspect the built-CLI generated output explicitly.

Map live evidence to named behaviors, not only lane names:

- real VM construction/mount/teardown: `live-gondolin-vm.vm.e2e.test.ts`;
- allowed/disallowed mediation: `live-gondolin-http-mediation.vm.e2e.test.ts`
  and `live-http-mediation.vm.e2e.test.ts`;
- exact SSH replacement/stale-key refusal:
  `live-cross-vm-ssh.vm.e2e.test.ts` and lease replacement tests;
- Gateway/Tool VM replacement: `lease-leaf-replacement` and
  `gateway-subtree-replacement` OpenClaw tests;
- restart cleanup and sibling preservation: controller-restart ownership and
  cleanup tests;
- OpenClaw control/ingress path: live control-link and stability tests;
- WebSocket upgrade/control behavior:
  `openclaw-control-session.openclaw.e2e.test.ts` and
  `live-openclaw-control-link.openclaw.e2e.test.ts` must assert the real upgrade
  and established WebSocket transport;
- ingress streaming/SSE behavior:
  `openclaw-subagent-lease.openclaw.e2e.test.ts` must assert the real
  `text/event-stream` path and completed streamed behavior; if its current
  assertions do not prove that obligation, add a scoped permanent OpenClaw E2E
  assertion before accepting the lane;
- Worker production behavior: `worker-loop.worker.e2e.test.ts`.

Evidence must report exact commands, exit codes, pass/fail/skip/todo counts,
current HEAD, and built artifact provenance. Evidence runners must reject zero
tests, skips, and todos where required. Missing Docker/QEMU/Zig/OpenClaw/Worker
prerequisites are blockers for the affected real layer, not permission to edit
unrelated infrastructure or relabel lower-layer proof.

Gate: every requirements/proof row below is done or explicitly not-applicable
with evidence. Then route to `implementation-review-swarm`.

### IR1 — Run one implementation-review cycle

Dependencies: S6d exact-HEAD proof.

Actions:

- run one `shravan-dev-workflow:implementation-review-swarm` cycle over the
  complete scoped diff and proof chain;
- include whole-implementation, architecture/import-boundary,
  security/reliability, test/proof, and package/release-artifact lanes;
- verify every candidate finding against live source, tests, artifacts, and the
  accepted spec before accepting, rejecting, or contesting it;
- record one disposition ledger with severity, evidence, owning slice, and
  required reproof.

Gate: every substantive finding has a parent-verified disposition. This goal
permits one implementation-review cycle; do not loop reviews.

### IR2 — Address findings and restore exact-HEAD proof

Dependencies: IR1 disposition ledger.

Actions:

- address each accepted finding in its owning slice or evidence-reject it with
  concrete source/proof;
- rerun every affected local red/green, unit, integration, structural,
  declaration, package, docs, and live boundary gate;
- if any finding changes behavior, package graph, public declarations, release
  artifacts, or real-boundary code, rerun the complete S6d proof sequence;
- rebuild and rerun `inspect-managed-vm-package-cut.ts` after the final review
  edit so declarations and packed artifacts are tied to the post-review HEAD;
- record final HEAD, commands, exits, counts, and disposition evidence.

Gate: no accepted finding remains unresolved, all required affected/full proof
is green from the final post-review HEAD, and scoped checkpoint C6 is created.

Split/replan: a review finding exposes an accepted-spec contradiction or needs
out-of-scope infrastructure changes; stop and request the required decision
rather than starting a second review cycle.

### PR1 — Prove PR readiness without merging

Dependencies: IR2 post-review exact-HEAD proof and scoped commit.

Actions:

- use `shravan-dev-workflow:implementation-pr-wrapup` to push the scoped branch
  and create or update the pull request;
- verify the PR head matches the exact locally proven commit;
- watch checks with `gh pr checks <pr> --watch --interval 20` or the workflow-
  specific blocking watch required by repo policy;
- inspect current PR comments, unresolved review threads, requested changes,
  checks, mergeability, and artifact/proof links;
- address only in-scope PR findings with affected proof reruns; if this changes
  the head, repeat final readiness checks and exact provenance confirmation;
- report mergeability/readiness and explicitly leave the PR unmerged.

Terminal gate: implementation and proof complete; review findings addressed or
evidence-rejected; current checks/comments/threads/mergeability reported; PR
head equals the proven commit; PR ready and not merged.

## Requirements/proof matrix

### VP1 — Package graph and hard-cut names

Requirement or claim: R1-R9 package ownership, allowed edges, exact replacement,
and absence of compatibility paths.

Owning tasks: S1a, S1b, S3b, S6a, S6b.

Proof modality and gate: separate manifest graph audit; old-name scan; negative
manifest fixture; path-map/export/lock/tarball/package inspection; `pnpm check`.

Proof layer: unit/static architecture/build/release artifact.

Evidence source: parent-run audit/test output and exact-HEAD packed artifacts.

Freshness guard: full workspace scan and artifacts produced from final HEAD.

Red/green required: yes—manifest-only edge, old name, missing new package.

Scope fit: each owning task has a local structural or artifact gate.

### VP2 — Exact production adapter-import allowlist

Requirement or claim: only the two R6 modules import/re-export/dynamically load
the adapter; only the adapter imports Gondolin SDK.

Owning tasks: S4a, S4b, S5a-S5c, S6b.

Proof modality and gate: full production-source audit with negative fixtures for
ordinary import, re-export, dynamic import, path-map bypass, and third importer.

Proof layer: unit/static architecture.

Evidence source: parent-run audit tests and current source inventory.

Freshness guard: full production tree at final HEAD, not changed files.

Red/green required: yes.

Scope fit: the final green assertion waits until S5 completes migration.

### VP3 — Public neutrality and capability projection

Requirement or claim: R14-R18 structural types, no native escape, fake backend
compatibility, composition-local aggregate, narrow downstream capabilities.

Owning tasks: S1a, S2a, S4a-S4b, S6b.

Proof modality and gate: positive fake backend/Hermes fixtures; negative
capability fixtures; rebuilt declaration/export inspection; typecheck/build.

Proof layer: unit/compile/build.

Evidence source: parent-run compile fixtures and emitted declarations.

Freshness guard: authoritative rebuild before scanning all public declarations.

Red/green required: yes.

Scope fit: stop if native payloads or provider discriminators are required.

### VP4 — Gateway lifecycle behavior and language neutrality

Requirement or claim: R10-R13 and R30-R32 preserve OpenClaw/Worker lifecycle
outputs, shared policy, exhaustive registry, and host-language boundary.

Owning tasks: S1b, S3a, S3b.

Proof modality and gate: policy/lifecycle parity unit tests, Hermes-shaped
compile fixture, exhaustive registry test, existing host-shaped lifecycle test.

Proof layer: unit/compile/host boundary.

Evidence source: parent-run targeted and full unit/host results.

Freshness guard: current package imports and build outputs.

Red/green required: yes for import/contract cutover; behavior assertions must
remain equivalent.

Scope fit: guest-specific contract fields route back to design.

### VP5 — Gondolin translation and owned resources

Requirement or claim: R15-R25 preserve translation, fail-closed variants,
image/cache/diagnostics, exact SSH identity, and owned-directory security.

Owning tasks: S2a, S2b, S4b.

Proof modality and gate: adapter unit suites; ownership-state tests;
unsupported-variant test; declaration scan; real VM/mount proof.

Proof layer: unit/integration/VM E2E.

Evidence source: parent-run tests and evidence-runner result from current build.

Freshness guard: exact current HEAD and no skipped/todo live tests.

Red/green required: yes for closed variants, ownership states, double consume,
cleanup failures, and server-key failure.

Scope fit: no FD/provider/raw-path leak accepted.

### VP6 — Controller admission and lifecycle ordering

Requirement or claim: R19-R20 and R27 preserve reserve/start/identity record/
bootstrap/health/ingress and identity-fenced termination ordering.

Owning tasks: S5a, S5c.

Proof modality and gate: targeted Gateway and termination unit/integration tests;
post-start PID rejection; recovery and restart real-boundary proof.

Proof layer: unit/integration/VM/OpenClaw E2E.

Evidence source: parent-run tests and named real-boundary evidence.

Freshness guard: current source order and exact built HEAD.

Red/green required: yes for PID and newly introduced DI/failure boundaries.

Scope fit: any lifecycle reorder beyond the spec is a replan trigger.

### VP7 — Tool VM lease, mount, SSH, epoch, and recovery

Requirement or claim: R21-R23 and R27-R29 preserve controller authorization,
owned mount, exact PID/key binding, replacement, authority retention, and
sibling safety.

Owning tasks: S2b, S5b, S5c.

Proof modality and gate: Tool VM/lease unit/integration; real mount, cross-VM
SSH, replacement, mediation, restart cleanup, and sibling-preservation tests.

Proof layer: unit/integration/VM/mediation/OpenClaw E2E.

Evidence source: parent-run tests and named evidence-runner results.

Freshness guard: exact built HEAD; old epoch/key must be observed rejected.

Red/green required: yes for null PID, exact-once ownership, SSH failure,
replacement, and unproven termination retention.

Scope fit: inability to prove pinning or identity is a security blocker.

### VP8 — Package, operator, documentation, and manual surfaces

Requirement or claim: package exports/versions/tarballs/publish inputs and
canonical operational docs reflect the hard cut; runtime rootfs remains `cow`.

Owning tasks: S6a, S6b, S6c.

Proof modality and gate: version/tarball tests, path/export scans, exact-HEAD
pack inspection, docs old-name/rootfs scan, manual-template unit and built-CLI
smoke when applicable.

Proof layer: unit/build/host/release artifact/docs.

Evidence source: parent-run output and inspected generated artifacts.

Freshness guard: packed/manual output from exact final HEAD.

Red/green required: yes for old-name/new-package inventories; manuals only when
templates change.

Scope fit: publishing is explicitly out of scope.

### VP9 — Full production parity and PR readiness

Requirement or claim: all spec behavior remains production-shaped across
Worker, OpenClaw, Tool VM, mediation, ingress streaming/SSE, WebSocket
upgrade/control, replacement, restart, and teardown; PR is reviewable and ready
but unmerged.

Owning tasks: S6d, IR1, IR2, PR1.

Proof modality and gate: full unit/integration/check; explicit host-docker,
host, VM, VM-mediation, OpenClaw, and Worker lanes; named WebSocket and SSE
assertions; implementation review/disposition/reproof; current PR checks,
comments, threads, mergeability, and artifact evidence.

Proof layer: all pyramid layers plus PR gate.

Evidence source: parent-run commands, implementation-review disposition, and
fresh GitHub state.

Freshness guard: final PR commit/HEAD and blocking watch results; inventory is
never substituted for proof.

Red/green required: lower slice rows own red/green; final closure composes them.

Scope fit: merge and publication remain out of scope.

## Checkpoint and commit rhythm

- P0: inventory only, no commit.
- I0 produces a non-commit contract/package-map receipt; it is not yet a
  repo-green checkpoint.
- C1 after I1: accepted neutral contracts, package renames, integrated S2/S3
  consumers, root mappings, and lockfile are green together.
- C2 after integrated S2/S3: adapter and gateway consumers compile with local
  proof.
- C3 after S4a/S4b: exact composition/build boundaries and projections.
- C4 after each S5a, S5b, and S5c authority checkpoint when independently green.
- C5 after S6a-S6c package/provenance, structural/declaration/pack, and docs
  closure.
- C6 after IR2 findings are addressed/evidence-rejected and required proof is
  rerun from the final post-review HEAD.
- PR1 pushes C6, proves current PR readiness, and leaves the PR unmerged; it
  does not create a post-proof code checkpoint.

Checkpoint commits are allowed only for scoped verified files, must not stage
unrelated work, and are never treated as proof themselves.

## Rollback and recovery during implementation

- Contract gap in S2/S3: stop both lanes, add a failing neutral fixture in S1a,
  parent re-freezes the contract, then resume; never add an opaque escape hatch.
- Owned-directory security gap: stop S2b/S5b and retain the old behavior only as
  the unmerged baseline; no raw-path fallback.
- PID unavailable or unstable after start: stop before admission and reconverge;
  do not weaken durable identity.
- S5 parity/order regression: rework only the current checkpoint-sized subtask;
  do not compensate in the E2E harness.
- Structural/declaration failure: route to the owning implementation slice;
  never add broad exemptions.
- Live environment failure: retain lower-layer evidence and report the exact
  prerequisite; do not edit unrelated runners/tooling or call inventory proof.
- Package artifact leak: fix S6b, rebuild, repack, and reinspect; no shim.

## Open questions

No product or architecture decision blocks execution. File names inside the new
packages may be refined while preserving the exact ownership and public
semantics. The plan-review cycle should challenge task completeness, proof
coverage, and live feasibility, but it must not reopen the accepted spec without
a concrete contradiction.

## Phase footer

phase_result: complete

evidence:
`docs/specs/2026-07-12-gateway-managed-vm-package-boundaries.md`, this plan,
`tmp/plan-workflows/2026-07-12-gateway-managed-vm-boundaries/plan-ledger.md`, and
the planning lane artifacts.

recommended_next_workflow: `shravan-dev-workflow:implementation-execute-plan`

recommended_transition_reason: The accepted spec is mapped to independently
provable implementation tasks, the single permitted plan-review cycle completed,
and all verified findings were addressed in one pass with no open blocker or
spec contradiction.
