# Post-OpenClaw Removal Follow-Ups

## Boundary

The `remove-openclaw` branch owns one outcome: remove OpenClaw completely while
retaining Hermes, Worker, and framework-neutral Agent VM behavior.

This branch must not change Hermes cache, reconnect, retry, reacquisition, or
binding-publication behavior. OpenClaw configuration, runtime code, packages,
plugins, images, commands, tests, and supported documentation are removed rather
than preserved behind compatibility paths.

## Decisions

### Keep the removal branch focused

- Decision: the OpenClaw-removal branch contains no unrelated Hermes runtime
  repair.
- Why: the repository owner wants a clean OpenClaw cutover and another agent
  will handle the Hermes reconnect defect separately.
- Rejected alternative: finish the Hermes recovery change in this branch. That
  mixes an independent runtime behavior change with the deletion and makes the
  cutover harder to attribute and verify.
- Consequence: remove the uncommitted U10 recovery expansion and Python cache
  repair from this branch before final cutover verification.
- Status: accepted.

### Retained-behavior proof remains cutover work

- Decision: proof-only ports that demonstrate retained Hermes/common-runtime
  behavior remain part of the OpenClaw cutover.
- Why: deleting OpenClaw-specific E2E files must not silently delete the only
  observation of framework-neutral behavior.
- Consequence: generic VM or Hermes tests may be added or corrected, but they
  must not change runtime behavior merely to make a proof pass.
- Status: accepted.

## Deferred Item 1 — Hermes first-call recovery after control reattachment

Owner: separate agent/worktree assigned by the repository owner.

### Symptom

After the Hermes Gateway control connection is interrupted beyond its reconnect
budget and then reattached, the first Hermes terminal or filesystem operation
can fail with `Gateway runtime method dispatch failed`.

This is not an OpenClaw path. The affected path is:

```text
Hermes managed environment
  -> Gateway Runtime
  -> Agent VM controller
  -> controller-authorized Tool VM binding
```

### Current behavior

1. Hermes retains a cached managed-environment handle from the old control
   session.
2. The next operation probes that cached handle.
3. Gateway Runtime rejects the old generation as stale.
4. Fresh acquisition requests a controller-authorized Tool VM binding.
5. The controller result can be `publication_pending` while the corresponding
   current binding has not yet become usable inside Gateway Runtime.
6. Gateway Runtime performs an immediate lookup and reports unavailable, so the
   first operation fails; a later operation may succeed after publication.

### Expected behavior for the separate fix

The first affected operation should either:

- continue on a fresh controller-authorized binding within the existing bounded
  command deadline; or
- return the existing bounded unavailable result for a real terminal condition
  such as deadline expiry, another session replacement, runtime close, or
  connection failure.

It must never reuse the stale predecessor generation or replay a potentially
side-effecting application command.

### Known design constraints

- Keep controller durable lease and binding authority unchanged.
- Keep the existing `publication_pending` controller protocol unless separate
  design evidence proves it insufficient.
- Use event-driven publication observation rather than polling or sleeps.
- Scope recovery by exact accepted session, stable principal, and generation.
- Treat retirement of the exact rejected predecessor as replacement progress,
  not as proof that the successor failed.
- Do not add generic execution retry or retire every environment on every tool
  exception; those failures may have ambiguous side effects.

### Relevant source surfaces

- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py`
- `packages/gateway-runtime/src/control-endpoint/gateway-control-operation-active-use-runtime.ts`
- `packages/gateway-runtime/src/control-endpoint/gateway-control-published-binding-runtime.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-binding-publication.ts`
- `packages/gateway-control-contracts/src/index.ts`
- `packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts`

### Required proof

- Unit: failed cached-status proof retires only the exact stale local cache entry
  and creates a distinct generation.
- Unit/integration: publication arriving after the binding-request response
  completes the same acquisition without a second request.
- Unit/integration: the rejected predecessor cannot satisfy the readiness wait;
  its retirement does not terminate the wait for a successor.
- Unit/integration: deadline, session replacement, runtime close, connection
  failure, concurrency coalescing, and principal isolation are deterministic.
- Hermes E2E: the first post-reattachment terminal/filesystem operation succeeds
  through the real controller, Gateway VM, Gateway Runtime, and Tool VM path.

### Proof already captured

| Evidence | Result | What it proves | Limitation |
| --- | --- | --- | --- |
| Exact base `a4f0d0e1` and removal branch live reproduction | Both reached the same post-reattachment failure boundary | The defect predates and is not caused by OpenClaw removal | It is red evidence, not a fix |
| Cached-status unit test before the local correction | 173 passed, 1 failed at the expected escaped status exception | The cache hook could not reach eviction/reacquisition after a failed status probe | The test and correction are intentionally removed from this cutover branch |
| Pinned Hermes Python suite after the bounded cache correction | 174/174 passed | Exact stale-cache eviction/local retirement can be implemented without Python-suite regression | It did not fix the deeper asynchronous binding-publication race |
| Live Hermes rerun after cache correction | Fresh acquisition still returned unavailable at `publication_pending` | Cache cleanup is necessary but insufficient; the remaining seam is Gateway Runtime publication coordination | No green first-call recovery exists yet |

Proof status: the separate fix has a source-backed red reproduction and one
validated partial correction. It does not yet have the required event-driven
Gateway Runtime implementation, deterministic successor-wait matrix, or green
real Hermes first-call E2E. The owning agent must not claim completion from the
174/174 Python result alone.

### Stop conditions

- The proposed fix changes controller authority or public protocol without a
  separately reviewed design.
- Passing requires sleeps, polling, command replay, or weakened assertions.
- The live failure moves outside the cached-environment and binding-publication
  path described above.

## Deferred Item 2 — Hermes upstream upgrade qualification

- Current Agent VM pin: Hermes `0.20.0` at its existing immutable distribution
  inputs.
- Later Hermes `0.20.x` releases are not part of the OpenClaw cutover.
- A future upgrade must update the owned Hermes distribution pin, rebuild the
  image, and run the complete Hermes unit, integration, real-VM, profile,
  Tool Portal, filesystem, recovery, and operator proof independently from this
  removal.
- Status: deferred; no upgrade version is selected here.

## Deferred Item 3 — Future session-federation product decision

OpenClaw now provides meaningful session-centric product capabilities such as
cross-device clients, durable multi-channel ingress, session branching,
heterogeneous agent/runtime federation, cloud-worker placement, meetings,
paired browser control, and persistent MCP App dashboards.

No current Agent VM requirement needs those surfaces. Do not retain dormant
OpenClaw compatibility code for hypothetical option value; its rapidly changing
contracts would still require a fresh adapter and full qualification later.

Reopen this decision only when an authorized near-term requirement names at
least one concrete consumer journey involving cross-device session continuity,
heterogeneous runtime placement, durable channel federation, or OpenClaw-native
UI/app behavior.

Status: parked product decision, not scheduled implementation.

## Work that remains on the OpenClaw-removal branch

The following is cutover work, not deferred follow-up:

1. Restore the Requirements, Specification, Program Design, and active plan to
   the pure-removal boundary; remove the unrelated U10 recovery expansion.
2. Remove the uncommitted Hermes cached-status runtime repair and its unit test
   from this branch.
3. Preserve and verify the real generic process/stream proof already added.
4. Correct the protected Hermes SSH E2E setup so it configures the loaded
   `systemConfig.zones[0]` consumed by controller startup; this is test wiring,
   not a production authorization change.
5. Port only genuinely missing framework-neutral observations formerly owned by
   deleted OpenClaw E2E files: idle Tool VM retirement, stale reacquisition,
   health/replacement/no-flap behavior, and current Tool VM access.
6. Keep the known Hermes reattachment stress case separately visible as exact
   baseline-versus-cutover non-regression evidence; do not weaken it or present
   it as green cutover proof.
7. Resolve the proof-transfer ledger so every row is `transferred`,
   `OpenClaw-only delete`, or the one explicit baseline-red differential row.
8. Integrate the current `origin/master` changes and revalidate the exact
   resulting branch; do not assume the August 24 proof remains current.
9. Run the full unit, integration, host E2E, generic VM, Hermes-green, Worker,
   quality, package/residue, built-CLI scaffold/validate/build, and removed-
   command proof bundle.
10. Obtain a fresh independent implementation review, then commit/push and enter
    PR wrap-up only if the review is ready.

## OpenClaw cutover proof status

| Proof layer | Last evidence | Current status before cleanup |
| --- | --- | --- |
| Core removal implementation | Commits `859bfa43`, `eeae0213`, and `7d833519` | Committed; current branch still needs revalidation against newer `origin/master` |
| Unit | 4,334/4,334 at `eeae0213` | Passed previously; stale after current dirty changes and upstream integration |
| Integration | 820/820 at `eeae0213` | Passed previously; stale after current dirty changes and upstream integration |
| Host E2E | 234/234 at `eeae0213` | Passed previously; stale after current dirty changes and upstream integration |
| Generic VM E2E | 17/17 at `eeae0213` | Passed previously; the new process/stream observation has a separate selected real-VM pass but is uncommitted |
| Worker E2E | 5/5 at `eeae0213` | Passed previously; must remain green after integration |
| Retained Hermes files | 7/7 plus stock filesystem/profile 1/1 | Passed previously; protected SSH test is currently red because it mutates a copied zone view |
| Package inspection | 17 retained packages at synchronized `0.0.141` | Passed previously; `origin/master` now carries release `0.0.142`, so final inspection must use the integrated exact HEAD |
| Proof-transfer ledger | Process/stream row transferred | Incomplete: pending idle retirement, stale reacquisition, health/replacement/no-flap, current Tool VM access, and protected SSH observations remain |
| Full quality gate | 16/16 at `eeae0213` | Passed previously; no fresh final gate exists for the current worktree |
| Built CLI manual proof | Fresh Hermes scaffold/validate/build passed before the current dirty changes | Must be repeated after cleanup and integration; removed OpenClaw commands must still be rejected |
| Independent implementation review | Earlier review produced proof-transfer corrections | No fresh ready verdict exists for the final cleaned and integrated branch |

Final cutover proof is present only when every row above has fresh evidence at
the same integrated HEAD, every proof-transfer row has its allowed terminal
disposition, and no live lane succeeds by skipping its gate. Inventory-only
skips are recorded as inventory and never presented as runtime proof.

## Closing state

Confirmed:

- OpenClaw runs nowhere in the retained product.
- Hermes is the managed interactive Gateway; Worker remains the task Gateway.
- The Hermes reconnect defect and Hermes upgrade are separate work.
- Proof ports may observe retained behavior but may not redesign it.

Open:

- Exact implementation and release timing for the separate Hermes recovery
  work.
- Any future product requirement for OpenClaw-style session federation.
