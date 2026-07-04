Event 192 Execution Report
==========================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 191 advanced the branch to implementation review.
- A post-Event-191 implementation audit found that Worker control was still
  too narrow: contracts named runtime observations, capacity snapshots,
  cancellation, and recovery, but the VM/controller implementation primarily
  covered the Worker git RPC path.

Verdict:
- `review_ready`
- Not PR-ready. Terminal runtime proof and beta proof remain required after
  Fable review findings are fixed or explicitly rejected with evidence.

Accepted implementation gap fixed in this pass:

1. Worker control application handling was incomplete
   - Added the VM-side application handler:
     - `packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts`
   - The handler now:
     - accepts `control_ping`;
     - handles controller-originated `operation_cancel` by closing the active
       task through injected dependencies;
     - handles `recovery_command.refresh_runtime_status`;
     - rejects unsupported recovery actions;
     - rejects controller-originated `git_push` / `git_pull_default` because
       those operations are Worker-originated in this cutover.
   - Wired the handler into `packages/agent-vm-worker/src/main.ts`.
   - Added unit proof:
     - `packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts`

2. Worker-originated advisory runtime events had no production emitter
   - Extended
     `packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.ts`
     with `WorkerControlRuntimeEventPublisher`.
   - The Worker now emits:
     - `worker_capacity_snapshot`;
     - `worker_runtime_observation`;
     - `worker_runtime_status`.
   - These are sent as `worker_control` event envelopes with
     `append_only_observation` delivery and no `commandId` /
     `idempotencyKey`.
   - The coordinator publishes capacity snapshots around active-task
     transitions and advisory runtime events from task-event changes.

3. Controller-side Worker runtime observations were not persisted
   - Extended
     `packages/agent-vm/src/controller/control-session/worker-control-domain-handler.ts`
     with optional observation handlers.
   - Wired
     `packages/agent-vm/src/controller/worker-task-runner.ts`
     to append advisory Worker runtime observation/status events to the task
     event log.
   - Advisory runtime events update task `updatedAt` only; they do not mutate
     controller-owned task status or authority.

4. Worker control contract types needed payload exports
   - Exported payload types from
     `packages/worker-control-contracts/src/index.ts` for:
     - `WorkerControlCapacitySnapshotPayload`;
     - `WorkerControlRuntimeObservationPayload`;
     - `WorkerControlRuntimeStatusPayload`.

5. Zone-git policy fixture/typecheck gaps surfaced during proof
   - Updated typed `zoneGit.remote` fixtures to include the required
     protected-branch policy fields.
   - Repaired OpenClaw helper configs that now require explicit agents.
   - Updated one zone-git status expectation to the current
     `agent/zone-files` branch.

Fresh proof run after fixes:

- Focused Worker/control unit set:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/agent-vm-worker/src/state/task-state.unit.test.ts`
  - Result: 5 files / 34 tests passed.
- Focused unit/zone-git proof:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/agent-vm-worker/src/state/task-state.unit.test.ts packages/agent-vm/src/config/system-config.unit.test.ts packages/gateway-interface/src/git-read-allowlist.unit.test.ts packages/gondolin-adapter/src/vm-adapter.unit.test.ts scripts/run-check-gate.unit.test.ts`
  - Result: 9 files / 223 tests passed.
- Controller fixture/unit subset:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.unit.test.ts`
  - Result: 4 files / 69 tests passed after fixture repairs.
- Static proof:
  - `pnpm typecheck` passed across 17 workspace projects.
  - `pnpm lint -- packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts packages/agent-vm-worker/src/main.ts` passed with 0 warnings / 0 errors.
  - `pnpm lint:types -- packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts packages/agent-vm-worker/src/main.ts` passed with 0 warnings / 0 errors.
  - `git diff --cached --check` passed.
- Broad proof:
  - `pnpm check` exited 0 with 10 passed / 0 failed in 29.45s.
  - Passed build, package-version sync, Zod guard, test taxonomy, portal
    architecture audit, portal export audit, lint, format, type-aware lint, and
    typecheck.
  - Lint and type-aware lint both reported 0 warnings / 0 errors.

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
evidence: Event 192 Worker-control implementation gap fixed; focused unit/type/static proof and `pnpm check` passed as listed above
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Worker-control scope gap is fixed and freshly proven; the next required lifecycle gate is implementation review, not PR wrapup.
