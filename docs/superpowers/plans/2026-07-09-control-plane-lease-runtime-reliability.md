# Control Plane and Tool VM Runtime Reliability Plan

Date: 2026-07-09

Status: corrective execution plan; stock Gondolin; no dependency patches

Goal id: `2026-07-09-control-lease-reliability`

Source spec:
`docs/specs/2026-07-09-control-plane-lease-runtime-reliability.md`

## Outcome

Deliver a stable controller-owned lease system in which:

```text
Controller C
  └─ Gateway VM G
       ├─ recoverable OpenClaw process and control sessions
       ├─ agent A -> Tool VM leaf A -> pinned SSH
       └─ agent B -> Tool VM leaf B -> pinned SSH
```

Healthy Gateway and Tool VM state survives control/OpenClaw recovery. One dead
Tool VM is replaced without sibling churn. Gateway or controller replacement
creates a clean VM tree. Telemetry cannot impair product traffic.

The implementation uses stock `@earendil-works/gondolin@0.12.0`. The existing
pnpm patch and every dependency on its private lifecycle API are removed.
Dependency patches, generated dependency forks, local republishing, and hidden
equivalent workarounds are prohibited.

Terminal: all implementation and review findings resolved; required unit,
integration, host, real VM/OpenClaw/SSH, telemetry-pressure, and Terra beta
proof green; PR ready and unmerged.

## Source coverage and correction boundary

The parent read the complete prior 1,589-line spec and 1,154-line plan, current
patch consumers, stock Gondolin source, existing Agent VM PID/runtime recovery,
and two independent controller-owned architecture audits.

The following concepts remain valid and should be salvaged where current code
implements them cleanly:

- controller ownership lock and controller epoch;
- exact Gateway-to-Tool membership and synchronous admission fencing;
- per-agent lease mutation serialization;
- durable Gateway and Tool PID/process identity records;
- disposable control sessions and bounded semantic retry;
- OpenClaw process recovery inside one Gateway;
- leaf-only Tool VM/SSH recovery;
- health-vector recovery, anti-flap budgets, and bounded evidence;
- strict per-Tool-VM SSH server identity.

The following corrective-design mechanisms are removed:

- Gondolin ownership reservations, CAS journal, destroy targets, and receipts;
- Agent VM reservation inventory/reconciliation built around those types;
- resource-by-resource destruction proof and `owner-unsafe` states caused only
  by missing internal Gondolin receipts;
- patch installation, hash synchronization, beta patch rendering, and
  patch-specific tests;
- crash-stage proof for hard kill between VM spawn and PID persistence;
- checkpoint/CLI/generated-output collateral introduced only by the patch.

Preserve unrelated and inherited worktree changes. Do not reset, clean, or
stage files outside the explicit correction/implementation write set.

## Security and residual risk

The controller host is trusted; Gateway is semi-trusted; Tool VMs run untrusted
work. Controller restart adopts no VMs. Gateway-to-Tool command/file bytes stay
on direct SSH. Control carries bounded authority only.

Accepted residual risk: a hard controller `SIGKILL` precisely after stock
Gondolin spawns a runner but before Agent VM persists its PID can leave an
unknown orphan. Ordinary exit is covered by Gondolin's child cleanup and known
PIDs are covered by Agent VM recovery. Add bounded diagnostic evidence; do not
build a dependency fork for this micro-window.

Strict Tool VM SSH identity remains required. Agent VM reads the live guest's
Ed25519 host public key through the exact `ManagedVm.exec` path and supplies
controller-owned strict `known_hosts` material. The Tool image must not ship a
reusable baked host key.

## Slice 0: retire the private Gondolin lifecycle fork

Behavior:

1. Add/adjust focused tests that define the stock-Gondolin boundary before
   deleting private lifecycle code.
2. Remove `patches/@earendil-works__gondolin@0.12.0.patch` and the
   `patchedDependencies` entry.
3. Regenerate the lockfile/install so Gondolin resolves unpatched.
4. Delete `packages/gondolin-adapter/src/exact-vm-lifecycle.ts` and tests whose
   only purpose is patch installation or private contract proof.
5. Remove patch-copy/render logic from beta synchronization and delete patch
   identity from evidence manifests.
6. Replace private `getDestroyTarget`, reservation, and receipt types at every
   caller with stock live-handle/PID lifecycle contracts.

Proof:

- host dependency inspection proves no Gondolin patch is declared or applied;
- repository search finds no private lifecycle imports, patch-copy logic, or
  patch identity claims;
- stock Gondolin build/import and existing non-lifecycle adapter tests pass.

Stop/split trigger: a caller requires behavior unavailable from stock
Gondolin. Classify it against the source spec before adding any replacement
abstraction; do not patch the dependency.

## Slice 1: controller-owned VM records and sibling-safe destruction

Consolidate lifecycle authority around existing Gateway and Tool runtime
records. A controller-owned Gateway epoch seed exists before VM construction;
after stock Gondolin returns the unstarted handle, attach its `vm.id` to form
the full Gateway identity before start, Tool admission, or publication. Each
current record contains parent Gateway identity, VM id, PID, process start
identity/command, slot/endpoint, and leaf identity as applicable.

Implement one controller-owned destroy sequence:

```text
fence authority
  -> revalidate selected PID identity
  -> TERM / bounded wait / revalidate / KILL if required
  -> observe runner absence
  -> stock VM.close() for remaining live handles
  -> verify relevant endpoint/slot absence
  -> finalize record and slot
```

Tool leaf destruction must never call stock `VM.close()` while a resistant
selected runner can still reach Gondolin's global sibling fallback. Gateway
replacement uses the same primitive for children before the parent.

Simplify or delete reservation-derived modules rather than preserving their
shape with new names. Retain controller lock, parent admission fence, bounded
destruction scheduling, and late-create cleanup only where they operate on
controller runtime records.

Proof:

- unit red/green for identity mismatch, TERM/KILL continuity, late create,
  fencing, seed-to-full-Gateway identity, record finalization, and slot reuse;
- deterministic proof that stock `VM.close()` is never called while Gondolin
  still reports the selected runner;
- integration red/green for child-before-parent ordering and controller restart,
  including restart between fence persistence and process termination;
- real stock-Gondolin test with Gateway G, Tool T1/T2, active SSH through T1,
  exact T1 termination plus stock close, T1 endpoint absent, and G/T2 identity
  and SSH preserved;
- repeated cleanup is safe and never kills an unrelated PID.

## Slice 2: strict Tool VM SSH identity

Remove dependence on Gondolin's patched `serverHostKey` return value.

1. Ensure Tool VM image creation removes baked SSH host keys.
2. After stock `enableSsh()`, read the live guest Ed25519 public host key through
   `ManagedVm.exec`.
3. Validate and store the key in the exact lease generation.
4. Produce strict caller-owned `known_hosts`; never use stock Gondolin's
   `StrictHostKeyChecking=no` convenience command for agent work.
5. On leaf replacement, require a new server identity and deny the old one.

Proof:

- parser/schema and no-secret unit tests;
- integration proof that lease material contains one validated exact key;
- real same-slot replacement: old key denied, fresh key accepted, sibling SSH
  unchanged.

## Slice 3: finish process, control, and lease recovery

Preserve already-proven controller-owned work that is independent of the
Gondolin fork:

- fresh disposable sessions with session-local sequences and bounded receipts;
- current-process attachment generations and stale-frame fencing;
- semantic identity/collision/no-replay behavior;
- one authoritative LeaseManager runtime per Gateway;
- controller-selected OpenClaw process recovery with cancellation on stop;
- active-use observation gap and ambiguity handling;
- preservation of healthy idle Tool leaves across same-G process/session
  replacement.

Replace patch-receipt checks in these paths with Slice 1 product-scoped
destruction outcomes. An ambiguous active use fences and replaces only its
leaf. No remote side effect is automatically replayed.

Proof:

- focused control, semantic, LeaseManager, and process-recovery unit/integration
  suites;
- Worker shared-contract non-regression;
- real control interruption without G/P/leaf churn;
- real idle P1-to-P2 with stable G and Tool identities;
- real active-use P1 loss: affected leaf replaced, remote side effect not
  replayed, sibling leaf preserved.

## Slice 4: health vector, anti-flap, and bounded telemetry

Finish independent health planes and the pure recovery reducer. A green
Gateway `/health` cannot clear dead control/process evidence. Repairs are
single-flight, generation-fenced, deadline-bounded, stability-gated, and
outwardly escalating.

Control traffic keeps a reserved safety/authority class. Lease renew and
heartbeats coalesce as latest-wins liveness. Diagnostics shed before safety.
JSONL/OTLP queues and flushes have fixed record/byte/deadline bounds and cannot
reenter product mutation. Saturation tests must name the configured capacity,
drop/backpressure condition, and product-operation deadline being protected;
"still responsive" is not a sufficient oracle.

Proof:

- fake-clock recovery and cooldown state tables;
- HTTP-200/dead-control integration;
- queue/admission/fairness and never-resolving sink tests;
- real telemetry down/saturated proof while control ping, lease RPC, provider,
  SSH, and unrelated-zone work continue within bounded thresholds;
- repeated faults followed by a sustained no-recovery stable window.

## Slice 5: composed proof, review, Terra beta, and PR

Local proof must climb the pyramid honestly:

```text
unit          pnpm test:unit
integration   pnpm test:integration
host          pnpm test:e2e:host
inventory     pnpm test:e2e:inventory       (inventory only)
VM            mise exec -- pnpm test:e2e:vm
OpenClaw      mise exec -- pnpm test:e2e:openclaw
Worker        mise exec -- pnpm test:e2e:worker
quality       pnpm check
```

The permanent composed scenarios cover:

1. control loss and fresh reconnect without VM churn;
2. idle OpenClaw process recovery preserving healthy Tool VMs;
3. active-use process loss replacing only the affected leaf with no replay;
4. Tool VM death and SSH identity replacement preserving sibling/Gateway;
5. Gateway replacement removing old children before G2 readiness;
6. controller restart destroying known old PIDs before a fresh tree;
7. two-agent sibling isolation and control fairness;
8. telemetry unavailable/saturated without product impairment;
9. repeated faults followed by sustained no-flap stability.

After local proof, run implementation review and fix accepted findings. Freeze
one exact pushed head, then delegate a bounded Terra beta run with fresh marker,
package identity, before/after VM/PID/SSH ledger, Victoria/log/trace queries,
active SSH/file canaries, cleanup, and preservation of unrelated beta dirt.
No dependency patch or secret reference may enter beta artifacts.

Finish by verifying PR checks with blocking 20-second watches, review threads,
mergeability, and exact head. Leave the PR unmerged.

## Post-proof checkpoint: conditional gateway package split

Only after the reliability implementation is proven locally and by the
sustained Terra beta soak, audit the final dependency graph for Option B:

```text
gateway-contracts       pure lifecycle/spec vocabulary
gondolin-gateway-types  Gondolin-specific ManagedVm integration
```

Execute this split only if Gondolin-specific types leak into protocol, lease,
health, or portal surfaces, or another VM backend is concretely expected. Do
not split merely for package purity. If neither condition is present, record
the checkpoint as deferred/not applicable instead of forcing the split.

When triggered, treat it as a separate late mechanical task: preserve runtime
behavior, cut imports over completely, and prove package builds, typechecks,
and import-boundary checks. It must not block or invalidate the reliability
fix, exact-commit canonical proof, sustained beta soak, or PR readiness.

## Requirements/proof matrix

R1 stock Gondolin and controller authority
  owner: Slices 0-1
  evidence source: dependency inspection, source audit, lifecycle tests
  freshness guard: exact HEAD and installed package graph

R2 Gateway owns subtree
  owner: Slices 1 and 5
  evidence source: record state, child-before-parent real proof
  freshness guard: one run marker and pre/post G/child PIDs

R3 disposable control sessions
  owner: Slices 3 and 5
  evidence source: transition ledger and real reconnect
  freshness guard: S1 fenced before S2; unchanged G/P/leaf where required

R4 same-G process recovery
  owner: Slices 3 and 5
  evidence source: P1/P2 containment, unchanged G/safe leaf, real SSH
  freshness guard: exact P1 absence and one run marker

R5 leaf-only Tool/SSH repair
  owner: Slices 1-3 and 5
  evidence source: exact recorded PID absence, endpoint absence, fresh key,
  sibling canary
  freshness guard: pre/post leaf/VM/SSH identities in one run

R6 controller replacement
  owner: Slices 1 and 5
  evidence source: durable runtime records and C1/C2 identity ledger
  freshness guard: no C2 VM publication before recorded C1 PIDs are absent

R7 vector recovery and anti-flap
  owner: Slices 3-5
  evidence source: fake-clock budgets and sustained runtime window
  freshness guard: exact constants, marker, HEAD, and bounded window

R8 bounded control and telemetry
  owner: Slices 3-5
  evidence source: queue high-water/shed metrics plus concurrent product canaries
  freshness guard: baseline and fault windows from the same run

R9 no replay of unknown work
  owner: Slices 3 and 5
  evidence source: semantic ledger and unique remote side-effect marker
  freshness guard: run-scoped operation identity

R10 real product proof and PR readiness
  owner: Slice 5
  evidence source: no-skip runner JSON, implementation review, Terra, GitHub
  freshness guard: final exact pushed head after the last behavior change

## Execution DAG

```text
S0 remove patch/private API
  -> S1 controller lifecycle + stock-Gondolin sibling proof
       ├─ S2 strict SSH identity
       └─ S3 process/control/lease recovery correction
            -> integration gate
                 -> S4 health/telemetry
                      -> S5 composed proof
                           -> implementation review
                                -> fixes/reruns
                                     -> Terra beta
                                          -> PR readiness
                                               -> conditional package-boundary audit
```

S2 test work and S3 patch-independent recovery cleanup may run in parallel only
after S0 establishes the stock API boundary. Shared lifecycle and LeaseManager
files remain parent-integrated or serially handed off. Subagent output is
candidate work; the parent reviews diffs and reruns proof.

## Rollback and stop rules

- Do not reintroduce a dependency patch, local fork, republished package, or
  private API. Stop and discuss a missing stock capability.
- Do not preserve reservation/receipt abstractions merely to reduce diff size.
- Do not weaken or relabel proof to make stock behavior pass.
- A real stock-Gondolin sibling failure routes to a controller-owned design
  correction; it does not authorize patching Gondolin.
- Beta begins only after local stock-Gondolin proof and implementation review.
- Any behavior change after Terra invalidates Terra evidence.
- The conditional package split is post-proof and behavior-preserving; it does
  not reopen reliability design or require a split when its trigger is absent.
- Merge and release remain outside this goal.

## Plan completion receipt

phase_result: complete after one focused Fable advisor review is reduced and
accepted findings are folded into this plan.

evidence: corrected spec and plan; stock Gondolin source; Agent VM PID/runtime
records; controller-owned architecture audit; Fable advisor receipt.

recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan.

recommended_transition_reason: the accepted product stability model is mapped
to a stock-Gondolin controller-owned implementation with bounded proof and no
dependency patch.
