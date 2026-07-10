# Control Plane, Gateway Ownership, Tool VM Lease, and SSH Reliability Plan

Date: 2026-07-09

Status: corrective replacement plan; focused review findings folded; ready for execution

Goal id: 2026-07-09-control-lease-reliability

Source spec:
docs/specs/2026-07-09-control-plane-lease-runtime-reliability.md

Accepted source SHA-256:
08cd4e1df1c63c644cdee1d3202d54d7bf433d41e71832708406b617b133afbb

This plan replaces the obsolete cross-Gateway preservation plan in this file.
It does not preserve any task, type, test, or prototype merely because it
appeared in the earlier plan.

## Outcome

Build one reliability system around this lifetime tree:

~~~text
Controller epoch C
  └─ Gateway VM epoch G
       ├─ controller-selected OpenClaw process epochs P*
       │    └─ disposable control sessions S*
       └─ stable principal (zoneId + agentId)
            └─ one lease leaf → Tool VM + lifetime SSH binding
~~~

The direct product data path remains:

~~~text
OpenClaw in Gateway VM → SSH over Gondolin tcpHosts → Tool VM
~~~

The controller carries bounded authority and recovery control only. It never
becomes an SSH, file, provider, log, metric, trace, or OTLP tunnel.

The terminal is a fresh ready-but-unmerged PR. Implementation, required proof,
implementation review, beta proof through Terra, current PR checks, unresolved
threads, and mergeability must all be parent-verified. Merge and release are
outside scope.

## Source coverage and current evidence

The parent read all 1,589 lines of the accepted corrective spec and verified
the following current gaps against the live branch at 697dcfed:

- control-session ordering/frontiers outlive one socket and terminal stale state
  can prevent later reconnect;
- Gateway restart force-releases leases and can proceed after child-release
  failure;
- the guest shell independently restarts OpenClaw, competing with controller
  recovery;
- lease authority is duplicated and contains session/connection identity;
- command dedupe omits principal, target generation, and payload meaning;
- evidence history is bounded but sink Promise chains are not;
- Gondolin close returns Promise<void>, may finish without observed exact runner
  exit, and can invoke module-global sibling cleanup;
- beta is down on published Agent VM 0.0.113 and unpatched Gondolin 0.12.0, with
  inherited dirt and no fresh proof marker.

The historical Sunfam disconnect trigger remains unknown. This plan fixes the
code-backed permanent-stuck, ownership, recovery, and observability failures
without claiming a reconstructed historical trigger.

## Non-goals

- no Tool VM, lease, SSH credential, authority, runtime, or semantic result
  transfer across Gateway epochs;
- no controller-restart adoption;
- no independent SSH rotation/revocation state machine;
- no second control transport, stable ingress switchboard, or generic tunnel;
- no arbitrary remote-command surface in the public SSH CLI or fault harness;
- no Discord/provider redesign;
- no protection against compromised Gateway root;
- no lossless telemetry spool;
- no upstream Gondolin merge, npm release, goal merge, or PR merge.

## Security context

The controller/host is the authority root. The Gateway is semi-trusted and may
hold current same-G capabilities. Tool VMs run untrusted work. Current network
connectivity is never authority.

Every mutation validates the applicable controller, Gateway, process, session,
principal, leaf, target, purpose, expiry, semantic operation, and canonical
payload meaning. Raw session keys, credentials, SSH material, command payloads,
host paths, and unbounded errors never enter ordinary telemetry.

The controller-only process supervisor and test-only fault actuator use closed
typed operations. Neither is reachable through the public SSH CLI or generic
controller command APIs.

The existing per-agent adapter HMAC proves that a caller context came through
the expected current adapter path; it is not a security boundary against a
compromised privileged OpenClaw broker that holds the Gateway's configured key
map. The controller independently validates configured-agent membership,
canonical workspace/work-mount mapping, purpose, target, and policy before
deriving the stable principal. Cross-agent proof covers stale, misrouted, and
model-originated contexts inside the accepted semi-trusted-Gateway threat model;
it does not overclaim broker-resistant isolation.

## Gate 0: preserve dirt and freeze the execution contract

Before product edits:

1. Reconfirm branch, HEAD, status, accepted spec hash, installed package graph,
   and existing test inventory.
2. Run baseline pnpm check, unit, integration, and e2e inventory. Record
   inherited failures without repairing out-of-scope infrastructure.
3. Write a disposition ledger for every inherited prototype. No blanket clean,
   reset, or directory removal is allowed.
4. Create a new isolated Gondolin worktree from exact clean commit
   e0b339e74bdbd47bc21b943330a128d81cd1070a. Never mutate or clean the visible
   dirty Gondolin checkout.
5. Run a no-skip capability probe against the actual Gateway image: mount or
   detect cgroup v2, create a child cgroup, launch a descendant, contain it,
   and observe `cgroup.events` with `populated=0`. If the kernel supports the
   mechanism but image/init enablement is missing, add that exact enablement to
   Slice 5. If the real image cannot provide the mechanism, stop before product
   edits because the required same-Gateway process-recovery proof cannot pass.
6. Freeze the identities, limits, recovery budgets, proof file names, RED
   oracle, GREEN oracle, owned write set, and split trigger below.
7. Write `implementation-write-set.md` with one owner and checkpoint base for
   every path in the ownership-transfer table. Every checkpoint compares
   `git diff --name-only <checkpoint-base>...HEAD` with that manifest; overlap
   is allowed only after the recorded serialized handoff.

Prototype ownership:

- Slice 1 revalidates or replaces reliability fault/evidence/audit prototypes.
- Slice 3 removes obsolete Gondolin SSH-rotation exports and owned files.
- Slice 5 replaces gateway-service-continuity prototypes.
- Slice 6 removes Gateway handoff contracts and their tracked re-export.
- Slice 9 replaces the obsolete continuity + SSH-revocation live e2e.
- Ambiguous or unrelated dirt is preserved and escalated to the parent.

## Frozen identity and durability contracts

### VM reservation and destruction

Gondolin exposes:

- VmOwnershipReservationV1;
- serializable VmDestroyTargetV1;
- VmDestroyReceiptV1;
- GONDOLIN_EXACT_VM_LIFECYCLE_CONTRACT_VERSION = 1.

The reservation exists before external runner/listener/storage creation.
Deterministic resource paths, labels, and a random reservation-derived runner
discovery key are persisted before creation. Every backend embeds that key in
immutable runner command or OS-owned process metadata before `spawn`; detached
discovery resolves the key to exactly one runner before capturing its PID,
start-time cookie, and command identity. Multiple matches are unproven. Zero
matches is positive absence only after the backend proves no process with that
immutable key and no reserved runner resource remains. A parent crash after OS
spawn but before PID persistence therefore cannot turn a live runner into an
invisible or "never started" target.

Runner launch is a two-phase reservation-aware handshake: the external runner
may not become independently usable until its exact discoverable identity is
durably attached to the reservation. A parent write merely attempted "as soon
as spawn returns" is insufficient.

The reservation journal is crash- and power-loss durable: 0700 directory, 0600
files, no symlink traversal, temp-file fsync, atomic rename, and parent-directory
fsync.

Live-handle close and detached-target destroy use the same exact implementation
and return the same receipt. Gondolin `VM.close()`, Agent VM
`ManagedVmInstance.close()`, and `ManagedVm.close()` hard-cut to
`Promise<VmDestroyReceiptV1>`; no ownership-sensitive consumer may silently
ignore the receipt. Every caller is inventoried and explicitly propagates,
records, or refuses incomplete destruction. A timeout returns an
incomplete/unproven disposition. Per-VM destroy cannot call module-global child
cleanup.

The receipt independently reports runner, ingress listener, accepted/upgraded
ingress sockets, SSH listener, accepted SSH sessions, IPC/QMP/session paths,
and disposable storage as destroyed, already-absent, or unproven/incomplete.
Overall complete requires every required disposition to be positive.

### Agent VM ownership journal

There is one authoritative mutable `VmOwnershipReservationV1` resource record,
not an Agent VM copy plus a Gondolin copy. Agent VM durably creates it with the
parent and reservation identity, then passes its path/id and expected version
to Gondolin. Gondolin is the sole mechanical writer of monotonic resource and
destroy-target extensions through versioned compare-and-swap. Agent VM's
parent-membership journal references that reservation id/path and owns only
parent admission and disposition state; it never copies mutable target fields.
Startup scans parent membership first, reconciles referenced and orphaned
reservations within the deployment namespace, and treats missing, duplicate,
version-regressed, or mismatched links as owner-unsafe.

Gateway and Tool VM reservation records contain controller epoch, exact parent
Gateway epoch, reservation id, role/principal, session label, VM id, runner
discovery key, PID/start-time/command identity, reserved ports, IPC/QMP paths,
disposable paths, destroy target, and record version. The referencing Agent VM
parent-membership record contains the monotonic parent/disposition state.

LeaseManager exposes one complete parent-membership port. It registers/admits
the exact current G before leaf admission; registers a provisional child before
external creation; `sealGatewayEpoch(G)` synchronously closes admission and
returns a barrier covering current leaves, provisional reservations, and late
create/destroy completion; and retires G only after every disposition is
complete. Every leaf mutation rejects an unregistered, wrong, sealed, or
retired G. A late completion can only extend its authoritative reservation and
complete cleanup. Missing/malformed/mismatched identity is owner-unsafe. The
legacy `listLeases()` + force-release cascade paths are deleted and a structural
audit prevents a second parent-cascade path from returning.

### Process supervisor

One root-owned, non-network guest helper replaces the autonomous shell restart
loop. It is invoked only through a typed adapter with fixed ManagedVm.exec
commands and an action id.

The helper:

- launches exactly one controller-minted P inside a dedicated cgroup v2;
- writes bounded atomic request/state/receipt files through a root-only RealFS
  mount under the controller runtime directory;
- never selects or respawns a successor;
- makes start/observe/contain operations idempotent by G, P, and action id;
- reports containment complete only after cgroup.events proves populated=0.

If cgroup v2, the helper, the receipt, or exact containment is unavailable,
same-G process recovery is unavailable and OpenClawZoneRuntime selects whole-G
subtree replacement. There is no weaker containment path that can claim
success.

The supervisor mount is controller-epoch runtime state, not durable lease
authority or backup state. Controller restart destroys the old VM tree instead
of adopting the helper.

### Control and semantic identity

Gateway hello/envelopes bind C, G, selected P, and monotonically increasing
attachment generation. Each session uses a new reconnection-disabled
Socket.IO client/Manager and begins sequence counters at 1. No previous session
or global sequence frontier crosses acceptance.

A bounded G-scoped semantic ledger survives safe P/S replacement but not G/C
replacement. Every mutating operation selects one exhaustive generation
profile:

- lease authority: G + stable principal + compatibility/current leaf target;
- active use: G + exact P + stable principal + leaf + use;
- session safety: G + exact P + attachment/session fence;
- Worker: its existing Worker-specific profile, unchanged in behavior.

The semantic key includes profile, operation, target, command/idempotency
identity, and SHA-256 of a versioned canonical JSON payload. Same key/digest is
a retry; changed meaning is idempotency_collision; unknown/evicted side effects
are never replayed.

Bounds:

- completed/pending semantic results: 2,048 per zone, 10-minute active window;
- semantic unknown-side-effect tombstones: 4,096 per zone, 60-minute TTL;
- lease authority tombstones: 4,096 per zone, 60-minute TTL;
- ended/ambiguous active-use tombstones: 4,096 per zone, 10-minute TTL;
- ephemeral caller contexts: 256 per zone, fenced on P/S replacement and
  additionally capped at 10 minutes.

Pending or side-effecting results never age or evict into replayable absence.
TTL/cap eviction of a mutating entry first creates an
`unknown_side_effect` tombstone; an exact retry receives the typed unknown
result and never invokes the handler. If the active or tombstone cap cannot
admit that state, new mutating operations fail closed before dispatch. Every
semantic operation expires within 10 minutes, so the 60-minute tombstone
outlives every valid retry. Fake-clock/property proof covers pending and
completed size/TTL eviction, cap exhaustion, and collision without a second
handler invocation.

## Frozen control admission

Existing outer limits remain 256 queued messages, 4 MiB, and 64 KiB per frame
for one session. Admission and scheduling exist at both application egress and
ingress; receiver-only queues are insufficient.

Class 0 is 128 messages / 2 MiB total:

- non-consumable safety reserve: 32 messages / 512 KiB for hello, fence, close,
  acknowledgements, and results;
- fair authority remainder: 96 messages / 1.5 MiB;
- one stable principal may hold at most 8 messages / 128 KiB in the authority
  remainder;
- authority principals are scheduled round-robin.

Class 1 is 64 messages / 1 MiB, latest-wins by exact heartbeat/use/leaf key.
Class 2 is 64 messages / 1 MiB, coalescible/droppable diagnostics.
Class 3 is local metrics/traces only and never raw control traffic.

Scheduler service is bounded 8 safety, 4 authority, 2 liveness, 1 diagnostic;
after eight consecutive safety items a pending authority/liveness item receives
a turn. Class-0 safety capacity cannot be borrowed. Exhaustion fences one
session and starts bounded reconnect; it never creates a terminal supervisor
state.

The implementation never relies on Socket.IO's disconnected send buffer.
Every attempt constructs a fresh client/Manager, disables built-in reconnect,
does not emit when disconnected, uses volatile emission for droppable traffic,
and destroys the old client object on fencing.

Before application traffic, accepting a Gateway session atomically reserves its
32-message / 512-KiB safety allocation from the process budget. Existing
reservations cannot be consumed by another zone. The goal admits at most 32
current Gateway control sessions under this fixed budget; excess admission is a
typed capacity refusal, not silent overcommit. Non-safety work is capped per
zone at the remaining per-session limit and process-wide at 2,048 messages /
32 MiB, then scheduled round-robin across zones. One zone cannot consume a
sibling's safety reserve, authority turn, or response capacity. Application
queues, response Promise chains, and Socket.IO's connected/disconnected buffers
are all included in the high-water oracle.

Metric series are capped at 256 per zone and 4,096 process-wide per rolling 10
minutes; overflow increments one predeclared unlabeled counter.

## Frozen recovery budgets

### Control session

- Engine.IO ping interval / timeout: 10 s / 10 s.
- connect/authentication timeout: 3 s.
- transport acknowledgement timeout: 2 s.
- reconnect begins immediately and has an absolute 60-second deadline.
- at most 16 attempts use 250 ms exponential backoff capped at 5 s with
  multiplicative jitter in [0.8, 1.2], capped by remaining deadline.
- a non-retryable current-P rejection may start process recovery immediately.
- recovery success requires at least three heartbeats and at least 30 seconds
  elapsed.

The active-use observation grace starts at the first session gap and is 120
seconds. If same-P S2 is accepted within the reconnect window, a matching
resume/terminal report is valid only until the original deadline. Starting P
recovery makes every non-terminal P1 use ambiguous immediately and truncates
the remaining grace.

### OpenClaw process

- supervisor observation cadence: 10 s;
- process containment deadline: 20 s;
- selected successor start + service/control attachment deadline: 45 s;
- total one recovery action deadline: 90 s;
- at most three selected successor attempts in a five-minute recovery window;
- success requires six control heartbeats and three process observations across
  60 seconds;
- stable success starts a five-minute cooldown;
- more than three successful same-G process recoveries in one hour selects
  whole-G replacement on the next process failure.

An incomplete containment receipt selects whole-G replacement immediately. The
controller never starts P(n+1) while P(n) may live.

### Tool VM leaf

- active-use heartbeat cadence / stale grace: 30 s / 120 s;
- transient pre-ambiguity SSH: at most three probes within 15 s;
- runtime death: two exact-generation failures across 20 s;
- exact leaf destruction deadline: 60 s;
- replacement stability window: 60 s;
- stable replacement cooldown: five minutes;
- three failed replacement attempts in one hour suspend automatic replacement.

Cooldown never converts unsafe state into healthy state. A dead/ambiguous leaf
remains unavailable until exact destruction and a permitted replacement.

### Gateway subtree

- up to four child destroys run concurrently;
- per-target destroy deadline: 60 s;
- whole child barrier + Gateway destruction deadline: five minutes;
- replacement stability window: two minutes;
- stable replacement cooldown: 10 minutes;
- three consecutive failed replacements suspend automatic recovery.

Direct Gateway death, process recovery exhaustion, or unproven process
containment selects subtree replacement. A green /health result cannot reset or
veto dead control/process evidence. Provider status is diagnostic and
OpenClaw-owned; provider state alone never directly restarts a VM in this goal.

## Frozen evidence and no-flap budgets

Owner state changes synchronously. Evidence admission is one O(1), non-awaited
tryRecord call after owner commit.

- record maximum: 16 KiB;
- one per-zone fair ring: 64 records / 512 KiB;
- at most 32 active zone rings;
- process maximum: 2,048 records / 16 MiB;
- round-robin drain across zones;
- zones beyond the bounded ring set expose evidence-disabled-capacity without
  affecting product health;
- JSONL: four 2 MiB segments per zone, 128 MiB process-wide ceiling;
- routine success aggregates and exports at most every 30 s;
- OTLP batch: 256 records / 1 MiB;
- export timeout: 2 s, at most two retries;
- circuit opens after five failures or 90% occupancy for 30 s;
- shutdown/flush deadline: 2 s.

Queue full, disk slow, collector down, or export timeout causes
coalesce/drop/shed accounting. It never blocks owner mutation, resets health,
or chooses recovery.

Pressure oracles:

- control ping p95 <= 500 ms and p99 <= 2 s;
- outside the injected fault window, control-heartbeat gap <= 25 s;
- unrelated-zone work p95 <= 2x its same-run pre-fault baseline p95 and <= 30 s;
- no configured message, byte, record, disk, or series ceiling is exceeded;
- recoverable control-only faults resolved inside the reconnect budget cause
  zero P/G/provider restart;
- deliberate reconnect exhaustion or a non-retryable current-P rejection causes
  exactly one bounded P recovery, no G replacement unless containment/process
  recovery fails, and no independent provider restart loop;
- the final beta stable window has no unexpected C/G/P/S/leaf generation change,
  zero recovery-action transitions, and per-plane consecutive failures <= 1.

Latency evidence is invalid unless both baseline and fault/stable comparison
windows contain at least 100 control-ping samples and 20 unrelated-zone product
operations. Each window records sample count, p50/p95/p99, exact run marker,
and fault interval so a one-sample success cannot satisfy the oracle.

## Module boundaries

Likely focused modules; names may move only to follow an established adjacent
convention:

~~~text
packages/gondolin-adapter/src/
  vm-ownership-reservation.ts
  vm-destruction-receipt.ts
  vm-adapter.ts

packages/agent-vm/src/controller/
  vm-ownership/
    vm-ownership-journal.ts
    gateway-membership-barrier.ts
  zone-runtimes/
    openclaw-gateway-epoch.ts
    openclaw-process-supervisor.ts
    openclaw-recovery-budget.ts
  control-session/
    gateway-session-owner.ts
    gateway-semantic-result-ledger.ts
    gateway-control-admission.ts
  leases/
    lease-leaf-state.ts
    lease-active-use-state.ts
    lease-parent-membership.ts
    lease-manager.ts
  health/
    zone-health-vector.ts
    zone-recovery-reducer.ts
  reliability/
    bounded-evidence-queue.ts
    testing/
~~~

OpenClawZoneRuntime composes the Gateway epoch, process supervisor, control
owner, LeaseManager port, and pure recovery reducer. It does not absorb their
state. LeaseManager remains the complete leaf owner and is split by
responsibility rather than extended beyond its current 848 lines.

## Slice 1: fenced reliability proof substrate

Source: R13 and test-fault/security proof.

Behavior:

- closed fault request/receipt/refusal schemas;
- one testing-only `ReliabilityFaultPort` injected at the controller composition
  root, absent and unregistered by default;
- activation requires explicit reliability-test mode plus one-run authority;
  the harness exposes a 0600 Unix-domain socket inside its 0700 owned runtime
  directory for local/Terra operation, never a production HTTP/public route;
- the socket accepts only closed typed actions registered by the owning slice,
  with no raw signal, argv, path, command, or arbitrary payload field;
- one-run authority, run marker, identity ledger, event-driven waits, no-flap
  oracle, evidence manifest, and production-exclusion audit;
- evidence uses bounded operation identifiers and safe typed metadata, never a
  free-form command string; synthetic leak canaries scan controller/Gateway
  logs, JSONL, OTLP payloads, fault receipts, scenario JSON, and public/protected
  status for secret values/references, raw keys, host paths, payloads, and
  unbounded errors;
- Slice 1 owns `package.json`, any required `vitest.config.ts`/taxonomy wiring,
  `scripts/run-control-lease-reliability-proof.ts`, its unit tests, and the
  permanent nine-scenario manifest. The runner invokes exact filters in the
  existing no-skip VM/OpenClaw projects, continues independent later scenarios
  after an earlier failure, and returns aggregate failure;
- behavior hooks remain owned by their later slices.

Writes:

- packages/agent-vm/src/controller/reliability/testing/**;
- bounded e2e reliability helpers;
- evidence manifest/audit/runner and adjacent unit tests;
- Vitest project wiring only when required.

RED: unauthenticated, replayed, stale-generation, wrong-run, or production-mode
fault can act; stale/mixed/skipped evidence passes.

GREEN: permanent unit/host proof denies those states and the evidence validator
rejects missing, stale, skipped, todo, zero-test, wrong-head, mixed-run, or
leak-canary receipts. Production boot has no fault socket/handler/export, and a
valid-looking request is unreachable/refused.

Stop: any generic command/signal/path target or product mutation logic in the
shared fault layer.

## Slice 2: Gondolin exact single-VM lifecycle

Source: R12 and the Gondolin reservation/destruction contract.

Behavior:

- implement reservation, target extension, resource tracking, exact live and
  detached destroy, idempotence, and typed incomplete results in the isolated
  worktree;
- thread the reservation into `VM.create` before constructor-created overlay
  storage and into every backend before runner spawn;
- embed the durable reservation discovery key in backend-immutable runner
  identity, then complete the two-phase launch handshake before the runner is
  usable;
- use the one authoritative reservation record and versioned CAS extension
  contract; do not create a second Gondolin target journal;
- route close through exact destroy;
- remove module-global sibling cleanup from every per-VM path;
- export the versioned contract token.

RED: crash immediately after successful OS spawn but before PID/cookie
persistence loses the runner; zero/ambiguous discovery is misclassified;
resistant VM reports success; sibling is killed/disconnected; PID reuse passes;
live/detached differ; accepted sockets survive; or repeated destroy fails.

GREEN:

~~~text
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @earendil-works/gondolin build
corepack pnpm --filter @earendil-works/gondolin exec node --test \
  test/vm-ownership-reservation.test.ts \
  test/vm-exact-destruction.test.ts
corepack pnpm --filter @earendil-works/gondolin test
~~~

The focused proof includes the after-spawn/before-journal SIGKILL point,
zero/ambiguous discovery, backend parity, sibling survival, PID reuse, accepted
ingress/upgrade/SSH sockets, and repeated live/detached destroy.

Checkpoint: one upstream-ready local commit/diff and tree hash. Do not push,
merge, or modify the visible checkout.

Stop: any exact resource cannot be discovered or per-target destroy needs a
global kill.

## Slice 3: reproducible Agent VM exact-VM adapter

Source: Agent VM side of R12.

Behavior:

- record published 0.12.0 npm `gitHead`
  `628369764fcd2c987b4b99e5159ec90d4febe53a` and prove its `host/**` tree
  is identical to pinned base `e0b339e74bdbd47bc21b943330a128d81cd1070a`
  before edits;
- build the unmodified pinned base first and compare every patch-owned compiled
  output with the published 0.12.0 dist; unexplained baseline divergence stops
  the slice;
- build the tested Slice 2 source and use `pnpm patch`/`patch-commit` against
  the published package, copying only compiler-produced JS, declarations, and
  maps for source modules changed by the upstream commit; do not hand-edit
  generated dist or copy unrelated compiler noise;
- forbid new runtime dependencies absent from published 0.12.0;
- declare patchedDependencies in Agent VM;
- update beta sync rendering to copy/declare the exact patch;
- assert the contract version at adapter/controller startup;
- expose typed create/reservation/target/live/detached/receipt ports;
- hard-cut both Agent VM close surfaces to the receipt return type, inventory
  every Gateway/Tool VM/Worker caller, and require explicit handling of
  incomplete results. An audit rejects ownership-sensitive bare close calls.

No file:, link:, absolute path, or republished package is allowed.

RED: unpatched Gondolin boots, incomplete maps to success, detached target
cannot destroy, or clean install loses JS/types.

GREEN: frozen clean install, build, adapter unit/integration, package inspection,
contract-token import, live and detached destroy through the installed patched
package, patch/lockfile/installed-file hashes, beta-copied patch hash, targeted
VM proof, and pnpm check.

Release boundary: until upstream ships the contract, only this explicitly
patched workspace and explicitly patched Terra beta are supported targets.
This goal does not release.

## Slice 4: Gateway journal, parent seal, cascade, controller replacement

Source: R1, R8, Agent VM side of R12.

Behavior:

- mint exact C/G identities and journal the Gateway before creation;
- add LeaseManager's complete synchronous parent-membership port:
  register/admit G, admit provisional/current child, seal G and return its
  barrier, then retire G only after complete dispositions;
- reject unregistered, wrong, sealed, or retired G at every leaf mutation;
- race seal against every Gateway/Tool VM create await;
- destroy all provisional/current children, then G, then permit G2;
- on controller restart, destroy proven-owned live/detached trees and refuse
  ambiguous records;
- delete both legacy direct `listLeases()`/force-release cascade call sites so
  operator restart, controller shutdown, auto-recovery, and startup cleanup all
  traverse the same membership barrier.

OpenClawZoneRuntime is refactored into focused owner modules. It remains the
policy/composition owner.

RED: an unregistered/wrong/retired G mutates a leaf; late child commits after
seal; a legacy list/release cascade bypasses the barrier; successor starts
early; failed child destroy is ignored; C2 adopts C1; or ambiguous ownership
authorizes kill/allocation.

GREEN: unit state tables, fake-clock and create-stage races, integration
composition, host cleanup, real VM current/provisional controller restart, and
pnpm check.

Stop: a second mutable ownership store or successor while any disposition is
incomplete.

## Slice 5: controller-owned OpenClaw process epoch

Source: R2 and process-related R9.

Behavior:

- after Gate 0 proves the real-image capability, install the cgroup-v2
  mechanical helper and root-only runtime RealFS mount;
- remove the autonomous shell loop;
- implement fixed request/state/receipt parsing and exact G/P/action fences;
- implement controller-selected P launch/observe/contain state and the pure
  supervisor port; no S5 core code mutates lease/control ownership;
- after S6/S7 core gates, the parent integrates an S7-owned typed
  `processEpochLost`/ambiguity port and lets OpenClawZoneRuntime select P
  successors under the frozen budget;
- block P2 attachment and lease redisclosure until P1 containment/start receipt,
  and classify old-P non-terminal uses as ambiguous only through that S7 port.

S5a RED: guest autonomously starts P2, two processes overlap, the helper accepts
raw/unfenced commands, or cgroup empty is inferred rather than observed.

S5a GREEN/F4-P-core: helper/supervisor unit and integration, cgroup containment,
and OpenClaw lifecycle host e2e only. Real idle/active process recovery is not a
standalone S5 checkpoint because it requires S6 attachment and S7 leaf state.

P4 GREEN after serialized S5b/S6/S7b integration: P1 containment precedes P2
attachment; idle recovery keeps G/leaf/SSH stable; active recovery calls the
S7 ambiguity port, exactly destroys the affected leaf, and preserves a sibling.

Stop: raw exec strings escape or cgroup empty cannot be positively observed.

## Slice 6: disposable control owner, semantic results, fair admission

Source: R3, R5, control side of R4/R11.

Behavior:

- hard-cut common hello into domain-specific Gateway and Worker contracts;
- remove Gateway previous-session/frontier authority and terminal stale state;
- use fresh per-attempt Socket.IO clients and G-wide attachment generation;
- implement explicit semantic profiles, canonical digest, G-scoped result
  ledger, unknown-side-effect tombstones, collision/no-replay behavior;
- keep caller contexts ephemeral and emit the controller-derived stable
  principal/compatibility port;
- implement frozen Class 0/1/2 admission/scheduling at controller and Gateway
  application egress and ingress, plus per-zone/global fair service and
  response-chain bounds;
- preserve the accepted HMAC claim boundary and independently revalidate agent,
  paths, mount, purpose, target, and policy at the controller.

RED: sequence leaks into S2, stale frame/result acts, changed meaning dedupes,
caller proof survives P/S fencing, Socket.IO buffers bypass caps, or one
principal starves safety/sibling work.

GREEN/F4-C: schema/unit/property, controller/plugin integration for every
session/semantic/admission fault class, two-zone global-pressure proof, one
idle real control interruption, and mandatory Worker unit, integration, and
no-skip Worker e2e after shared contract changes. Active control/lease proof
waits for P4.

Stop: transport identity enters durable authority or transport buffers cannot
be bounded at the chosen seam, or Worker non-regression cannot be preserved.

## Slice 7: complete LeaseManager leaf and exact leaf repair

Source: R4, R6, R7, lease side of R11.

Behavior:

- S7a makes new pure leaf/parent/active-use state the sole model for authority,
  compatibility, provisional VM, stable SSH, active uses, runtime/TCP state,
  quarantine, tombstone, exact destruction, and replacement;
- S7b, after F4-C, hard-cuts LeaseManager and RPC/plugin clients to that state
  and the stable-principal semantic port;
- expose the parent-membership port and the P-bound
  `processEpochLost`/ambiguity port used by S4/S5 integration;
- remove ToolVmLeaseAuthorityStore in the same hard cutover;
- fresh P/S proof may redisclose the same safe same-G leaf binding;
- observation gap blocks conflicting use; expiry/P loss makes ambiguity;
- persistent runtime/SSH/credential uncertainty destroys/replaces one leaf.

RED: duplicate authority remains, stale/cross-agent/cross-G caller succeeds,
conflicting use overlaps, local disconnect clears ambiguity, sibling/G changes,
or old SSH works after positive destruction.

S7a GREEN/F4-L-core: pure leaf/parent/active-use state tables and properties,
including current/provisional races, unregistered/sealed/retired G denial,
observation gaps, ambiguity, tombstones, and sibling isolation.

S7b/P4 GREEN: manager/RPC/plugin hard cutover, real transient SSH, Tool VM
death, host-key corruption, remote-operation survival, exact replacement,
active-P loss, and sibling canary. The whole Slice 7 checkpoint does not close
until P4 passes.

Stop: any leaf mutation remains outside LeaseManager or compatibility shim keeps
old and new authority live.

## Slice 8: vector recovery and bounded non-authoritative evidence

Source: R9, R10, remaining R11.

Behavior:

- project immutable current snapshots from Gateway/process/control/lease/Tool
  VM/SSH/active-use/provider/evidence owners;
- implement exhaustive pure reducer to one typed repair/refusal;
- keep independent freshness, counters, budgets, single-flight, stability,
  cooldown, suspension, and outward escalation;
- replace silence with explicit control/process/recovery/destruction/evidence
  transitions;
- implement the frozen per-zone evidence rings, disk rotation, OTLP bounds,
  low-cardinality metrics, and safe operator projection.

Provider evidence is diagnostic and OpenClaw-owned; it does not directly choose
VM recovery.

RED: /health 200 vetoes dead control, one plane clears another, concurrent
repairs occur, collector blocks product, queue exceeds caps, or shedding is
silent.

GREEN: exhaustive fake-clock reducer, integration under HTTP 200/dead control,
never-resolving disk/export sinks, two-zone saturation/fair drain, host
collector proof, real control/lease/provider/SSH progress, and pnpm check.

Stop: evidence becomes owner truth or recovery input.

## Slice 9: composed real-runtime reliability proof

Source: R13.

This slice adds no product behavior. Every failure routes to its owning slice.
Each scenario is independently runnable and cleanable:

1. control loss idle and during active SSH, within and beyond grace;
2. idle OpenClaw kill with stable G and safe leaf;
3. OpenClaw kill during a remote side effect that survives local loss;
4. one Tool VM death and separate SSH identity corruption;
5. Gateway replacement with all old children absent before G2;
6. controller exit at current and every provisional create stage, including
   immediately after OS runner spawn and before PID/cookie persistence;
7. two agents in one Gateway plus two zones: one principal/zone floods
   Class-0/global admission while the sibling principal and unrelated zone keep
   safety, control ping, and lease progress;
8. collector down/slow/saturated with control/provider/SSH/unrelated-zone work;
9. repeated faults followed by a stable no-flap window.

Every test emits one result JSON with exact HEAD, patch/source/package
identities, run marker, C/G/P/S/leaf/VM/SSH deltas, fault receipt, queue/shed
state, cleanup receipt, and highest real boundary exercised.

No monolithic test may hide later scenarios after one cleanup failure.

Slice 1 owns `scripts/run-control-lease-reliability-proof.ts`, the root command,
and the nine-entry scenario manifest. Slice 9 owns only the independently
runnable scenario files under
`packages/agent-vm/src/integration-tests/control-lease-reliability/` and fills
the manifest's exact existing `e2e-vm`/`e2e-openclaw` filters. The aggregator
runs every isolated scenario even after an earlier failure, rejects
zero/skip/todo/mixed-run/mixed-head evidence, and exits nonzero if any receipt
fails.

## Slice 10: Terra beta and ready-but-unmerged PR

Source: R14 and beta proof.

Precondition: all local gates and a pre-beta implementation review are green on
one exact committed/pushed head.

The parent gives the persistent Terra sidekick one bounded packet containing
installed tarball and Gondolin patch identity, inherited beta hashes/dirt,
unrelated-QEMU denylist, one-time 1Password in-memory injection, typed fault
allowlist, fresh marker, before/after identity ledger, bounded Victoria queries,
and ordered restoration.

Beta schedule:

- up to 30 minutes of directed independently receipted faults covering the nine
  required scenario families;
- then 90 uninterrupted minutes with no injected faults;
- during the final window: no unexpected generation change, zero recovery
  actions, plane failures <= 1, heartbeat gap <= 25 s, queue ceilings hold, no
  spontaneous process/provider restart, and real Tool VM SSH/file work plus
  two-agent and unrelated-zone canaries continue.

Any missing patch/install identity, secret exposure, cleanup failure, unrelated
dirt mutation, or unrelated QEMU touch invalidates the run.

Restoration is downgrade-safe. Terra first stops the controller, seals the
current Gateway epoch, obtains complete exact receipts for every Gateway/Tool
VM/listener/socket/runtime/reservation, and writes a zero-owned-resource
manifest. Only then may it restore the prior unpatched packages/lockfile. Any
incomplete disposition forbids downgrade; preserve the patched cleanup-capable
state, forward-fix or report blocked. Post-restore proof compares packages,
processes, VM/resource inventory, and inherited dirt with the baseline.

After successful restoration, refresh implementation review, PR checks using
the blocking watch command with 20-second interval, unresolved comments/threads,
mergeability, and exact head. Leave the PR open and unmerged.

## Requirements/proof matrix

### R1 Gateway owns subtree

Owning slices: 2-4, 9.

Proof source: reservation/seal unit and create-race integration; exact
Gondolin/VM subtree replacement; beta Gateway replacement.

evidence source: parent-run commands, exact receipts, Terra run.

freshness guard: same run marker and exact C/G/child identities; G2 ready time
after all G1 dispositions.

### R2 process recovery preserves safe children

Owning slices: 5, 9.

Proof source: cgroup helper/supervisor tests; idle and active OpenClaw kill.

evidence source: process receipt, unchanged G/safe leaf, changed P/S, real SSH.

freshness guard: exact P1 absence before P2 and one run identity.

### R3 sessions are disposable

Owning slices: 6, 9.

Proof source: per-fault unit/integration and real Socket.IO interruptions.

evidence source: explicit transition ledger and identity deltas.

freshness guard: S1 fenced before S2 application traffic; G/P unchanged where
required.

### R4 LeaseManager owns authority

Owning slices: 6-7, 9.

Proof source: structural audit, leaf tests, fresh proof reattach, cross-agent/G
denial.

evidence source: current leaf snapshot and parent-run tests.

freshness guard: no durable transport fields/imports at exact HEAD.

### R5 semantic retries preserve meaning

Owning slices: 6-7, 9.

Proof source: canonicalization/profile/collision/eviction/no-replay tests and
pending/completed eviction-to-unknown tombstone tests plus one real side-effect
marker.

evidence source: semantic ledger and exactly-once remote marker.

freshness guard: unique run-scoped operation/idempotency identity.

### R6 Tool VM and SSH repair one leaf

Owning slices: 3, 7, 9.

Proof source: transient probes, Tool VM death, SSH corruption, old-key denial,
sibling success.

evidence source: exact leaf receipt and real SSH/file operation.

freshness guard: pre/post leaf/VM/SSH and sibling identities in one run.

### R7 active-use ambiguity never overlaps

Owning slices: 6-7, 9.

Proof source: grace/resume/expiry tests and surviving remote operation.

evidence source: use ledger, denial receipt, remote marker, destroy receipt.

freshness guard: exact P/leaf/use and non-overlap ordering.

### R8 controller restart replaces

Owning slices: 2-4, 9.

Proof source: ownership classification, detached cleanup, current/provisional
controller exit.

evidence source: journals, exact targets/receipts, C1/C2 identity ledger.

freshness guard: no C2 authority before all proven C1 targets complete.

### R9 recovery is vector-based and anti-flapping

Owning slices: 5, 8-10.

Proof source: exhaustive fake-clock reducer, HTTP-200/dead-control integration,
repeated faults and stable soak.

evidence source: per-plane snapshots/budgets and marker-correlated time series.

freshness guard: frozen constants, exact HEAD/package/patch, bounded window.

### R10 telemetry is bounded and non-authoritative

Owning slices: 8-10.

Proof source: queue properties, slow/down sinks, two-zone and real saturation.

evidence source: high-water/shed/flush metrics plus concurrent product markers.

freshness guard: fault interval and unrelated-zone baseline in one run.

### R11 semi-trusted commands are capability-limited

Owning slices: 1, 6-8, 9.

Proof source: schema/auth/fairness denial, production exclusion, controller
validation and HMAC claim-boundary tests for cross-agent misuse, two-agent
load, and two-zone global safety/fair-progress load.

evidence source: typed refusal and reserved-capacity/sibling progress.

freshness guard: current schema/diff and controller-derived principal proof.

### R12 VM destruction is exact

Owning slices: 2-4, 7, 9.

Proof source: upstream resources, live/detached parity, resistance, sibling,
PID reuse, after-spawn/before-PID crash discovery, authoritative reservation
CAS/reconciliation, close-consumer cutover, and adapter refusal.

evidence source: exact target and resource-by-resource receipt.

freshness guard: upstream tree hash, patch hash, contract version, target cookie.

### R13 real boundaries prove product behavior

Owning slices: 1, 9.

Proof source: one permanent aggregate command, nine no-skip independent
scenario filters, and evidence manifest.

evidence source: authoritative runner JSON, not inventory or mocks.

freshness guard: exact HEAD, clean/declared dirt hash, run/marker/query identity.

### R14 delivery is ready but unmerged

Owning slice: 10.

Proof source: exact-head local aggregate, implementation review and affected
reruns on that head, Terra plus downgrade-safe restoration, and PR
checks/threads/mergeability.

evidence source: parent verification and current GitHub state.

freshness guard: final pushed head after the last behavior change.

## Execution DAG and ownership

~~~text
G0  baseline + dirt disposition + parameter freeze
 │
 ├─ S1 proof substrate ─────────── F0 ──────────────────────┐
 └─ S2 isolated Gondolin ───────── F1                       │
      └─ S3 adapter/consumer patch F2                       │
           └─ S4 Gateway journal/seal F3 ───────────────────┤
                ├─ S5a process core F4-P                     │
                ├─ S6 control core F4-C ───┐                 │
                └─ S7a leaf core F4-L ─────┤                 │
                         └─ parent S5b/S7b integration P4     │
                              └─ S8 recovery/evidence P5      │
                                   └─ S9 code + initial F6-A  │
                                        └─ implementation review
                                             └─ fixes + affected reruns F6-B
                                                  └─ freeze exact pushed head
                                                       └─ S10 Terra/PR
~~~

Safe parallelism:

- S1 and S2;
- after F3, S5a process helper internals, S6 control owner, and S7a
  pure leaf/parent/active-use state;
- inside S8, pure recovery reducer and bounded evidence transport;
- independent S9 scenarios with isolated temp roots/ports/VMs.

Serialized:

- S2 → S3 → S4;
- `openclaw-zone-runtime.ts`: S4, then S5b, with parent-owned integration;
- `lease-manager.ts`: S4 parent-port handoff, then one S7b owner;
- `openclaw-lifecycle.ts`: S5a helper/mount/start sections, then S6 only for
  hello/control configuration fields;
- shared control schemas, controller/plugin control owner, and Worker-coherent
  contract edits: one S6 owner;
- S6 stable port before S7b RPC/plugin hard cutover;
- P4 before S8 integration;
- S9 code and initial proof before implementation review;
- accepted review fixes, every affected/downstream rerun, and a final-head
  review receipt before the exact pushed head is frozen for Terra.

### Ownership-transfer table

| Owner | Exclusive paths/surfaces | Handoff |
| --- | --- | --- |
| S1 | `packages/agent-vm/src/controller/reliability/testing/**`, reliability proof helpers/manifest/audit, `scripts/run-control-lease-reliability-proof.ts`, runner unit tests, root `package.json` command, required Vitest/taxonomy wiring | F0 before product fault hooks; S9 owns scenario files only |
| S2 | isolated Gondolin worktree: reservation, backend runner discovery, exact destroy, resource tests | F1 upstream-ready commit/tree hash to S3 |
| S3 | `packages/gondolin-adapter/src/**` exact-lifecycle ports, pnpm patch, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, beta patch renderer/sync script | F2 to S4; no other lane touches patch/lockfile |
| S4 | `vm-ownership/**`, parent-membership module, `openclaw-zone-runtime.ts` Gateway journal/seal/cascade sections, narrow first edit to `lease-manager.ts` | hand `openclaw-zone-runtime.ts` to S5b and `lease-manager.ts` to S7b after F3 |
| S5a/S5b | process-supervisor modules and helper; `openclaw-gateway/src/openclaw-lifecycle.ts` helper/mount/start sections; after core gates, process-recovery sections of `openclaw-zone-runtime.ts` | lifecycle file then hands hello/config section to S6; runtime returns to parent after P4 |
| S6 | shared Gateway/Worker control contracts; `control-session/**`; plugin `gateway-control-service/**`; caller context and semantic/admission modules; hello/config section of `openclaw-lifecycle.ts` after S5a | stable principal/semantic/P-S ports to S7b/P4 |
| S7a/S7b | new pure `leases/**` leaf/parent/use modules, then `lease-manager.ts`, `gateway-control-lease-rpc.ts`, and plugin lease-client hard cutover after F4-C | complete leaf ports to parent P4 |
| S8 | recovery reducer and bounded evidence modules; no composition/status/manual files | parent integrates after P4 |
| S9 | only nine files under `integration-tests/control-lease-reliability/**` and scenario-owned helpers | no root runner/config edits |
| Parent | `controller-runtime.ts`, `gateway-zone-orchestrator.ts`, composition barrels, status/health routes, docs/manual templates, cross-owner integration and review-fix integration | no subagent edits without an explicit serialized transfer |

No S5 or S7 whole-slice checkpoint closes at its core gate. P4 is the first
gate that may claim real process/control/active-use/leaf recovery composition.

Checkpoint commits occur only after slice RED/GREEN and owned checks pass.
Subagent commits are candidates; the parent inspects every diff and chooses the
repo-authorized integration mechanism. No subagent owns completion.

## Validation ladder

Slice commands are targeted first. Every required layer remains explicit.

Gondolin:

~~~text
corepack pnpm --filter @earendil-works/gondolin build
corepack pnpm --filter @earendil-works/gondolin exec node --test \
  test/vm-ownership-reservation.test.ts \
  test/vm-exact-destruction.test.ts
corepack pnpm --filter @earendil-works/gondolin test
~~~

Agent VM checkpoints:

~~~text
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm test:taxonomy
pnpm test:unit
pnpm test:integration
pnpm test:e2e:host
pnpm test:e2e:host-docker
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:vm
mise exec -- pnpm test:e2e:vm-mediation
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e:worker
pnpm check
~~~

Terminal exact-head:

~~~text
pnpm check
pnpm test:unit
pnpm test:integration
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e:worker
mise exec -- pnpm test:e2e:control-lease-reliability
~~~

Inventory is inventory only. Any zero/skip/todo result in a proof project fails
the gate. Worker no-skip is mandatory after shared control changes. No test is
deleted, weakened, relabeled, or moved down the pyramid to get green.

## Docs and operator proof

Update the canonical storage, OpenClaw, controller, Gateway lifecycle, and
Gondolin docs with the implemented contracts. Update generated manual templates
for operator-visible state/reason/cleanup behavior, their unit snapshot, and run
a built-CLI manual update smoke proof.

Protected status answers current C/G/P/S generations, health plane, active
repair/cooldown/refusal, leaf state, exact destroy disposition, evidence shed,
and successor barrier. Public/agent views do not disclose sibling or secret
material.

## Roll-forward, rollback, and invalidation

- This is a hard cutover. No old/new dual authority, resync, SSH rotation, or
  Gateway preservation path remains.
- Code with live new-format reservations cannot downgrade to code that cannot
  clean them. Forward-fix or exact cleanup while owner-unsafe.
- Unproven same-G process recovery falls outward to exact Gateway replacement.
- Unproven exact destruction stops replacement and preserves evidence.
- Evidence may shed/disable without affecting product state.
- Beta restores only owned runtime/package/patch changes and preserves inherited
  dirt.
- A change reruns its local gate and every downstream gate. Shared control
  changes also rerun Worker. Any behavior change after Terra invalidates Terra.
- Product failure in a composed proof routes to the owning slice; proof is never
  weakened. Environment/credential/CI blockers remain separate.

## Plan completion receipt

phase_result: complete when the focused plan review reports ready and the parent
records the transition.

evidence: this plan; accepted spec; corrective planning lanes; Fable advisor;
parent live-source verification.

recommended_next_workflow: shravan-dev-workflow:plan-review-swarm, then
shravan-dev-workflow:implementation-execute-plan.

recommended_transition_reason: the corrected Gateway-owned lifetime tree is
decomposed into locally provable slices with exact owners, parameters, proof,
beta, and ready-PR gates; no further broad planning cycle is permitted.
