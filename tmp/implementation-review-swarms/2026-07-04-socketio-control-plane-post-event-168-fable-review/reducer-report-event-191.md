Event 191 Reducer And Fix Report
================================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 190 advanced the branch to implementation review.
- The subsequent review lanes found a small set of accepted blocker/important
  issues plus terminal proof gaps.

Verdict:
- `review_ready`
- Not PR-ready. Terminal runtime proof and beta proof remain required after
  Fable review findings are fixed or explicitly rejected with evidence.

Accepted findings fixed in this pass:

1. Package export verifier false-green
   - Fixed `scripts/verify-portal-package-exports.ts` to cover the missing
     runtime-consumed root exports reported by the review lanes.
   - Proof:
     - `pnpm exec tsx scripts/verify-portal-package-exports.ts`
     - Result: 21 required imports resolved, 106 named exports present, 2 smoke
       calls passed, 4 deferred imports absent.

2. Gateway/Worker control package descriptions still said placeholder
   - Fixed package descriptions in:
     - `packages/gateway-control-contracts/package.json`
     - `packages/worker-control-contracts/package.json`
   - Proof covered by `pnpm check` package/build/static gates.

3. Gateway `zone_git_push` stale caller-context retry identity
   - Fixed
     `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts`
     so accepted-result retries reuse the pending command identity, but
     stale/absent caller-context retries clear the pending identity and get a
     fresh command/message/idempotency identity.
   - Added unit proof in
     `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts`.
   - Proof:
     - `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts`
     - Result: 1 file / 5 tests passed.

4. `zone_git_push` could push the configured branch when it was `main`
   - Fixed `packages/agent-vm/src/controller/zone-git/zone-git-operations.ts`
     to refuse protected branch names `main` and `master` before the controller
     performs a push.
   - Updated host e2e in
     `packages/agent-vm/src/controller/zone-git/zone-git-operations.host.e2e.test.ts`.
   - Updated OpenClaw zone-git e2e fixture branch in
     `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`.
   - Current limitation for Fable to scrutinize:
     - There is no current `protectedBranches` / protected-pattern config source
       in the repo. This pass fixes the concrete shipped bad default where
       `zoneGit.remote.branch` defaults to `main`, and blocks `master` as the
       other common default. If we want arbitrary configured protected patterns,
       that is a config-contract addition, not just a zone-git operation patch.
   - Proof:
     - `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/controller/zone-git/zone-git-operations.host.e2e.test.ts`
     - Result: 1 file / 5 tests passed.

5. Session-keyed managed Tool Portal entrypoints retained unbounded state
   - Fixed
     `packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts`
     with a bounded LRU-style entrypoint cache. Default cap is 64 entries; tests
     can set a smaller cap.
   - Fixed
     `packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts` so the
     temporary caller-context scope map is one-shot and is deleted after
     entrypoint creation/failure.
   - Added unit proof in
     `packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts`.
   - Proof:
     - `pnpm vitest run --config vitest.config.ts --project unit packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts`
     - Result: 1 file / 2 tests passed.
     - `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts`
     - Result: 1 file / 4 tests passed.

Findings reduced / not accepted as current blockers:

1. Worker control described as git-only
   - Reduced to stale/overbroad.
   - Current contracts include `worker_capacity_snapshot`,
     `worker_runtime_status`, `worker_runtime_observation`,
     `operation_cancel`, and `recovery_command`.
   - Current controller domain handler explicitly rejects inbound
     controller-only `operation_cancel` and `recovery_command`; git operations
     are the production rewired tool path for this cutover.
   - Keep this as a Fable scrutiny item for whether worker-originated runtime
     observations should have an additional production emitter before PR-ready.

2. Required cutover proof lanes not all in default/CI gate
   - Reduced to terminal proof gate, not a code blocker for review readiness.
   - Current `pnpm test:e2e` default covers host Docker, host, VM, and
     VM-mediation lanes.
   - Named OpenClaw and Worker lanes remain explicit terminal gates:
     - `mise exec -- pnpm run test:e2e:openclaw`
     - `mise exec -- pnpm run test:e2e:worker`
   - Live `../shravan-claw-beta` Discord/OpenClaw proof remains terminal.

Fresh proof run after fixes:

- `pnpm exec oxfmt --check packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/agent-vm/src/controller/zone-git/zone-git-operations.ts packages/agent-vm/src/controller/zone-git/zone-git-operations.host.e2e.test.ts packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts scripts/verify-portal-package-exports.ts`
  - Passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts`
  - 1 file / 5 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts`
  - 1 file / 2 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts`
  - 1 file / 4 tests passed.
- `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/controller/zone-git/zone-git-operations.host.e2e.test.ts`
  - 1 file / 5 tests passed.
- `pnpm exec tsx scripts/verify-portal-package-exports.ts`
  - 21 required imports resolved, 106 named exports present, 2 smoke calls
    passed, 4 deferred imports absent.
- `pnpm typecheck`
  - Passed all workspace projects.
- `pnpm lint`
  - Passed with 0 warnings and 0 errors on 730 files.
- `pnpm check`
  - 9 passed / 0 failed.
  - Passed build, package-version sync, Zod guard, test taxonomy, portal
    architecture audit, portal export audit, lint, format, type-aware lint, and
    typecheck.

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
evidence: reducer report written at tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-191.md; focused unit/e2e/export/typecheck proof and pnpm check passed as listed above
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Accepted post-Event-190 blocker/important findings are fixed and freshly proven; the next required lifecycle gate is implementation review, not PR wrapup.
