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

## Completed cutover work and remaining gate

The removal implementation, master integration, retained proof ports, pure-
removal authority restoration, proof-transfer disposition, aggregate Hermes
proof, exact package inspection, and quality/removal gates are complete.

The first final implementation review at `155e7303` found four issues. They were
accepted and corrected at `46fe6e70`:

1. OpenClaw-specific lint and portal-architecture audit residue was removed, and
   the dedicated removal audit now covers active quality configuration/tooling.
2. This WIP was reconciled to one final proof and deferral boundary.
3. Program Design now treats old-release shutdown as an operator deployment
   prerequisite; this repository does not boot OpenClaw for PR proof.
4. The canonical package map now enumerates 17 packages and includes
   `gateway-runtime`.

The next reviews accepted the four implementation remediations and found no
runtime or missing-test defect. They identified two proof-authority wording
errors: first the WIP required one monolithic HEAD, then revision 2 assigned the
entire unit lane to `1fa07bb1` even though two audit unit files changed later.
The final model below uses consumer-relevance freshness and composite unit
coverage. One gate remains: fresh independent review of that final wording.

## OpenClaw cutover proof status

| Proof layer | Last evidence | Current status |
| --- | --- | --- |
| Core removal implementation | Commits `859bfa43`, `eeae0213`, and `7d833519`; master integration `02745c94` | Committed and integrated with `origin/master` at `cbba8890`; exact master differential adds no OpenClaw line |
| Unit | Composite: `pnpm test:unit` at `1fa07bb1` plus the two changed audit suites at `46fe6e70` | The full 383-file, 4,340/4,340 baseline covers unchanged unit consumers; current `audit-openclaw-removal` and `audit-portal-architecture` suites add 22/22 for the only later-changed unit files; taxonomy passed |
| Integration | `pnpm test:integration` at `1fa07bb1` | 61 files, 830/830 tests passed |
| Host E2E | `pnpm test:e2e:host` at `1fa07bb1` with required host permissions | 30 files, 234/234 tests passed; the first sandboxed attempt failed only on blocked uv, Docker, and host-process access |
| Generic VM E2E | `mise exec -- pnpm test:e2e:vm` at `1fa07bb1` | 11 files, 17/17 real VM tests passed, including process/stream and leaf-replacement proof |
| Worker E2E | documented private test-key mapping plus `mise exec -- pnpm test:e2e:worker` at `1fa07bb1` | 3 files, 5/5 tests passed with zero skips; the bare command's 2-pass/3-skip result is not used as proof |
| Retained Hermes files | Exact aggregate command rerun at `c8df1d36` | 5 files, 9/9 real Hermes tests passed with zero skips; the earlier 7/9 startup/root-health result did not reproduce |
| Package inspection | `pnpm inspect:managed-vm-package-cut --expected-head 46fe6e709cce30d4024c907445d67c1f87809deb` | Passed for exactly 17 retained npm packages at synchronized `0.0.142`; packed members and sibling dependency versions inspected |
| Proof-transfer ledger | Same-or-stronger retained paths are transferred; reattachment remains baseline-red differential evidence; non-equivalent idle/reacquisition/automatic-recovery scenarios are assigned to the separate runtime owner | Resolved for this cutover: no pending row remains and no deferred row authorizes a Hermes behavior change |
| OpenClaw residue audit | `pnpm exec tsx scripts/audit-openclaw-removal.ts` at `46fe6e70` | Passed with exit 0 after expanding coverage to root quality configuration and active portal-architecture tooling |
| Full quality gate | `UV_CACHE_DIR=/tmp/agent-vm-remove-openclaw-uv-cache pnpm check` at `46fe6e70` | 16/16 passed in 43.48 seconds: build, Optique CLI boundary, package/Zod guards, taxonomy, portal and VM boundaries, generated contracts, lint, format, type-aware lint, and typecheck |
| Built CLI manual proof | Fresh OS-temp `macos-local` Hermes scaffold, validate, real Docker/Gondolin build, and removed `--type openclaw` rejection at `1fa07bb1` | Passed; generated runtime shape contains Hermes and Tool VM inputs and no OpenClaw runtime directory/config |
| Independent implementation review | Complete reviews at `155e7303`, `65783cde`, and `bfe7a735` | Implementation corrections are accepted; later findings were proof-owner wording defects, with the final composite-unit correction awaiting review |

Final cutover proof is present only when every row above has evidence from the
most recent identity that changed its observed consumer path, and the final diff
proves no later relevant source, test, fixture, configuration, image, build, or
runtime change invalidated that evidence. Every proof-transfer row must have its
allowed terminal disposition (`transferred`, `OpenClaw-only delete`,
`baseline-red differential`, or `deferred runtime-owner qualification`), and no
live lane may succeed by skipping its gate. Inventory-only skips are recorded as
inventory and never presented as runtime proof.

### Proof freshness by consumer path

- `1fa07bb1` owns unchanged unit consumers plus the integration, host E2E,
  generic VM, Worker, built-CLI, and initial package evidence. Later changes do
  not touch their production source, configuration, fixtures, images, build
  inputs, or named tests.
- `c8df1d36` changes only the Hermes E2E test to separate ordinary restart from
  opt-in reattachment stress, and owns the final aggregate Hermes 9/9 result.
- `46fe6e70` changes root lint policy, removal/portal audit tooling and their two
  unit test files, canonical architecture text, and the cutover proof contract.
  It owns the current versions of those two unit consumers through the targeted
  22/22 result, plus the strengthened removal audit, full quality 16/16 result,
  and exact 17-package inspection.
- `65783cde` and the final receipt commit change only this WIP. They do not alter
  any observed consumer path above.

### Fresh integrated merge receipt

- Integrated source: `origin/master` at `cbba8890`.
- Merge commit: `02745c94`.
- Shared conflict policy: OpenClaw-owned files stayed deleted; current master
  namespace-discovery and credentialed-runtime contracts were retained under
  Hermes-only managed-agent identities.
- Focused unit command: eight selected unit files covering portable contracts,
  Gateway control contracts, semantic revision, manuals, controller HTTP, and
  control-domain handling; result `187 passed`, exit 0.
- Focused integration command: four selected files covering Gateway zone
  orchestration, Tool Portal approval, and managed Tool Portal composition;
  result `69 passed`, exit 0.
- Full quality command:
  `UV_CACHE_DIR=/tmp/agent-vm-remove-openclaw-uv-cache pnpm check`; result
  `16 passed, 0 failed`, exit 0.
- Dedicated removal command:
  `pnpm exec tsx scripts/audit-openclaw-removal.ts`; exit 0.
- Exact remediation-head checks are complete at `46fe6e70`; only corrected-head
  independent review remains.

### Fresh integrated final-bundle progress at `1fa07bb1`

- Unit: 4,340/4,340 passed.
- Integration: 830/830 passed.
- Host E2E: 234/234 passed with the real host permissions required by the
  lane.
- E2E inventory: 1 inventory test passed and 38 runtime tests skipped by closed
  gates; inventory only, not runtime proof.
- Generic VM: 17/17 passed.
- Worker: 5/5 passed with the test-only model credential mapped; zero skips.
- Hermes green: the exact aggregate lane later passed 5 files and 9/9 tests at
  `c8df1d36`, superseding the selected-file-only receipt for aggregate health.
- Package cut: exactly 17 retained npm packages packed and inspected at
  `0.0.142`.
- Built CLI: fresh Hermes scaffold succeeded, static validation returned
  `ok: true`, the real registry-backed Docker/Gondolin build succeeded with
  Hermes `0.20.0`, and `--type openclaw` was rejected by the Optique parser.

### New cutover proof break — idle retirement and stale reacquisition

The exact idle-retirement and stale-reacquisition scenarios are deferred to the
separate runtime owner. Before that disposition, a test-only port was attempted
twice on the real Hermes path:

1. Hermes BaseEnvironment filesystem write/read with a 5-second configured
   lease TTL.
2. Generic Hermes `tool_call -> tool_portal_call -> tool_vm_runner` filesystem
   write/read with the same TTL.

Both completed their live Tool VM operation, then retained the exact lease
record and QEMU process beyond a 180-second protocol deadline. The second path
matches the deleted proof's framework-neutral Tool Portal semantics, so this is
not resolved by relabeling existing explicit leaf replacement.

The failed test experiment was removed; no red or weakened test was committed.
The preserved failed-run roots and current source sharpen the mismatch:

- the deleted OpenClaw case invoked stateless `tool_portal_call` operations and
  expected each invocation's active use to end before the controller idle
  reaper ran;
- stock Hermes intentionally caches one managed `BaseEnvironment` per admitted
  profile and reuses its open Gateway Runtime environment while its status stays
  active;
- the controller idle reaper correctly excludes leases with a nonzero active-use
  count, so it must not retire a Tool VM that the cached Hermes environment still
  owns.

Therefore the old 5-second OpenClaw expectation is not a mechanical Hermes test
port. Making it pass through stock Hermes would require a lifecycle decision
about when Hermes closes or evicts its cached environment, which this branch is
not authorized to make. A direct common-runtime proof may still be valid if it
ends the active use through a real retained product seam; explicit environment
close or explicit leaf replacement must not be relabeled idle retirement.

If the exact Hermes idle-retirement requirement remains mandatory, it needs a
separate runtime/design owner decision. Investigation receipt:
`tmp/debug-workflows/2026-08-26-agent-vm-remove-openclaw-hermes-idle-retirement/debug-investigation.md`.

### Remaining recovery-proof delta

The green Hermes restart test does not fully replace the deleted automatic
recovery cases. Those cases killed the framework sibling, observed
controller-driven whole-Gateway VM replacement, reacquired fresh Tool VM leaves,
and then proved a stable no-flap window. The stronger repeated case performed
three such replacements before its quiet window.

Current retained evidence proves a clean distinct Gateway restart, healthy
attachment stability, root API health, and stable sibling identities. It does
not yet prove fatal-framework-triggered automatic replacement, repeated fresh
Tool VM access after replacement, or three-recovery no-flap behavior. These
ledger rows are recorded as deferred runtime-owner qualification rather than
being inferred from the weaker restart case.

### Reattachment stress separation receipt

`hermes-managed-base-environment.hermes.e2e.test.ts` now keeps its ordinary
restart proof green while retaining the same post-control-reattachment tail
behind `AGENT_VM_HERMES_REATTACHMENT_STRESS=1`.

- Gate closed: 1/1 restart test passed. It proves a distinct second Gateway VM
  epoch, root API health, unchanged framework and Tool Portal sibling process
  identities during ordinary work, preserved native profile leaves, and no
  healthy-attachment replacement.
- Gate open: the same current-head test remains red on the first affected Tool
  VM call with `Gateway runtime method dispatch failed`, matching the previously
  recorded exact-base failure boundary.
- The assertion still expects `HERMES_TOOL_VM_RECOVERY_OK`; no expected-failure
  conversion, retry, or second-call fallback was added.

### Aggregate Hermes lane receipt

The earlier complete-lane run produced 7/9 passes: the managed-base harness did
not observe Gateway start, and observability timed out waiting for root API
health. Both files passed individually, so the result remained an aggregate
evidence gap rather than a product diagnosis.

At `c8df1d36`, the smallest suspected two-file collision was run with real host
permissions:

`AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES=1 AGENT_VM_HERMES_E2E=1 mise exec -- pnpm exec vitest run --config vitest.config.ts --project e2e-hermes packages/agent-vm/src/integration-tests/hermes-managed-base-environment.hermes.e2e.test.ts packages/agent-vm/src/integration-tests/hermes-framework-observability.hermes.e2e.test.ts --reporter=verbose`

Result: 2 files and 6/6 tests passed, exit 0. This falsified deterministic
contamination between those two files in the observed order.

The exact complete named lane was then rerun with real host permissions:

`AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 mise exec -- pnpm test:e2e:hermes`

Result: 5 files and 9/9 tests passed with zero skips, exit 0, in 311.73 seconds.
The prior aggregate-only startup/root-health failures did not reproduce. No
test, timeout, assertion, production behavior, or Hermes runtime behavior was
changed to obtain the green result.

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
