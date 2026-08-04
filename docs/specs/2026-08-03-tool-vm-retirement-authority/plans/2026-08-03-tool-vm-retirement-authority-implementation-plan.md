# Tool VM Retirement Authority Implementation Plan

Date: 2026-08-03
Goal: `2026-08-03-tool-vm-retirement-authority`
Branch: `fix/tool-vm-retirement-authority`
Planning base: `354885d7e718cf46e1d1602c9e4380ff3a78222f`

## Planning basis

This plan implements the reviewed requirements, specification, and program design without changing their authority model:

- [Requirements](../2026-08-03-tool-vm-retirement-authority-requirements.md), SHA-256 `d16b2b7529b4e972e4c36032c1db95dcf17f64640d3cd380572b7bca03017354`.
- [Specification](../2026-08-03-tool-vm-retirement-authority.md), SHA-256 `914d3b73c0762ca3e0d96dcfa9792cf463a361684ad754dd2066b340d7ce7f49`.
- [Program design](../2026-08-03-tool-vm-retirement-authority-program-design.md), SHA-256 `ea59d3d6cd5d1907617ff46c395e89ee07763f88caf5bbb35708c63a0868016c`.
- Pair review: Claude Fable v4 plus proof correction verification v6, both ready; Sol advisor found no blocker or important issue on the exact hashes above.

Target classification: `general-domain`, `current-pair-ready`.

## Goal and non-goals

The change must make an idle Tool VM retirement a bounded, recoverable per-agent transition. After the Controller fences the predecessor, Gateway-local retirement and exact predecessor termination proceed as siblings. Exact predecessor absence, not Gateway acknowledgement or retained cleanup, releases successor admission. Connection-local derived state and pending work cannot cross accepted control connections, and an expired command cannot publish stale binding state.

This plan does not add a Gateway restart policy, supervisor, recovery manager, queue, database, public/wire result, compatibility path, general cancellation framework, Gondolin change, framework-plugin lifecycle owner, production telemetry subsystem, version-skew repair, or unrelated incident fix.

## Required invariant

```text
Controller fence exact predecessor
          |
          +-- Gateway unroutes exact binding and invokes SSH close
          |
          +-- Controller exact-terminates recorded VM process
                         |
                         +-- proves exact absence
                                      |
                                      v
                successor SSH / commit / publish / route / use
```

Gateway acknowledgement and retained cleanup are observed independently. Neither gates successor admission. Provisional successor boot may overlap predecessor destruction, as it does today.

## Requirements/proof matrix

| Row | Required claim | Owning slices | Proof modality and layer | Evidence source | Freshness guard | Red/green |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | Exact predecessor retirement cannot block successor admission indefinitely. | S1, S2, S4 | Lease and Gateway Runtime unit tests; composed integration event log. | Parent-run commands and asserted partial orders. | Exact HEAD, exact lease/leaf/process identities. | Required. |
| M2 | Communication impairment remains leaf-scoped and returns before shared response timeout. | S3, S4 | Injected-deadline unit tests; composed red/green integration using the real command-result timeout/close path. | Parent-run tests and ordered log. | No wall-clock sleeps; timeout/rotation events originate in production runtime seams. | Required. |
| M3 | Connection-local state cannot poison a replacement connection. | S1, S3, S4 | Controller publication and Gateway active-use unit tests; C1/C2 integration. | Parent-run tests. | Explicit accepted-session and connection-generation assertions. | Required. |
| M4 | An eligible late lease remains current, unbound, and republishable. | S3, S4 | Publication/RPC unit tests and composed integration. | Parent-run tests. | Exact lease/generation retained across authority rotation; no compensation destruction. | Required. |
| M5 | Provisional boot overlap remains, without early SSH, commit, publication, routing, or use. | S2, S4 | Lease-manager unit tests plus integration barriers. | Parent-run tests. | Ordered controllable barriers around exact absence. | Required. |
| M6 | `lease_reacquire` and ready-binding -> rejected-use -> one-shot recovery remain correct. | S3, S4 | Active-use, RPC, deadline, and composed integration tests. | Parent-run tests. | Current source entrypoints and result kinds. | Required. |
| M7 | OpenClaw and Hermes share the fix without plugin lifecycle ownership. | S5 | Shared composition integration plus separate no-skip real framework E2Es. | Parent-run no-skip evidence lanes and runtime identity evidence. | Clean exact commit; real QEMU/plugin/Tool Portal/Tool VM/SSH path; unchanged Gateway identity. | Required. |
| M8 | Repository and PR are ready. | S6 | Unit, integration, host E2E, inventory, live E2E, `pnpm check`, implementation review, CI and PR state. | Parent-run commands, review receipts, GitHub state. | PR head equals the exact tested and reviewed clean commit. | N/A after slice red/green. |

## Vertical slices

### S1 — Exact Gateway-local retirement and connection-local derived state

Source: U3; R3, R7; V3, V6; M1, M3.

Behavior:

1. Retiring the exact current binding makes it unavailable for lookup before acknowledgement and synchronously invokes strict SSH client close.
2. A late `connect()` completion cannot restore a retired slot to ready.
3. Exact duplicate retirement is idempotent; a different identity remains `retirement_identity_mismatch`.
4. Controller publication tracking is owned by one exact accepted publication authority and is cleared before use when authority changes.
5. Gateway pending binding work is reused only for the same stable principal and exact accepted session.

Expected production writes:

- `packages/gateway-runtime/src/control-endpoint/gateway-control-published-binding-runtime.ts`
- `packages/gateway-runtime/src/control-endpoint/gateway-control-operation-active-use-runtime.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-binding-publication.ts`

Red tests first:

- lookup is already unavailable when observed synchronously from inside the strict SSH client's `close` callback, and the retirement publication acknowledges only afterward;
- retirement during a delayed SSH connect cannot finish as ready;
- C2 cannot inherit C1's held or rejected binding promise;
- C2 clears Controller-derived predecessor tracking and may republish the same eligible Controller lease without replaying an untracked retirement.

The ordered Gateway unit matrix also covers an exact duplicate and a different-identity mismatch. Checkpoint: `gateway-control-published-binding-runtime.unit.test.ts`, `gateway-control-operation-active-use-runtime.unit.test.ts`, and `gateway-control-binding-publication.unit.test.ts` pass; exact mismatch behavior is unchanged; no protocol or plugin file changes.

### S2 — Controller retirement transaction and absence-gated lock release

Source: U2, U3; R1-R4; V1-V3; M1, M5.

Behavior:

1. After logical fencing, the existing retirement subscription starts exact tracked-binding retirement while exact process termination proceeds independently.
2. The lease-manager retirement listener becomes async and returns `Promise<void>`. `gateway-control-lease-rpc.ts` mirrors that listener shape. `gateway-control-binding-publication.ts` owns the Controller-local `publication-applied | not-tracked-on-current-connection` result, and `gateway-zone-orchestrator.ts` translates that result into the listener promise.
3. Idle/explicit `releaseLease` holds the per-agent lock only through `accessFenced`; retained cleanup completion remains consumed and observed outside the lock.
4. Exact absence continues to gate the existing admission barrier. Gateway acknowledgement, `ManagedVm.close()`, host SSH close, runtime-record deletion, and TCP release do not.

Expected production writes:

- `packages/agent-vm/src/controller/leases/lease-manager.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts` only to mirror the lease-manager async listener contract;
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-binding-publication.ts` for the narrow local retirement result.

Lease retirement starts the listener promise after logical fencing, concurrently with exact process termination, and joins or observes it outside `accessFenced`. Lease authority does not import or expose control-session publication result semantics.

Red tests first:

- the existing same-agent release/replacement test must prove replacement starts after exact absence while retained SSH/resource cleanup is still held;
- delayed Gateway acknowledgement cannot delay exact termination or lock release;
- absence-unproven remains fenced and cannot enable successor SSH or commit current;
- no demand after idle retirement creates no successor.

Checkpoint: `lease-manager.unit.test.ts`, `gateway-control-binding-publication.unit.test.ts`, `gateway-control-lease-rpc.unit.test.ts`, and `gateway-zone-orchestrator.integration.test.ts` pass, and every retirement, acknowledgement, and cleanup promise is consumed without unhandled rejection.

### S3 — Command-expiry containment and retained late lease authority

Source: U1, U4, U5; R5-R8; V4-V7; M2-M4, M6.

Behavior:

1. `tool_vm_binding_request` and `lease_reacquire` use their existing envelope/semantic deadline to finish the caller-visible result before the longer binding-result timeout.
2. Lease-owned work may settle after caller expiry; it is not generally cancelled and its eligible current lease is not destroyed.
3. Connection and command authority are revalidated before publication and after asynchronous create/select work.
4. Fresh authority reselects and publishes an eligible Controller-current unbound lease.
5. Same-agent work coalesces by stable principal plus exact accepted connection; unrelated principals remain independent.

Expected production writes:

- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-binding-publication.ts`
- `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts`
- `packages/agent-vm/src/controller/control-session/gateway-semantic-result-ledger.ts`, only through its existing deadline/unknown-side-effect owner;
- `packages/agent-vm/src/controller/control-session/control-session-dispatcher.ts` only if an internal operation-selective deadline mode is required;
- `packages/gateway-runtime/src/control-endpoint/gateway-control-operation-active-use-runtime.ts`.

The deadline change must be operation-selective for the two leaf-creating commands unless live source and tests prove an unconditional existing-ledger correction preserves every other semantic operation. It must not create a public result, a second ledger, or a cancellation framework.

Red tests first:

- caller-visible `tool_vm_binding_request` and `lease_reacquire` settle at command expiry while held lease work continues;
- late completion becomes `unknown_side_effect` and cannot publish under stale authority;
- the eligible late lease is retained unbound and republished by C2;
- `lease_reacquire` and rejected `lease_use_start` one-shot recovery remain successful;
- a different principal completes while one principal's transition is held.

Checkpoint: `gateway-semantic-result-ledger.unit.test.ts`, `gateway-control-domain-handler.unit.test.ts`, `gateway-control-lease-rpc.unit.test.ts`, `gateway-control-binding-publication.unit.test.ts`, and `gateway-control-operation-active-use-runtime.unit.test.ts` pass with injected clocks/barriers and no 180-second wall-clock wait.

### S4 — Deterministic composed causal proof

Source: U6; R9; V8, V9; M1-M6.

Add one integration test under `packages/agent-vm/src/controller/control-session/` so the integration project exercises the real lease manager, publication coordinator, Gateway published-binding runtime, active-use runtime, Controller authority checks, and Gateway command-result timeout plus response-failure close path. VM/process and SSH edges remain controllable fakes.

The fixture records only:

```text
sequence, event, agentKey, leaseId, leafGeneration, connectionGeneration
```

The exact-base RED receipt first captures the unmodified production failure with command expiry earlier than the longer result timeout but not caller-visible until after the handler settles.

The permanent post-fix red-path case remains causal by configuring the existing test-only command-result timeout seam deliberately earlier than command expiry. It must originate timeout and rotation from the real command-result timer/response-failure close path and assert:

```text
waiting-acquire-observed
  < binding-result-timeout-observed
  < control-connection-rotated
  < stale-binding-publication-rejected
```

The green path uses the production ordering—command expiry earlier than the longer result timeout—and must prove command-expiry return occurs without rotating the healthy shared connection, retains an eligible late lease unbound, reselects and publishes it under fresh authority, covers `lease_reacquire` and rejected-use recovery, and completes later work. Assert required partial orders rather than one total order. Print the redacted log on failure only. The permanent red case is a transport-failure proof, not a production legacy toggle; neither case may append timeout/rotation events directly from the harness.

Checkpoint: the composed integration test fails for the production reason at the unmodified base, then passes after S1-S3. Harness-scripted timeout/rotation events do not satisfy this slice.

### S5 — Shared ownership and real OpenClaw/Hermes proof

Source: U1, U5, U6; R10, R11; V10, V11; M7.

1. Extend shared-runtime composition coverage only if needed to prove both plugins remain adapters.
2. Add separate files rather than expanding the near-limit existing E2Es:
   - `packages/agent-vm/src/integration-tests/tool-vm-idle-retirement.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/tool-vm-idle-retirement.hermes.e2e.test.ts`
3. Each no-skip proof performs a real Tool VM operation before a short configured idle TTL, waits on lease/process/protocol evidence, proves exact predecessor absence, then performs a real operation after on-demand replacement.
4. Capture old/new lease, leaf, process, and strict SSH identity; prove the Gateway VM and framework process identity remain unchanged. Identity evidence records only public fingerprints or hashes.
5. Ephemeral private SSH material must be removed with `trap`/`finally` cleanup even when an intentional negative SSH canary fails. Each proof asserts the scratch key file is absent afterward. Do not copy the existing negative-canary helper's fall-through cleanup unchanged.

Checkpoint: each filtered evidence-project command runs a nonzero test count with zero skipped/todo tests.

Manual proof then uses the existing beta deployment workflow, not a new probe framework: sync the exact local tarballs with `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`, rebuild and start the beta deployment with its normal commands, perform one real file/shell operation, retire that exact Tool VM lease through the existing protected Controller operation, and perform another real operation while observing a new Tool VM identity and unchanged Gateway identity. Record the commands and observations without secrets. If the beta deployment cannot be safely exercised, manual proof remains open; do not replace it with another automated test or claim completion.

### S6 — Regression, review, and PR readiness

Source: M8 and repository proof rules.

After S1-S5 are green:

1. Run focused unit and integration files.
2. Run `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e:host`, and `pnpm test:e2e:inventory`; label inventory as discovery only.
3. Run filtered no-skip OpenClaw and Hermes evidence projects, then the complete framework lanes and default `mise exec -- pnpm test:e2e`.
4. Run `pnpm check`.
5. Commit only the scoped, proven files, then unconditionally rerun both filtered no-skip OpenClaw and Hermes proofs on that clean exact HEAD and record the HEAD plus clean-tree state.
6. Run `implementation-review-swarm`, resolve source-valid findings, and rerun affected gates. Any review-driven source change requires both filtered live proofs to rerun on the new clean commit.
7. Push and create/update the PR. Use blocking GitHub watches at 120-second intervals, verify checks, comments, unresolved threads, mergeability, and exact PR head equality with the tested/reviewed commit. Do not merge.

## Execution DAG

```text
gate 0: verify branch, clean boundary, artifact hashes, and plan review
  |
S1 shared coordinator foundation: connection-scoped authority/map/result
  |    parallel-safe work: Gateway published-slot ordering tests/code
  |    proof: focused Gateway/Controller publication units
  v
S2 shared coordinator retirement result + lease listener/orchestrator wiring
  |    parallel-safe work: lease-manager lock/cleanup tests/code
  |    proof: lease-manager/RPC/orchestrator checks
  v
S3 shared coordinator expiry guard + targeted deadline containment
       parallel-safe work: semantic-ledger and active-use tests/code only
       proof: ledger/domain/RPC/publication/active-use units
  |
integration gate: parent inspects all diffs and resolves shared-file overlap
  |
S4 composed red/green causal integration proof
  |
S5 shared boundary + OpenClaw and Hermes live product proofs
  |
S6 broad gates -> clean commit -> implementation review -> PR readiness
```

The coordinator critical path is serial and has one writer throughout:

```text
S1 connection-scoped index/result foundation
  -> S2 tracked-retirement result and wiring
  -> S3 command-expiry revalidation
```

Disjoint lease-manager, semantic-ledger, and Gateway Runtime test/code work may proceed concurrently only where the slice names a separate file owner. Run the focused coordinator checkpoint after every stage and the combined C1/C2 plus stale-publication matrix before S4. S4 begins only after parent integration of S1-S3.

## Validation commands

Focused tests are selected after exact test additions, then the terminal gates are:

```text
pnpm test:unit
pnpm test:integration
pnpm test:e2e:host
pnpm test:e2e:inventory
AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm tsx scripts/run-vitest-evidence-project.ts e2e-openclaw packages/agent-vm/src/integration-tests/tool-vm-idle-retirement.openclaw.e2e.test.ts
AGENT_VM_HERMES_E2E=1 mise exec -- pnpm tsx scripts/run-vitest-evidence-project.ts e2e-hermes packages/agent-vm/src/integration-tests/tool-vm-idle-retirement.hermes.e2e.test.ts
mise exec -- pnpm test:e2e:openclaw
mise exec -- pnpm test:e2e:hermes
mise exec -- pnpm test:e2e
pnpm check
```

Every command receipt records exact HEAD, exit code, test/pass/fail/skip counts, and whether the tree was clean. `test:e2e:inventory` is never described as runtime proof.

## Security and reliability constraints

- Preserve the full exact predecessor identity through fence and termination; lease ID alone is insufficient.
- Preserve `retirement_identity_mismatch`, exact-process absence proof, strict SSH, and TCP quarantine.
- Do not print secrets, SSH keys, command bodies, raw unrestricted errors, or environment values in ordered evidence.
- A stale C1 callback cannot erase or publish C2 state.
- Command expiry is non-destructive containment, not cancellation.
- Same-Gateway proof uses exact VM/process identity, not readiness alone.

## Split/replan triggers

Stop implementation and return to the semantic owner if any of these becomes necessary:

- new public/wire result, protocol version, general cancellation framework, supervisor, queue, persistence, retry owner, Gateway restart policy, or framework-specific lifecycle;
- Gondolin/native-handle changes or changed package dependency direction;
- weakening exact identity, exact absence, strict SSH, quarantine, or proof gates;
- destroying an eligible current late lease as timeout compensation;
- composed integration scripting timeout/rotation events rather than exercising the real runtime seam;
- either framework proof cannot exercise its real plugin/Tool Portal/Tool VM/SSH path.

If broad validation fails outside the agreed code path, report scoped proof and stop before editing that external layer.

## Rollback and recovery

The implementation is a hard cutover inside internal owners. There is no compatibility path or migration. Before PR merge, rollback is branch/commit-level. At runtime, a failure to prove predecessor absence remains fenced and quarantined under existing behavior; the implementation must not add compensating destruction or restart behavior.

## Planning completion receipt

```text
phase_result: complete
evidence: reviewed requirements/spec/program hashes; three read-only planning lanes; parent live-source verification; this implementation plan
recommended_next_workflow: shravan-dev-workflow:plan-review-swarm
recommended_transition_reason: the reviewed design is mapped to bounded source-owned slices, red/green proof, live framework gates, and PR freshness without adding lifecycle machinery
```
