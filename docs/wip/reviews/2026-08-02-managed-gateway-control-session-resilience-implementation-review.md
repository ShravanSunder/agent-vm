# Managed Gateway Control-Session Resilience Implementation Review

Date: 2026-08-02

## Verdict

`ready`

The source-backed, plan-backed, risk-triggered review found three in-scope defects. All three are fixed with focused regression proof. One proposed extra lifecycle contract was rejected because the claimed production state is unreachable and would add unnecessary ownership complexity.

## Accepted findings and disposition

### 1. Non-current accepted terminal could strand durable outage evidence

Severity: important.

Failure: reconnect acceptance during shutdown could close the manager's outage window after the runtime stopped treating that source as current. The accepted terminal was then omitted from both current and durable evidence.

Fix: every closed terminal from a non-current source is now recorded as durable-only evidence; it never updates successor live state.

Proof: `managed-gateway-zone-runtime.unit.test.ts` pauses shutdown, emits the old source's accepted terminal, and asserts one durable-only terminal with no current/live mutation.

### 2. Stale hello rejection could mutate successor health evidence

Severity: important; security validation status: validated.

Failure: an old attempt's pending hello rejection could append failure evidence after a successor attempt was accepted.

Fix: the hello rejection path now checks that the attempt is still current before recording evidence or fencing.

Proof: `gateway-disposable-control-session-client.unit.test.ts` accepts a successor, rejects the old deferred hello, and asserts no new evidence plus the successor's accepted diagnostics.

### 3. Reliability proxy integration test leaked its target listener on failure

Severity: follow-up.

Fix: the test owns and closes both the proxy and target server from `afterEach`.

Proof: the focused proxy integration suite passes and teardown no longer depends on reaching the test's successful final statements.

## Rejected finding

Reviewers proposed making the managed runtime's `controlSession` contract broadly required or treating `control-session-unavailable` as a watchdog failure.

Rejected: production reaches `running` only after an accepted control-session manager is installed. For an exact-current production source the missing-manager branch is unreachable. Adding another lifecycle contract would duplicate an already enforced invariant without repairing a reachable failure path.

## Review proof

- Red/green regression evidence was observed for both important findings before and after the fixes.
- Focused manager and runtime unit proof: 85/85 tests passed after the fixes.
- Focused reliability proxy integration proof: 1/1 test passed after the cleanup.
- Full unit proof: 4302/4302 tests passed.
- Full integration proof: 865/865 tests passed.
- Quality: `pnpm check` passed 15/15 gates; typecheck and `git diff --check` passed.
- Host E2E: 28/28 files, 264/264 tests, zero skipped/todo; `tmp/vitest-results/e2e-host-21231-U3zzvl/results.json`.
- E2E inventory: 2 files/tests passed and 36 files/62 tests were skipped with gates closed. This is inventory evidence only.
- Hermes E2E: 2/2 files, 2/2 tests, zero skipped/todo; `tmp/vitest-results/e2e-hermes-28121-Daya0j/results.json`.
- OpenClaw E2E: 17/17 files, 25/25 tests, zero skipped/todo; `tmp/vitest-results/e2e-openclaw-53602-dkGX7P/results.json`.
- Real VM E2E: 12/12 files, 24/24 tests, zero skipped/todo; `tmp/vitest-results/e2e-vm-8839-Vk9wlV/results.json`.
- No required proof lane was deleted, weakened, or relabeled.

## Source trace

`review_class: source-backed, plan-backed, risk-triggered`

`source_coverage_state: covered`

`source_backed_verdict_attempted: true`

`whole-source-trace: required and completed`

Classifier reason: the change modifies runtime authority, reconnect concurrency, health evidence, Tool VM reachability, and two managed framework paths.

| Obligation | Source anchor | Plan anchor | Implementation anchor | Proof anchor | Reachability | Coverage | False substitute risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1/R2/R5 | specification finite interruption and sleep requirements | T1 | durable manager retry state | >16-attempt and wall-clock unit cases | live | covered | bounded startup proof cannot substitute for post-acceptance recovery |
| R3/R8 | preserve current Gateway and watchdog backstop | T2 | current-source runtime delegation and controller composition | runtime/controller tests | live | covered | health callback presence cannot substitute for self-sustaining dialing |
| R4 | authority and fencing | T1/T2 | attachment generation, current-attempt, source-key fences | stale callback, supersession, and admission tests | live | covered | schema-only identity checks cannot prove stale actors are inert |
| R6/V6 | no replay | T1/T4 | pending-result failure and containment actuator | active-operation containment OpenClaw E2E | live | covered | reconnect success cannot substitute for honest ambiguous outcome |
| R7 | truthful bounded evidence | T3 | health contract, live projection, durable coalescing | contract/store/telemetry/durable-log tests | live | covered | latest health alone cannot prove opening/terminal durable ordering |
| R9/V4 | OpenClaw parity | T4 | common manager plus OpenClaw reliability harness | `e2e-openclaw-53602-dkGX7P` | live | covered | inventory or fake VM would be insufficient |
| R9/V5 | Hermes parity | T4 | common manager plus Hermes managed environment harness | `e2e-hermes-28121-Daya0j` | live | covered | OpenClaw success cannot substitute for Hermes reachability |

Accepted deviation buckets: the three fixed findings were `implementation_defect` and routed to `implementation-execute-plan`. No accepted source, program-design, or plan deviation remains.

## Swarm coverage

- Whole-source/spec trace: completed; its accepted shutdown-evidence finding was fixed.
- Code quality: completed; two important candidates and one cleanup were reduced to the dispositions above.
- Security/contracts/tests: completed; its stale-hello evidence mutation was fixed and no authority bypass, command injection, or secret leakage was found.
- Reliability/concurrency: completed with no findings; speculative synchronous socket-factory failure was not accepted without a production-reachable scenario.
- Parent reducer: inspected the exact current source, regression tests, diff, and proof receipts. Subagent output was treated as candidate evidence, not authority.

## Scope and cruft audit

The implementation stays inside the approved manager/watchdog/evidence/framework-proof boundary. It adds no Gateway-to-controller callback, replacement coordinator, secret or 1Password behavior, power-management behavior, aggregate readiness state, automatic Tool VM probe, public ingress, or unsafe command replay.

Only the canonical specification, program design, implementation plan v2, this review report, and scoped implementation/tests belong in the change. The discarded `implementation-plan.md`, its lane/review artifacts, historical plan ledgers, the unrelated Tool Execution Diagnostics specification, and stale slug-based workflow state are excluded from staging.
