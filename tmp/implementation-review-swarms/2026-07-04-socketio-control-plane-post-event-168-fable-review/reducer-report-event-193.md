Event 193 Reducer And Fix Report
================================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 192 advanced the branch to implementation review.
- The subsequent Fable/review pass found accepted issues in Worker failure
  advisory emission, Worker cancel semantics, gateway caller-context session
  binding, and advisory coverage/backpressure proof.

Verdict:
- `review_ready`
- Not PR-ready. Terminal runtime proof and beta proof remain required after the
  next Fable review findings are fixed or explicitly rejected with evidence.

Accepted findings fixed in this pass:

1. Failed Worker tasks bypassed the advisory runtime event path
   - Fixed `packages/agent-vm-worker/src/coordinator/coordinator.ts` so
     `recordTaskFailure()` publishes Worker runtime advisory events after the
     task failure is recorded and waiters are notified.
   - Added integration proof in
     `packages/agent-vm-worker/src/coordinator/coordinator.integration.test.ts`
     that failed tasks emit both failed `worker_runtime_observation` and error
     `worker_runtime_status` events.

2. Worker advisory runtime publishes could become unhandled rejections
   - Fixed `packages/agent-vm-worker/src/coordinator/coordinator.ts` so
     fire-and-forget runtime event publishes are caught and logged.

3. `operation_cancel` reported terminal cancellation before the in-flight Worker
   turn had actually stopped
   - Fixed
     `packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts`
     so a successful controller-originated cancel request returns `accepted`,
     not `cancelled`.
   - Fixed `packages/agent-vm-worker/src/coordinator/coordinator.ts` so
     `closeTask()` no longer frees the active slot immediately. The slot remains
     occupied until the running task exits and the existing finish callback
     clears it.
   - Added integration proof that a closed task remains active while the runner
     is still in flight.

4. Gateway caller contexts were not bound to the accepted control session
   - Fixed
     `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
     so trusted caller contexts include `sessionId` and `connectionId`.
   - The caller-context registry cache key and supersession logic now include
     session/connection identity.
   - Fixed
     `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
     so `lease_create`, lease reads/mutations, active-use lifecycle commands,
     and controller-host actions reject stale caller contexts from a prior
     accepted session.
   - Updated existing direct test fixtures in controller-host-action and lease
     RPC tests to include trusted session identity.

5. Worker advisory publisher/handler coverage was incomplete
   - Added unit proof in
     `packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts`
     for:
     - `worker_capacity_snapshot` as `latest_wins`;
     - `worker_runtime_status` as `latest_wins`;
     - no `commandId` / `idempotencyKey` on those event envelopes.
   - Added unit proof in
     `packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts`
     that capacity snapshots and runtime status events call observation
     handlers without invoking controller git mutations.

Remaining Fable scrutiny items:

- Advisory `latest_wins` / backpressure semantics still deserve focused review.
  This pass adds coverage for publisher/handler event classes and removes
  obvious unhandled rejection risk, but it does not claim a full peer-side
  bounded coalescing implementation beyond the current control service behavior.
- Terminal OpenClaw, Worker, VM, default e2e, and live beta Discord/OpenClaw
  proof remain pending by design until the next implementation review is clean.

Fresh proof run after fixes:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts`
  - 7 files / 60 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/coordinator/coordinator.integration.test.ts`
  - 1 file / 10 tests passed.
- `pnpm typecheck`
  - Passed all workspace projects.
- `pnpm fmt:check`
  - Passed on 801 files.
- `pnpm lint`
  - Passed with 0 warnings and 0 errors on 732 files.
- `pnpm lint:types`
  - Passed with 0 warnings and 0 errors on 732 files.
- `git diff --check`
  - Passed.
- `pnpm check`
  - 10 passed / 0 failed.
  - Passed build, package-version sync, Zod guard, test taxonomy, portal
    architecture audit, portal export audit, lint, format, type-aware lint, and
    typecheck.

Staged inventory:
- `git diff --cached --name-status`
  - 344 staged paths.
- `git diff --cached --shortstat`
  - 344 files changed, 61527 insertions(+), 20394 deletions(-).

Remaining before PR-ready:
- Run/adjudicate the next Fable implementation review.
- Run terminal runtime gates after accepted Fable findings:
  - `mise exec -- pnpm run test:e2e:openclaw`
  - `mise exec -- pnpm run test:e2e:worker`
  - `mise exec -- pnpm run test:e2e:vm`
  - `mise exec -- pnpm test:e2e`
  - `pnpm check` refresh
  - live `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: complete
evidence: reducer report written at tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-193.md; focused unit/integration/typecheck/static proof and pnpm check passed as listed above
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Accepted post-Event-192 findings are fixed and freshly proven; the next required lifecycle gate is implementation review, not PR wrapup.
