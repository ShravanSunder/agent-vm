# Post-OpenClaw Removal Follow-Ups

## Boundary

The `remove-openclaw` branch owns one outcome: remove OpenClaw completely while
retaining Hermes, Worker, and framework-neutral Agent VM behavior.

This branch does not independently redesign Hermes cache, reconnect, retry,
reacquisition, or binding-publication behavior. The separately owned Hermes
control-reattachment recovery landed on `origin/master` and is integrated here
unchanged except for porting its new test principals to this branch's existing
Hermes-only identity contract. OpenClaw configuration, runtime code, packages,
plugins, images, commands, tests, and supported documentation are removed rather
than preserved behind compatibility paths.

## Decisions

### Keep the removal branch focused

- Decision: the OpenClaw-removal branch contains no unrelated Hermes runtime
  repair.
- Why: the repository owner wants a clean OpenClaw cutover; the Hermes reconnect
  defect was handled and reviewed on its separate branch before landing on
  `origin/master`.
- Rejected alternative: finish the Hermes recovery change in this branch. That
  mixes an independent runtime behavior change with the deletion and makes the
  cutover harder to attribute and verify.
- Consequence: this branch carries the upstream recovery only through the
  requested master integration and does not add a second implementation.
- Status: accepted.

### Retained-behavior proof remains cutover work

- Decision: proof-only ports that demonstrate retained Hermes/common-runtime
  behavior remain part of the OpenClaw cutover.
- Why: deleting OpenClaw-specific E2E files must not silently delete the only
  observation of framework-neutral behavior.
- Consequence: generic VM or Hermes tests may be added or corrected, but they
  must not change runtime behavior merely to make a proof pass.
- Status: accepted.

## Integrated Item 1 — Hermes first-call recovery after control reattachment

Owner: separate recovery branch, merged to master as `c3a6b1d6` and integrated
into this cutover through `origin/master` at `0ba4d0e2`.

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

### Former failing behavior

1. Hermes retains a cached managed-environment handle from the old control
   session.
2. The next operation probes that cached handle.
3. Gateway Runtime rejects the old generation as stale.
4. Fresh acquisition requests a controller-authorized Tool VM binding.
5. The controller result can be `publication_pending` while the corresponding
   current binding has not yet become usable inside Gateway Runtime.
6. Gateway Runtime performs an immediate lookup and reports unavailable, so the
   first operation fails; a later operation may succeed after publication.

### Resolved behavior

The first affected operation now either:

- continue on a fresh controller-authorized binding within the existing bounded
  command deadline; or
- return the existing bounded unavailable result for a real terminal condition
  such as deadline expiry, another session replacement, runtime close, or
  connection failure.

It must never reuse the stale predecessor generation or replay a potentially
side-effecting application command.

### Preserved design constraints

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

### Integrated proof

- Focused TypeScript unit: three files, 47/47 passed. This includes the upstream
  replacement-session use-end runtime and the retained manual contract.
- Focused controller integration: 4/4 passed for Tool VM retirement authority.
- Hermes Python adapter: 178/178 passed, including the upstream managed Gateway
  bootstrap recovery changes.
- Real Hermes E2E: five files, 9/9 passed with zero skips. The first operation
  after control reattachment succeeds through the real controller, Gateway VM,
  Gateway Runtime, and Tool VM path without creating a replacement Tool VM
  process.

Proof status: green. The prior `publication_pending` reproduction remains useful
historical diagnosis, but it is no longer an open or deferred cutover item.

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
runtime or missing-test defect. Their exact-head verdicts became stale when the
requested master pull integrated the separately reviewed Hermes recovery and
the `0.0.143` release train. The final model below uses consumer-relevance
freshness and records fresh affected-path proof. The owner-confirmed authority
correction is captured in Requirements, Specification, Program Design, the
proof-transfer ledger, and immutable plan revision 4. One gate remains:
independent review of the final committed authority and proof record.

## OpenClaw cutover proof status

| Proof layer | Last evidence | Current status |
| --- | --- | --- |
| Core removal implementation | Commits `859bfa43`, `eeae0213`, and `7d833519`; current integration of `origin/master` at `0ba4d0e2` | OpenClaw-owned conflicts stayed deleted; upstream Hermes recovery and credentialed-runtime documentation were retained |
| Unit | Historical full 4,340/4,340 baseline plus current affected-path run | Three current merge-affected files passed 47/47; the new upstream recovery test was ported from its removed OpenClaw principal fixture to the existing Hermes identity contract |
| Integration | Historical full 830/830 baseline plus current affected-path run | Current Tool VM retirement authority integration passed 4/4 |
| Host E2E | `pnpm test:e2e:host` at `1fa07bb1` with required host permissions | 30 files, 234/234 tests passed; the first sandboxed attempt failed only on blocked uv, Docker, and host-process access |
| Generic VM E2E | `mise exec -- pnpm test:e2e:vm` at `1fa07bb1` | 11 files, 17/17 real VM tests passed, including process/stream and leaf-replacement proof |
| Worker E2E | documented private test-key mapping plus `mise exec -- pnpm test:e2e:worker` at `1fa07bb1` | 3 files, 5/5 tests passed with zero skips; the bare command's 2-pass/3-skip result is not used as proof |
| Hermes Python adapter | `pnpm python:test:hermes` on the integrated merge tree | 178/178 passed, including the upstream reattachment recovery implementation |
| Retained Hermes files | Exact aggregate command on the integrated merge tree with required host permissions | 5 files, 9/9 real Hermes tests passed with zero skips in 346.27 seconds, including first-call recovery after reattachment |
| Package inspection | `pnpm inspect:managed-vm-package-cut --expected-head f2ddb8577f79e5b8ac2cc7b07ac15b76793ee9a2` | Passed for exactly 17 retained npm packages at synchronized `0.0.143`; packed members, declarations, and sibling dependency versions were inspected |
| Proof-transfer ledger | Same-or-stronger retained paths are transferred; reattachment is now green upstream recovery evidence; non-equivalent idle/reacquisition/automatic-recovery scenarios remain assigned to their runtime owner | Resolved for this cutover: no pending row authorizes an additional Hermes behavior change |
| OpenClaw residue audit | `pnpm exec tsx scripts/audit-openclaw-removal.ts` on the integrated merge tree | Passed with exit 0 after the master integration and test-fixture port |
| Full quality gate | `UV_CACHE_DIR=/tmp/agent-vm-remove-openclaw-uv-cache pnpm check` on the integrated merge tree | 16/16 passed in 46.81 seconds: build, Optique CLI boundary, package/Zod guards, taxonomy, portal and VM boundaries, generated contracts, lint, format, type-aware lint, and typecheck |
| Built CLI manual proof | Fresh OS-temp `macos-local` Hermes scaffold, validate, real Docker/Gondolin build, and removed `--type openclaw` rejection at `1fa07bb1` | Passed; generated runtime shape contains Hermes and Tool VM inputs and no OpenClaw runtime directory/config |
| Independent implementation review | Complete reviews at `155e7303`, `65783cde`, and `bfe7a735` | Historical reviews are accepted but stale for the new master integration; one fresh exact-head review remains |

Final cutover proof is present only when every row above has evidence from the
most recent identity that changed its observed consumer path, and the final diff
proves no later relevant source, test, fixture, configuration, image, build, or
runtime change invalidated that evidence. Every proof-transfer row must have its
allowed terminal disposition (`transferred`, `OpenClaw-only delete`, or
`deferred runtime-owner qualification`), and no
live lane may succeed by skipping its gate. Inventory-only skips are recorded as
inventory and never presented as runtime proof.

### Proof freshness by consumer path

- `1fa07bb1` owns unchanged unit consumers plus the integration, host E2E,
  generic VM, Worker, built-CLI, and initial package evidence. Later changes do
  not touch their production source, configuration, fixtures, images, build
  inputs, or named tests.
- `c8df1d36` owned the pre-recovery aggregate Hermes 9/9 result. The current
  integrated merge tree supersedes it for the changed reattachment consumer.
- `46fe6e70` changes root lint policy, removal/portal audit tooling and their two
  unit test files, canonical architecture text, and the cutover proof contract.
  It owns the current versions of those two unit consumers through the targeted
  22/22 result, plus the strengthened removal audit, full quality 16/16 result,
  and exact 17-package inspection.
- `0ba4d0e2` adds the separately reviewed Hermes control-reattachment recovery,
  credentialed-runtime documentation, and synchronized `0.0.143` package train.
  Fresh focused TypeScript, Python, aggregate Hermes, quality, and removal-audit
  evidence above supersedes affected historical receipts.
- The final WIP receipt commit changes documentation only and does not alter an
  observed runtime consumer path.

### Fresh integrated merge receipt

- Integrated source: `origin/master` at `0ba4d0e2`.
- Merge commit: `2b5d8dc141ebdb5690c2ba4dca3a89a5c284cc98` with parents
  `a119e42107efeaf352e74d9ba873617db6f3f0e6` and
  `0ba4d0e23663fb5effabee8681bf67e7a8c01b92`.
- Shared conflict policy: OpenClaw-owned files stayed deleted; current master
  namespace-discovery and credentialed-runtime contracts were retained under
  Hermes-only managed-agent identities.
- Focused unit command: manual templates plus both upstream recovery runtime
  files; result `47 passed`, exit 0.
- Focused integration command: Tool VM retirement authority; result `4 passed`,
  exit 0.
- Hermes Python adapter command: result `178 passed`, exit 0.
- Real Hermes aggregate command with host permissions: result `9 passed`, zero
  skips, exit 0.
- Full quality command:
  `UV_CACHE_DIR=/tmp/agent-vm-remove-openclaw-uv-cache pnpm check`; result
  `16 passed, 0 failed`, exit 0.
- Dedicated removal command:
  `pnpm exec tsx scripts/audit-openclaw-removal.ts`; exit 0.
- Exact package inspection passed at the WIP commit
  `f2ddb8577f79e5b8ac2cc7b07ac15b76793ee9a2`. Governing authority now accepts
  the integrated recovery baseline; only independent review remains.

### Fresh integrated final-bundle progress at `1fa07bb1`

- Unit: 4,340/4,340 passed.
- Integration: 830/830 passed.
- Host E2E: 234/234 passed with the real host permissions required by the
  lane.
- E2E inventory: 1 inventory test passed and 38 runtime tests skipped by closed
  gates; inventory only, not runtime proof.
- Generic VM: 17/17 passed.
- Worker: 5/5 passed with the test-only model credential mapped; zero skips.
- Hermes green: the exact aggregate lane now passes 5 files and 9/9 tests on the
  integrated `0ba4d0e2` merge tree, superseding the pre-recovery receipt.
- Package cut: the historical exact inspection covered 17 retained npm packages
  at `0.0.142`; the integrated train's exact inspection passed for the same 17
  retained packages at synchronized `0.0.143`.
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

### Reattachment recovery receipt

The upstream recovery is now part of the ordinary
`hermes-managed-base-environment.hermes.e2e.test.ts` path. The former opt-in
stress separation is gone.

- The first post-reattachment Tool VM operation succeeds.
- The test observes a fresh `main` lease request while proving that no new Tool
  VM process was created.
- The proof retains stock Hermes behavior and does not add command replay,
  expected-failure conversion, or a second-call fallback.

### Aggregate Hermes lane receipt

The exact complete named lane was rerun after the master integration with the
host permissions required by Docker, Gondolin session registration, and the
production `ps` containment check:

`UV_CACHE_DIR=/tmp/agent-vm-remove-openclaw-uv-cache AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 mise exec -- pnpm test:e2e:hermes`

Result: 5 files and 9/9 tests passed with zero skips, exit 0, in 346.27 seconds.
Earlier sandboxed attempts failed at `uv` cache writes, Buildx metadata,
Gondolin session registration, and `spawn EPERM`; they are environment receipts,
not product failures. No test, timeout, assertion, production behavior, or
Hermes runtime behavior was changed to obtain the green result.

## Closing state

### Final protocol-client and LLM-lane remediation

The final aligned review found two callerless OpenClaw protocol clients still
compiled into `@agent-vm/agent-vm` and a registered LLM lane that still invoked
`openclaw agent`. The remediation:

- deletes the obsolete HTTP and WebSocket clients plus their OpenClaw-specific
  tests;
- ports the LLM lane to an OS-temp Hermes scaffold and pinned Hermes one-shot
  command for the managed `main` profile;
- uses the test-only OpenAI credential through normal HTTP mediation;
- asserts command exit 0, a real model answer, and healthy Hermes readiness
  after the response rather than manufacturing a Tool VM lease;
- makes the removal audit reject both the protocol-client directory and
  OpenClaw residue in the registered LLM lane.

Focused audit/gate tests pass 8/8. Typecheck and taxonomy pass. The real LLM
lane passes 1 file and 2/2 tests with zero skips and exit 0. Full quality passes
16/16. Exact package inspection at
`3fcf807a240d74268a505613dc5946dfa5cc1711` passes for all 17 retained packages
at synchronized `0.0.143`, and the built `agent-vm` artifact contains no
Gateway API or WebSocket client output. Only fresh independent review remains.

### Positive test-fixture classification

The next exact-head review confirmed the runtime/package remediation and found
positive Hermes fixtures that still used mechanically inherited OpenClaw names.
The correction classifies the remaining test references:

- explicit rejection, absence, predecessor-shutdown, and removal-enforcement
  tests retain OpenClaw literals in a narrow audit allowlist;
- all other positive fixtures use Hermes or framework-neutral variable, path,
  image, config, secret, identity, and description vocabulary;
- the removal audit scans every non-allowlisted package/script test and has a
  permanent fixture proving positive OpenClaw vocabulary fails.

Proof: unit 383 files and 4,364/4,364; integration 59 files and 822/822; affected
real VM 1/1 with zero skips; full quality 16/16; removal audit exit 0. This
remediation changes test/audit sources only, so the exact packed-package receipt
at `3fcf807a240d74268a505613dc5946dfa5cc1711` remains current.

Confirmed:

- OpenClaw runs nowhere in the retained product.
- Hermes is the managed interactive Gateway; Worker remains the task Gateway.
- The Hermes reconnect defect was fixed separately and is now integrated from
  master; the Hermes upstream upgrade remains separate work.
- Proof ports may observe retained behavior but may not redesign it.

Open:

- Exact qualification and release timing for the remaining idle-retirement and
  automatic whole-Gateway recovery scenarios.
- Any future product requirement for OpenClaw-style session federation.
