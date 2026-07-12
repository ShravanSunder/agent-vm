# Control Plane and Tool VM Runtime Reliability

Date: 2026-07-09

Status: corrective design; controller-owned lifecycle; stock Gondolin

Goal id: `2026-07-09-control-lease-reliability`

## Product promise

Agent VM keeps a long-running OpenClaw Gateway useful while agents are working.
It distinguishes control, OpenClaw process, Tool VM, SSH, provider, and
telemetry health so one failing plane does not flap healthy planes.

The system must:

- reconnect a failed control session without replacing healthy VMs;
- restart OpenClaw inside the same Gateway when safely possible;
- replace one unhealthy Tool VM without replacing its Gateway or siblings;
- replace the complete Tool VM subtree when the Gateway VM dies;
- destroy recorded old VMs and start a fresh tree after controller restart;
- keep lease renewal and recovery bounded, stable, and anti-flapping;
- keep telemetry bounded and unable to delay control, lease, provider, or SSH
  work.

The direct data path remains:

```text
OpenClaw in Gateway VM
  -> SSH over Gondolin tcpHosts
  -> Tool VM
```

Socket.IO carries bounded control and small state transitions only. The
controller never proxies SSH, command output, files, provider traffic, logs,
traces, metrics, or OTLP payloads.

## Lifetime and ownership model

```text
Controller epoch C
  └─ Gateway VM epoch G
       ├─ recoverable OpenClaw process epochs P*
       │    └─ disposable control-session epochs S*
       ├─ agent A lease leaf LA -> Tool VM TA -> SSH binding
       └─ agent B lease leaf LB -> Tool VM TB -> SSH binding
```

The controller is the sole durable authority for VM membership, lease
generations, runtime records, PID/process identity, SSH identity, health,
fencing, recovery, and slot reuse.

Stock Gondolin is a mechanical live-VM provider. Agent VM uses only its public
API to create a VM, obtain its host PID, execute inside it, expose ingress/SSH,
and close its live handles. Agent VM does not patch, fork, republish, or depend
on private Gondolin lifecycle APIs.

A Tool VM belongs to one exact Gateway VM epoch. Tool VM, lease, SSH, or
authority state never transfers across Gateway epochs. OpenClaw process and
control-session replacement inside a live Gateway may preserve healthy Tool VM
leaves after fresh controller validation.

## Boundary map

```text
Controller composition root
  ├─ OpenClawZoneRuntime
  │    owns: Gateway epoch, process recovery, subtree replacement
  ├─ Gateway control owner
  │    owns: current process/session attachment, queues, semantic results
  ├─ LeaseManager
  │    owns: lease leaf, Tool VM, SSH binding, active use, replacement
  ├─ Runtime record store
  │    owns: durable Gateway/Tool PID and process identity cleanup evidence
  ├─ Health/recovery reducer
  │    owns: typed repair selection and anti-flap budgets
  └─ gondolin-adapter
       exposes: stock live-VM create, PID, exec, ingress, SSH, close

Gateway VM
  ├─ recoverable OpenClaw process
  ├─ private bounded control service
  └─ direct SSH client ---------------------------------> Tool VM
```

Evidence sinks consume bounded one-way transitions. They never own health,
lease authority, or recovery decisions.

## Controller-owned VM lifecycle

### Create

Before creating a Gateway VM, the controller allocates a Gateway epoch seed
that does not depend on a Gondolin VM id and records a bounded provisioning
intent. Stock Gondolin assigns `vm.id` when the unstarted handle is constructed;
the controller attaches that id to form the full Gateway epoch identity before
starting or publishing the VM. Tool provisioning intents are parented to that
full identity. After stock Gondolin starts a VM, the controller immediately
captures:

- Gondolin VM id and host PID;
- process start identity and command;
- zone, Gateway epoch, agent/lease, and Tool slot as applicable;
- current SSH host identity after SSH readiness.

The controller persists the runtime record before publishing the Gateway or
lease as current. A late create completion cannot commit into a fenced Gateway
or leaf generation; it proceeds to cleanup.

### Destroy one Tool VM

Leaf destruction is controller-ordered:

```text
fence lease and active use
  -> close controller/Gateway SSH authority
  -> revalidate and terminate the recorded Tool VM PID
  -> observe runner absence
  -> call stock VM.close() for remaining live handles
  -> verify the Tool SSH/listener slot is unavailable
  -> delete the runtime record and release the slot
```

Terminating the selected runner before `VM.close()` prevents stock Gondolin's
resistant-child fallback from killing sibling VMs. The controller calls
`VM.close()` only after both OS process absence and Gondolin's cleared runner
reference are observed; otherwise it quarantines the slot and fails closed.
A real test must prove the successful path with active SSH and two Tool VMs,
and a deterministic failure test must prove `VM.close()` is not called while
the runner remains attached.

Destruction proof is product-scoped: the exact recorded runner is absent,
lease authority is fenced, the relevant endpoint/slot is unavailable, and no
sibling changed identity. Agent VM does not require a resource-by-resource
receipt for Gondolin-internal listeners, sockets, IPC, QMP, or storage.

### Replace the Gateway tree

Gateway replacement synchronously fences Gateway admission, control work, and
every child lease. It then destroys Tool VM leaves, destroys the Gateway, and
starts a successor only after recorded predecessor runners and reusable
endpoints are absent.

### Controller restart

Controller restart adopts no VM. It loads prior Gateway and Tool runtime
records, refuses identity mismatches, terminates verified Tool runners before
their parent Gateway runner, and creates a fresh tree.

Stock Gondolin's process-exit child cleanup covers ordinary controller exit.
Agent VM runtime records cover surviving known PIDs after hard termination. A
hard `SIGKILL` precisely between child spawn and PID persistence may leave an
unknown orphan; this narrow trusted-host risk is accepted initially and must be
observable. PID, process start text, and command revalidation is a practical
fail-closed identity defense, not an atomic OS process handle; the residual
same-identity reuse race on the trusted host is also accepted initially. These
risks do not justify a dependency fork or a second ownership protocol.

## Lease and SSH contract

`LeaseManager` is the sole mutable owner of a lease leaf. Durable authority is
bound to Gateway epoch, stable principal (`zoneId + agentId`), leaf generation,
compatibility, purpose, and expiry. It never depends on Socket.IO connection or
session identity.

One Tool VM lifetime has one SSH server identity. Agent VM ensures the Tool
image does not contain a reusable baked host key, reads the live VM's Ed25519
host public key through the exact live VM execution path, and supplies strict
`known_hosts` material to the Gateway. Stock Gondolin's convenience SSH command
with disabled host-key checking is not used for agent work.

A transient pre-ambiguity SSH failure receives bounded probes. Persistent
runtime, server-identity, credential, or active-use uncertainty fences and
replaces only that leaf. Old SSH authority must fail after replacement.

## Runtime recovery state model

```text
HEALTHY
  ├─ control transport failure
  │    -> fresh bounded reconnect; preserve G, P, and healthy leaves
  ├─ OpenClaw process failure
  │    -> contain old P; start selected P2 in same G; preserve safe leaves
  ├─ one Tool VM or SSH failure
  │    -> fence and replace one leaf; preserve G and siblings
  ├─ Gateway failure
  │    -> fence all children; replace complete subtree
  └─ controller restart
       -> terminate recorded old tree; start a fresh tree
```

Session loss alone creates a bounded active-use observation gap. Same-process
reconnect may resume or report a matching use within the grace window. Process
loss, expired grace, or uncertain remote side effects makes the affected use
ambiguous; the leaf is fenced and replaced. Unknown side effects are never
replayed automatically.

## Control-session contract

- The controller initiates the private Socket.IO connection after Gateway and
  plugin readiness.
- Every accepted session starts fresh directional sequence and receipt state.
- Sequence gaps, receipt failure, queue overflow, or disconnect fence one
  session and enter bounded reconnect; there is no terminal stale sink.
- A Gateway-scoped monotonic attachment generation fences older sessions and
  survives OpenClaw process replacement.
- Semantic retries bind stable principal, target generation, operation kind,
  idempotency identity, and canonical payload digest.
- Changed meaning is a typed collision. Unknown or expired side effects are not
  replayed.

One socket has bounded traffic classes:

```text
Class 0  safety and authority; reserved capacity; receipted
Class 1  liveness and lease renewal; latest-wins/coalescible
Class 2  diagnostic transitions; bounded/droppable
Class 3  local telemetry only; never raw control traffic
```

Telemetry, heartbeats, or one busy agent cannot consume the safety reserve or
starve sibling authority work.

## Health vector and anti-flap policy

The controller keeps independent planes for Gateway VM, Gateway service,
OpenClaw process, control session, lease authority, Tool VM, SSH, active use,
provider, and telemetry. A green observation in one plane cannot clear another
plane's failure budget. In particular, `/health 200` cannot veto exhausted
control or process recovery.

Each repair is generation-fenced, single-flight, deadline-bounded, and stable
for a configured success window before cooldown begins. Repeated failure
escalates outward rather than restarting the same layer forever. One missed
probe never replaces a VM.

## Observability contract

Explicit bounded transitions cover control connect/disconnect/reconnect,
process recovery, leaf replacement, Gateway replacement, recovery refusal,
queue shedding, and exporter failure. Routine successful heartbeats aggregate
instead of generating one durable event each.

Evidence queues, JSONL writes, and OTLP export have fixed record/byte limits,
timeouts, drop/coalescing accounting, and shutdown deadlines. Evidence
callbacks cannot reenter owner mutation. Collector loss or saturation affects
observability status only and cannot delay product paths or trigger recovery.

Metrics use bounded reason/state labels. Session ids, lease ids, paths, command
text, payload digests, SSH material, tokens, and raw errors are never metric
labels.

## Security context

The controller host is trusted. The Gateway VM is semi-trusted and may hold
current same-epoch capabilities. Tool VMs run untrusted work. A compromised
Gateway root is outside this isolation promise; Gateway replacement is the
security reset.

Every mutation validates current Gateway/process/session fences as applicable,
stable principal, leaf generation, target, purpose, expiry, and semantic
meaning. Network reachability, a valid socket, an old lease id, or OpenClaw
process identity alone is never durable authority.

## Requirements

R1. The controller is the sole durable lifecycle and lease authority; stock
Gondolin remains an unpatched mechanical provider.

R2. A Gateway epoch owns every Tool VM leaf. Gateway replacement waits for old
recorded runners and endpoints to be absent before publishing a successor.

R3. Control sessions are disposable and recover through bounded fresh-session
reconnect without destroying healthy VMs.

R4. OpenClaw process recovery preserves healthy idle Tool VMs inside the same
Gateway and fences ambiguous active uses.

R5. Tool VM/runtime/SSH failure replaces one complete leaf, preserves siblings,
and establishes a fresh strictly pinned SSH identity.

R6. Controller restart destroys verified old Tool runners and Gateway runners,
then starts a fresh tree; it never adopts live VM authority.

R7. Recovery is vector-based, single-flight, stability-gated, and anti-flapping.

R8. Control admission, semantic retries, and telemetry are bounded; evidence
cannot impair control, provider, lease, SSH, or unrelated-zone progress.

R9. Unknown remote side effects are fenced and never replayed automatically.

R10. Product behavior is proven with real stock-Gondolin VMs, active SSH,
control/process faults, sibling preservation, Gateway replacement, controller
restart, telemetry pressure, and sustained no-flap operation.

## Non-goals

- dependency patches, generated dependency forks, private Gondolin APIs, or a
  republished Gondolin build;
- resource-by-resource destruction receipts for Gondolin internals;
- zero-risk recovery from hard kill during the spawn-to-PID-record micro-window;
- Tool VM or authority migration across Gateway epochs;
- controller-restart adoption, multi-controller HA, or rolling Gateway handoff;
- exactly-once arbitrary remote shell execution;
- independent SSH credential rotation within one Tool VM lifetime;
- lossless telemetry during indefinite collector outage;
- generic command, file, SSH, provider, or telemetry tunneling over control;
- Discord/provider internal redesign.

## Proof expectations

The implementation plan must provide:

- unit proof for lifecycle, fencing, retry, recovery, and anti-flap reducers;
- integration proof for fresh control reconnect, lease ownership, active-use
  ambiguity, bounded queues, and telemetry isolation;
- host proof that the installed dependency graph contains no Gondolin patch;
- real VM proof that controller termination of one active Tool VM followed by
  stock `VM.close()` preserves its Gateway and sibling Tool VM;
- real SSH proof for unique server identity, strict pinning, replacement, and
  denial of the old identity;
- real OpenClaw proof for idle and active-use process recovery;
- Gateway and controller replacement proof using durable PID/runtime records;
- repeated fault cycles followed by a sustained stable window;
- beta proof through Terra only after local proof and review are green;
- final implementation review and ready-but-unmerged PR verification.

## Revisit triggers

Reconsider the boundary only if production evidence shows repeated unknown
orphan VMs, stock close cannot preserve siblings after controller pre-termination,
controller restart churn becomes unacceptable, or a compliance requirement
demands audited internal-resource destruction. Any future dependency patch or
fork requires a separate explicit user-approved architecture decision; it is
never an implementation detail.
