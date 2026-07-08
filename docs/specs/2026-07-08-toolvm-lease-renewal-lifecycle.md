# 2026-07-08 Tool VM Lease Renewal Lifecycle

## Purpose

Define the Tool VM lease renewal and retirement contract for managed OpenClaw
Tool VM access after the Socket.IO control-plane cutover.

This spec closes the `0.0.110` incident class where a Tool VM SSH/file-bridge
reset marked a lease stale, removed caller-context state, and a later OpenClaw
workspace action reused the old sandbox backend handle until
`lease_use_start` failed locally with `no registered caller context`.

The intended model is OAuth-style current-lease renewal and stale-lease
reacquisition:

- an old lease must not be accepted for new work after it is stale or retired;
- same-id `lease_renew` may only extend a lease that is still `current`;
- a stale handle may use controller-vetted stable provenance to acquire a
  replacement lease, but the old raw lease id is only cleanup/correlation;
- renewal must happen through the trusted controller path and preserve
  per-agent ownership checks;
- both sides must emit enough lifecycle signal for the opposite side to renew,
  deprecate, or retire state without guessing.

## Terminology

This spec intentionally separates two operations that the current code can blur:

- `lease_renew`: same raw lease id continuation for a lease that has not been
  classified stale, retired, generation-stale, force-released, releasing, or
  use-tombstoned.
- `lease_reacquire`: explicit replacement authority after stale or retired
  evidence. It may be triggered by an old handle, but it must mint a current
  replacement lease through controller-vetted stable provenance. The old lease
  id never becomes current again, and the controller must not return it.

`deprecated` is a plugin-local advisory state in this spec. It is useful for
telemetry, cleanup, and local handle bookkeeping, but it is not shared
controller authority unless a future spec explicitly adds a shared RPC state.

## Source Anchors

- Incident handoff in `shravan-claw`:
  `docs/wip/debugging/2026-07-08-sunfam-toolvm-lease-caller-context-409.md`
  at commit `1666ed47669f79c43486c9fe12e84dcbf68412da`.
- Socket.IO control-plane S4a lease RPC slice:
  `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`.
- Full Tool VM proof slice:
  `docs/specs/2026-07-02-socketio-control-plane/slices/16-tool-vm-and-mcp-full-path-proof.md`.
- Plugin lease stale path:
  `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`.
- Plugin gateway-control lease client:
  `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts`.
- Controller lease RPC ownership:
  `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts`.

## Incident Facts

The observed production-shaped failure in `@agent-vm/*@0.0.110`:

- `2026-07-07T23:26:13.888Z`: VictoriaTraces recorded
  `agent_vm.health.tool-vm-ssh` failed with `operation=file-bridge`,
  `elapsed_ms=5021`, `error.type=ssh-command-failed`,
  `agent_vm.lease.id_hash=a00bdf49a2da88f2`, and trace id
  `f17eb21c50809d3c0b9c4754d6f42b1b`.
- `2026-07-07T23:26:14.407Z`: VictoriaLogs recorded the matching failed
  Tool VM SSH health event for `service.version=0.0.110`.
- Local logs mapped that lease hash to raw lease
  `019f3c44-6478-71ec-8daf-b00040200cea`.
- The plugin marked that lease stale because
  `kex_exchange_identification: read: Connection reset by peer`.
- `2026-07-07T23:26:16.654Z`: a later OpenClaw workspace action attempted
  `lease_use_start` on the same raw lease and failed with
  `Gateway control lease_use_start returned HTTP 409 ... has no registered caller context`.
- OTEL showed `gateway-control-session` and `gateway-service-health` remained
  `ok`; this was not proven to be a Discord outage or gateway WebSocket outage.
- OTEL did not include rows for raw `lease_use_start`, raw lease id, or
  `no registered caller context`; local logs were required for the final hop.

## Spec Boundary / Separability Map

```text
OpenClaw tool/workspace caller
  owns: user intent to read/write/execute through a sandbox
  must not own: lease id validity, caller-context authority, raw SSH identity
  consumes: sandbox backend handle

        sandbox operation request
                 |
                 v

OpenClaw agent-vm plugin
  owns: per-agent cached handle registry, lease lifecycle view, renewal trigger
  exposes: Tool VM sandbox operations and gateway_control lease RPC client
  must not own: cross-agent authority decisions or final lease ownership truth

        gateway_control_rpc over private Socket.IO
                 |
                 v

Controller lease RPC
  owns: trusted caller-context registry, stable provenance ownership,
        lease create/renew/reacquire/use/release authority
  exposes: typed lease/use results and rejection reasons
  must not own: model-visible retry loops or raw Tool VM file transport

        controller-vetted lease snapshot
                 |
                 v

Tool VM SSH data plane
  owns: raw file/shell transport between gateway VM and Tool VM only
  emits: SSH failure signals that deprecate current lease use
```

The WebSocket control plane remains a control channel. Tool VM SSH remains the
only raw TCP data-plane exception.

## Lifecycle States

The lease lifecycle visible to the plugin and controller is:

```text
current
  usable for lease_use_start, heartbeat, end, renew, release, and SSH work.

deprecated
  plugin-local advisory state: known locally but no longer trusted for new
  work. Existing cleanup may finish. New active-use start must reacquire a
  current lease first.

stale
  failed liveness, SSH, caller-context, generation, or lease-manager validity.
  Never valid for new SSH work. May trigger reacquisition through stable
  controller-vetted provenance.

retired
  released, force-released, generation-stale, use-tombstoned, or cleanup-only.
  Never valid for new work. Release/end cleanup is idempotent and low-noise.
```

Allowed transitions:

```text
current -> lease_renew / soft signal -> current
current -> SSH/file-bridge failure -> stale
current -> controller absent/stale rejection -> stale
current -> lease_reacquire replacement accepted -> retired old + current new
current -> explicit release / runtime close -> retired
deprecated -> successful reacquire -> retired old + current new
deprecated -> cleanup finished / TTL expires -> retired
stale -> stable provenance reacquire succeeds -> retired old + current new
stale -> reacquire rejected by authority boundary -> retired + user-visible denial
retired -> any new active-use attempt -> reject, no SSH work
```

Forbidden transitions:

- `stale` to `current` for the same raw lease id;
- `retired` to `current`;
- any transition that changes stable ownership, controller-derived lease
  compatibility, current session attachment, or proof provenance without
  controller revalidation;
- any transition that performs SSH/file work before current lease authority is
  established.

## Renewal And Reacquisition Authority

Renewal is not permission to keep using the old lease after stale evidence.
The contract is:

1. if the lease is still `current`, `lease_renew` may touch the same raw lease
   id;
2. if stale or retired evidence exists, stop starting new work on the old raw
   lease id;
3. classify the old handle state as `deprecated`, `stale`, or `retired`;
4. use `lease_reacquire` with stable controller-vetted provenance and stale
   evidence to request a current replacement lease;
5. update the handle or replace it with a handle bound to the new current lease;
6. allow SSH/file/shell work only after `lease_use_start` succeeds on the
   current lease.

`lease_reacquire` is not plain `lease_create`. The current lease manager may
reuse a live compatible existing lease during normal create. Stale-led
reacquisition must instead retire or tombstone the old lease first when it is
owned by the same stable provenance, tolerate the old lease already being
absent or retired, reject owner/provenance mismatch, and return a replacement
lease whose raw `leaseId` differs from the old lease id.

## Controller Reacquire Authority

`lease_reacquire` must be authorized from controller-owned state. The plugin may
request replacement, but plugin-held request fields are evidence to verify, not
the authority source.

```text
reacquire input              source of authority             rule
---------------------------  ------------------------------  -------------------------------
oldLeaseId                   RPC payload                     lookup key only; not authority
callerContextId              current session registry         must resolve in current session
stable ownership             caller-context proof +           must match the old lease
                             controller old-lease authority   authority record
controller compatibility      controller resolver              re-run on every replacement
profile/host path/SSH         never from payload               reject if supplied
stale evidence kind/time      plugin observation               recorded, bounded, not authority
replacement lease id          controller lease manager         must differ from oldLeaseId
```

The controller owns an old-lease authority record for each Tool VM lease. That
record is created when the lease is created and contains:

- old `leaseId`;
- stable ownership provenance;
- controller-derived compatibility summary;
- same-gateway fence at the time authority was established;
- lifecycle state (`current`, `retiring`, `retired`, `replaced`);
- optional replacement lease id;
- expiry time for the tombstone/replacement record.

The authority record must survive ordinary release, force release, dead-VM
eviction, active-use tombstoning, and caller-context refresh for a bounded
cleanup window. The window must be long enough for stale returned handles and
cleanup calls to converge, and must be configurable or derived from the active
use/deprecated-handle TTLs. It must not be unbounded.

Reacquire behavior:

- if the old lease is live and its authority record matches the current stable
  ownership, the controller retires/tombstones it under the lease lock before
  returning replacement work authority;
- if the old lease is already retired but the authority record exists and
  matches, the controller may return the recorded replacement lease or mint a
  new replacement;
- if the old lease is absent and no authority record exists, the controller
  returns `lease_authority_absent`; it must not trust plugin-held provenance to
  bridge the gap;
- if a concurrent reacquire already created a replacement for the same old
  lease and same stable owner, later reacquire calls may return that replacement
  only after their caller context independently validates;
- if stable ownership, same-gateway fence, or controller-derived compatibility
  does not match, the controller returns `ownership_denied` or the specific
  mismatch rejection and does not refresh authority.

Stable ownership provenance is:

- `zoneId`
- `agentId`
- `agentWorkspaceDir`
- `workMountDir`
- `sessionKeyDigest`
- `purpose`

Controller-derived lease compatibility is:

- `profileId`
- `hostWorkMountDir`
- `guestWorkdir`
- `zoneGitMount`
- effective idle TTL policy

The plugin may hold cached copies of some compatibility inputs, but the
controller must re-run the configured lease-create resolver during
reacquisition. The replacement path must not trust plugin-supplied `profileId`,
host paths, or stale cached lease snapshots as authority.

Current session attachment is:

- `peerId`
- `bootId`
- `controllerEpoch`
- `sessionId`
- `connectionId`

Raw `callerContextId`, `sessionId`, and `connectionId` are refreshable
attachment credentials. They are not the stable ownership source of truth.
Controller enforcement still binds each operation to the current session and
must reject stale attachment credentials.

Replacing a stale handle must atomically tombstone the old handle's active-use
state, SSH identity material, caller-context mapping, and cached lease entry
before the replacement handle can run new work. Two stale handles for the same
agent/workspace must not inherit each other's replacement authority without
their own controller-vetted path.

## Plugin Handle Reacquisition Contract

The incident involved an already-returned `OpenClawSandboxBackendHandle`, so
refreshing only the factory cache is insufficient. Every lease-bound operation
on an existing handle must pass through a current lease binding gate before it
can access raw `leaseId` or SSH material.

The plugin-side handle contract is:

- a returned handle stores stable request provenance separately from the
  current lease binding;
- active-use start, file bridge, shell command, exec build, heartbeat, and
  finalize paths read the current lease binding through the gate, not from a
  permanently captured `leaseId`/`ssh` closure;
- if the binding is `current`, work may proceed with that lease;
- if the binding is `deprecated`, `stale`, `retired`, or missing
  caller-context state, the gate must either complete `lease_reacquire` and
  atomically swap to a replacement binding or reject with a typed lifecycle
  error before SSH material is reachable;
- after swap, subsequent operations on the same handle use the replacement
  lease id and SSH material;
- if swap fails because ownership/provenance is denied, the handle becomes
  terminal for new work and returns the typed denial;
- factory cache deletion alone does not satisfy reacquisition for an
  already-returned handle.

Proof must keep the same handle object alive after stale evidence and assert
the next operation does not call `lease_use_start`, `heartbeat`, SSH, or file
bridge with the old raw lease id or old SSH identity.

## Signals And Timers

The system must provide explicit renewal/retirement signals instead of relying
on opaque local map misses.

Controller-to-plugin signals:

- `lease_use_start`, `lease_renew`, `lease_peek`, `lease_use_heartbeat`,
  `lease_reacquire`, and `lease_release` failures must use typed lease
  rejection reasons.
- `lease_reacquire` must be a typed gateway-control RPC command/result with a
  discriminated payload that includes the old lease id, stale evidence kind,
  observed time, caller context, and optional idle TTL hint. It must not accept
  `agentId`, `profileId`, host path, or SSH identity fields from the payload.
- The typed rejection taxonomy is a discriminated union with these meanings:
  - `lease_absent`: no lease exists for the requested old/current id;
  - `lease_retired`: the lease is known but terminal for new work;
  - `lease_releasing`: release is in progress;
  - `lease_generation_stale`: VM/controller generation is stale;
  - `lease_force_released`: the controller force-released the lease;
  - `lease_use_tombstoned`: the active use is already tombstoned;
  - `caller_context_absent`: caller context id is not registered;
  - `caller_context_stale`: caller context is registered but superseded;
  - `caller_context_session_mismatch`: caller context does not match the
    current peer/boot/epoch/session/connection attachment;
  - `lease_reacquire_required`: operation requires replacement before work;
  - `lease_authority_absent`: old-lease authority record is unavailable;
  - `ownership_denied`: stable ownership or proof does not match;
  - `runtime_not_ready`: gateway runtime status is not fresh/ok.
- Missing or stale caller-context state for a lease operation must be
  distinguishable from a cross-agent or forged caller-context attempt.
- Cleanup release for an already-retired lease must be idempotent or produce a
  low-severity cleanup signal, not a user-visible operation failure.

Canonical rejection/action matrix:

```text
condition                         result      rejection reason                  plugin action
--------------------------------  ----------  --------------------------------  -------------------------------
current caller context missing    rejected    caller_context_absent             register fresh context, retry only
                                                                                before SSH work starts
caller context superseded         rejected    caller_context_stale              register fresh context in same
                                                                                gateway fence
session attachment mismatch       rejected    caller_context_session_mismatch   refresh only if same-gateway fence
old/current lease not found       rejected    lease_absent                      reacquire if old authority exists;
                                                                                otherwise retire handle
old authority tombstone missing   rejected    lease_authority_absent            retire handle; no plugin-trust
lease known terminal              rejected    lease_retired                     reacquire or cleanup-only
release in progress               rejected    lease_releasing                   cleanup-low-noise/backoff
VM/controller generation stale     rejected    lease_generation_stale            reacquire through current session
force release observed             rejected    lease_force_released              reacquire or retire
active-use tombstone hit           rejected    lease_use_tombstoned              idempotent cleanup
operation needs replacement        rejected    lease_reacquire_required          call lease_reacquire before work
stable owner/proof mismatch        rejected    ownership_denied                 fail closed, user-visible denial
runtime status not fresh/ok        rejected    runtime_not_ready                 bounded retry/backoff, no old work
unexpected controller failure      failed      optional typed reason             no replay after possible SSH work
```

Plugin-to-controller signals:

- Tool VM SSH probe/file-bridge failures must publish Tool VM SSH health events
  with operation, result, elapsed time, safe error type, hashed lease id, and
  correlation fields when available.
- A plugin-side stale-handle detection must emit a structured renewal/retire
  event or span before reacquisition or final failure.
- A plugin-side caller-context map miss for a known stale/retired lease must be
  observable as `lease_use_start` lifecycle evidence, not only as a local error
  string.

Observability contract changes are required in:

- `packages/gateway-interface/src/health/agent-vm-health.ts`
- `packages/gateway-control-contracts/src/index.ts`
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
- `packages/agent-vm/src/observability/health-event-telemetry.ts`

Minimum lifecycle evidence fields:

- lifecycle operation;
- lifecycle state or transition;
- caller-context state;
- typed rejection class;
- hashed old lease id;
- hashed replacement lease id when one exists;
- hashed active-use id when one exists;
- correlation fields from the control envelope or caller context when
  available.

Observability ownership:

```text
emitter       event role                         authority
------------  ---------------------------------  -------------------------------
plugin        stale observation                  non-authoritative observation;
              caller-context local miss          proves what the handle saw

controller    reacquire accepted/denied          authoritative lifecycle decision;
              old lease retired/tombstoned       owns final state transition

telemetry     health/log/span projection         exports safe hashes, correlation,
                                                 transition id, and result class
```

One stale-to-reacquire flow may emit several observations, but it must emit one
authoritative final lifecycle decision with a stable transition id so operators
can deduplicate plugin observations from controller decisions.

Timer expectations:

- Active-use heartbeat cadence and stale TTL remain separate from lease
  renewal/reacquisition.
- A handle may enter `deprecated` before heartbeat stale TTL when a strong
  signal exists, such as SSH reset or controller `410`.
- Deprecated handles must have a bounded cleanup lifetime so old handles do not
  hold unbounded caller-context or lease state.
- The default deprecated-handle and old-lease authority cleanup lifetime is the
  Tool VM ended-use tombstone TTL, and it must not be shorter than the
  heartbeat-stale window. The value may be made configurable through the
  Tool VM use/lease policy surface, but tests must use injected time.
- Retry/renew timers must be bounded and jittered when a shared failure can
  affect multiple zones or agents.

## Field Stability Table

```text
field group                    examples                           rule
-----------------------------  ---------------------------------  -------------------------------
stable ownership provenance    zoneId, agentId, agentWorkspaceDir, controller revalidates;
                               workMountDir, sessionKeyDigest,    mismatch fails closed
                               purpose

controller-derived             profileId, hostWorkMountDir,       controller re-resolves;
compatibility                  guestWorkdir, zoneGitMount, TTL     plugin payload is not authority

same-gateway fence             peerId, bootId, controllerEpoch     drift means old lease authority
                                                                   cannot continue silently

refreshable attachment         callerContextId, sessionId,         may refresh by re-registering
credentials                    connectionId                       caller context for the same
                                                                   accepted session/gateway fence

local identifiers/material     raw leaseId, useId, identityPem,    memory-only custody unless a
                               proof keys                         contract explicitly permits a
                                                                   private control message
```

On reconnect, refreshed `callerContextId`, `sessionId`, or `connectionId` may
restore reachability only when the stable ownership provenance and same-gateway
fence still match. Changes to `peerId`, `bootId`, or `controllerEpoch` fence off
old lease authority unless a controller-vetted recreate/recovery path explicitly
accepts a new lease generation.

## Replay Boundary

The system may transparently reacquire and retry only before Tool VM SSH work
has started, such as a `lease_use_start` rejection caused by stale local
caller-context state. Once an SSH command, file bridge, or exec operation may
have partially run, the old handle must mark the lease stale and the next
caller operation may reacquire, but the failed operation must not be replayed
unless that operation explicitly declares itself retry-safe.

## Tombstone Choreography

The stale-to-replacement path is atomic as an invariant, not necessarily as one
process-wide transaction. Each owner must make its own tombstone step
idempotent, and replacement work may begin only after the required old state is
terminal.

```text
state item                    owner        trigger                    before replacement work
----------------------------  -----------  -------------------------  -------------------------------
handle lease binding          plugin       stale evidence or          mark deprecated/stale before any
                                           typed controller reject    new active-use start

old SSH material              plugin       binding deprecated/stale    unreachable from operation gate
                                                                       before reacquire returns

callerContextByLeaseId        plugin       old lease deprecated/       remove old mapping before swap;
                                           retired or release          missing cleanup is idempotent

agent lease cache             plugin       stale evidence              delete old cache entry before
                                                                       requesting replacement

old active-use handle         plugin       operation failure/finalize  dispose or tombstone before the
                                                                       same handle can start new work

lease authority record         controller   lease create/release/       record current->retired/replaced
                                           reacquire                  under controller lock

lease manager active use       controller   active-use end/stale/       tombstone ended/expired uses so
                                           force retire               heartbeat/end cleanup is idempotent

old VM/runtime/tcp slot        controller   reacquire/release/evict    close or quarantine old runtime
                                                                       before old id can be reused

replacement lease binding      plugin +     reacquire accepted         swap after old local state is
                              controller                               tombstoned and controller returns
                                                                       new lease id
```

Failure rollback rule: if any local tombstone step succeeds but controller
reacquire fails, the old handle remains terminal for new work. It may retry
reacquire with bounded backoff while the old authority record exists, but it
must not restore old SSH material or old active-use authority.

## Requirements

R1. Old stale lease ids are never used for new Tool VM SSH work.

R2. Existing/pending sandbox handles that observe stale lease evidence must
trigger reacquisition or retire themselves before the next active-use
start.

R3. A plugin-side missing caller-context mapping for a known old lease must not
surface as a hard user-visible `409 no registered caller context` when the safe
action is renewal or idempotent cleanup.

R4. Controller lease RPC must continue to reject cross-agent, wrong-workspace,
wrong-work-mount, mismatched session-key, stale generation, and invalid-proof
attempts.

R5. The controller must not accept the old stale lease for new work merely
because the plugin can present a refreshed caller context.

R6. Cleanup release/end operations for already-retired or already-forgotten
leases must be idempotent or low-noise.

R7. OTEL/log evidence must include the final `lease_use_start` lifecycle
failure or renewal decision with operation, hashed lease id, caller-context
state, safe rejection class, and correlation fields where available.

R8. Health summaries must keep layer statuses separate: Tool VM SSH stale must
not be summarized as gateway WebSocket or Discord instability when
`gateway-control-session` and `gateway-service-health` are `ok`.

R9. Manual docs must teach the renewal model, the no-old-lease-work rule, and
the diagnostic split between Tool VM SSH, lease/use RPC, gateway control
session, and gateway service health.

R10. Release proof must include a fresh package version, package version sync,
packed `@agent-vm/agent-vm` inspection, publish through the repo release
helper when release preconditions are satisfied, `npm view` verification for
every publishable `@agent-vm/*` package, and published tarball inspection.

R11. Same-id `lease_renew` is valid only while a lease is still `current`; stale
or retired evidence requires replacement lease reacquisition.

R12. Reacquisition must split stable ownership provenance from current session
attachment and must fail closed when either the stable ownership or current
attachment does not match.

R13. Old handle retirement must tombstone old active-use state, SSH material,
caller-context mapping, and cache state before replacement work can begin.

R14. Concurrent stale handles cannot share or inherit replacement authority
without each handle passing its own controller-vetted path.

R15. Typed rejections must preserve operator meaning instead of collapsing
caller-context absence, stale attachment, retired lease, and ownership denial
into a single broad `absent` result.

R16. Stale-led reacquisition uses an explicit `lease_reacquire` control
operation. Plain `lease_create` must not satisfy this requirement because
normal create may reuse a live compatible old lease.

R17. Successful `lease_reacquire` must return a replacement lease with a raw
`leaseId` different from the old lease id, after retiring or tombstoning the old
lease when it still exists under the same stable ownership.

R18. Automatic replay is allowed only before SSH/file/exec work starts. A
mid-operation SSH failure marks the lease stale and permits later reacquisition,
but does not replay the failed operation unless the operation declares itself
retry-safe.

R19. `lease_reacquire` authority must come from a controller-owned old-lease
authority/tombstone record plus a current caller context. If that authority
record is unavailable, the controller rejects with `lease_authority_absent`
instead of trusting plugin-held request fields.

R20. Lifecycle observability must separate plugin observations from the
controller's authoritative final decision and include a stable transition id for
dedupe.

## Threat Model

Assets:

- per-agent Tool VM lease authority;
- caller-context proof and agent authority keys;
- Tool VM SSH identity material;
- workspace file contents;
- OTEL/log evidence that may contain sensitive operational identifiers.

Trusted boundaries:

- controller-owned config and caller-context registry;
- controller-issued private control-session identity;
- plugin code path holding controller-generated HMAC proof keys inside the
  managed gateway VM.

Untrusted or less-trusted inputs:

- model/tool-shaped payloads;
- stale plugin-local caches;
- OpenClaw workspace requests;
- raw lease ids held by old handles;
- raw SSH failure strings.

Security requirements:

- Renewal must never let a caller select a foreign `agentId` or work mount.
- A stale raw lease id is not authority.
- Re-registering caller context must be bound to stable provenance and proof,
  not to request body claims.
- Old handles must not bypass the controller by retaining private SSH identity
  material after the lease is stale or retired.
- Raw lease ids should remain local/debug-only; exported telemetry uses safe
  hashed ids and correlation fields.
- `identityPem`, proof keys, raw lease ids, and raw active-use ids may exist
  only in explicitly private controller/plugin memory or private control
  messages whose contract requires them. Exported telemetry, external logs,
  manuals, config, runtime records, package tarballs, and public schemas must
  omit them or use safe hashes.
- Per-agent HMAC and caller-context proof keys defend against model/tool-shaped
  minting and stale guest-visible config. They do not defend against a fully
  compromised plugin process that already has access to proof keys, so the
  controller must remain the source of authority and must re-check ownership and
  attachment on every operation.

## Proof Expectations

Unit proof:

- stale-handle active-use start cannot produce hard local 409;
- old raw lease is not used after stale evidence;
- the same returned handle object consults the current binding gate before
  every active-use/SSH/file/exec operation;
- same-id `lease_renew` only succeeds for current leases;
- stale and retired leases require replacement reacquisition;
- plain `lease_create` reuse cannot satisfy stale-handle replacement;
- successful `lease_reacquire` returns `newLeaseId !== oldLeaseId`;
- stale old-lease authority missing returns `lease_authority_absent` and does
  not trust plugin request fields;
- old handle tombstones SSH material, active-use state, caller-context mapping,
  and cache state before replacement work;
- concurrent stale handles cannot share replacement authority;
- idempotent release/end cleanup for missing caller context;
- cross-agent and wrong-provenance attempts still reject;
- typed rejection classes distinguish caller-context absence, stale attachment,
  retired/absent lease, renewal-required state, and ownership denial;
- automatic replay is blocked after potentially partial SSH/file/exec work;
- exported telemetry/log/schema/package proof excludes raw ids, `identityPem`,
  proof keys, and forbidden credential substrings outside explicitly private
  control messages;
- lifecycle states and transitions are discriminated unions, not stringly side
  channels or broad `any`/`unknown`.

Integration proof:

- plugin lease client plus fake gateway-control RPC exercises absent/stale
  caller-context recovery;
- controller lease RPC rejects old lease new work after retirement while
  allowing reacquisition through valid stable provenance;
- controller lease RPC does not let stale-led replacement fall through to
  normal create reuse of the old lease;
- reacquire authorization is backed by controller-owned authority/tombstone
  state and rejects missing authority separately from missing caller context;
- OTEL/log event builder emits safe lifecycle evidence for renewal/final denial.
- health event and telemetry mapping carry lifecycle operation, transition,
  caller-context state, typed rejection, lease hashes, use hash, and
  correlation fields.

OpenClaw/VM proof:

- a no-skip real OpenClaw/VM proof must boot the real controller, gateway VM,
  control-plane RPC, Tool VM lease, and Tool VM SSH/file or shell path;
- harnessed plugin/controller integration can prove lower layers, but it is
  not final OpenClaw/VM proof for this incident class unless it boots the real
  controller/gateway/Tool VM path;
- the real path triggers SSH/file-bridge stale evidence, then a later workspace
  action renews/reacquires before work or returns a typed recoverable/denial
  result;
- no fallback to old direct controller HTTP lease routes;
- gateway-to-Tool-VM remains the only raw SSH leg.

Beta proof:

- local package tarballs are synced into the beta deployment and the installed
  package source is verified before runtime proof;
- beta validation/build/start proves the control plane, Tool VM lease path,
  and at least one real file/read or shell operation through the Tool VM;
- if beta cannot run, the blocker is recorded separately from unit/integration
  pass status.

Pre-merge package readiness proof:

- quality gates pass on current source;
- package versions are bumped in sync to a fresh unpublished version;
- local packed `@agent-vm/agent-vm` has sibling `@agent-vm/*` dependencies
  pinned to the intended version and `managed-images.json` has no npm package
  pins.

Post-merge publish proof:

- publish happens only after the release PR is merged when merge is authorized
  and local `master` is fast-forwarded to `origin/master`;
- publish uses the repo's 1Password-backed local publish helper from that
  release source after release preconditions are satisfied;
- `npm view` proves every publishable package version;
- the published `@agent-vm/agent-vm` tarball is inspected before release is
  called complete.

Docs/manual proof:

- canonical docs describe current-lease renewal, stale-lease reacquisition,
  old-lease retirement, typed rejections, and observability fields;
- generated manuals in `packages/agent-vm/src/cli/manual-templates.ts` include
  concise operator guidance;
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts` covers the manual
  text;
- a built-CLI `agent-vm manual update` smoke check runs when generated output
  changes.

## Non-Goals

- Do not keep using stale old leases for work.
- Do not weaken per-agent HMAC or caller-context ownership.
- Do not add broad backwards-compatible direct controller lease HTTP paths.
- Do not move Tool VM file data over the control WebSocket.
- Do not disable observability or collapse Tool VM stale into gateway outage.
- Do not edit deployment repositories as part of the product fix, except for
  reading incident evidence or later explicit beta validation.
- Do not publish before the implementation is merged through the authorized
  release flow and the publish source has been re-verified.

## Planning Inputs

Plan creation must turn this spec into a requirements/proof matrix that
includes at least:

- lifecycle state model and transition tests;
- plugin stale-handle renewal behavior;
- existing returned-handle binding gate and swap behavior;
- controller lease RPC stale/retired denial behavior;
- stable provenance versus current session attachment;
- `lease_reacquire` wire/result contract and no old-lease reuse guarantee;
- typed rejection taxonomy;
- atomic tombstone and concurrent stale-handle behavior;
- cleanup idempotency;
- observability event/span shape;
- docs/manual updates;
- OpenClaw/VM proof or explicit blocker;
- pre-merge package readiness: version sync, package bump, local pack
  inspection;
- post-merge publish proof gated by explicit merge/release authorization,
  fast-forwarded `master`, publish helper, npm verification, and published
  tarball inspection.

phase_result: complete
evidence: docs/specs/2026-07-08-toolvm-lease-renewal-lifecycle.md
recommended_next_workflow: shravan-dev-workflow:plan-creation-swarm
recommended_transition_reason: The reviewed spec defines the renewal lifecycle contract and is ready for implementation planning.
