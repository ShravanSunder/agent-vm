# 2026-07-02 Socket.IO Control Plane Goal Details

## Current Resume Edge - Event 213

Event 213 reduces the fresh implementation-review lanes after Event 212,
accepts two validation regressions, fixes them in checkpoint commit `64a4c98`,
and records fresh proof.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: obtain live `../shravan-claw-beta` actual allowed-user
Discord/OpenClaw inbound proof, then run PR-ready non-merge wrapup. A fresh
Fable/external review may still review `64a4c98`, but the local review lanes'
accepted code findings are fixed.

Review lane result:

- Source/spec trace lane: accepted one PR-readiness blocker: live beta
  Discord/OpenClaw allowed-user inbound proof is still missing.
- Proof/reachability lane: no findings.
- Security/trust lane: no findings.
- Contracts/regression lane: accepted two important validation findings:
  static Tool Portal validation rejected valid zoneGit
  `controller_host_action` configs, and `--mcp-live` treated
  `controller_host_action` as an upstream MCP provider namespace.
- All four reviewer agents were closed after harvesting.

Latest checkpoint result:

- Checkpoint commit `64a4c98` fixes controller-host-action validation:
  - Static materialization validation now passes
    `includeZoneGitControllerHostAction` when an OpenClaw zone has `zoneGit`.
  - Live MCP validation treats `controller_host_action` as a controller-backed
    Tool Portal namespace instead of an upstream MCP provider namespace when
    `zoneGit` is enabled.
  - Regression coverage was added to
    `packages/agent-vm/src/operations/config-validation.integration.test.ts`.
- Regenerated branch inventory from `git diff origin/master...HEAD`:
  - `staged-name-status.txt`: 413 rows.
  - `staged-stat.txt`: 413 files changed, 71080 insertions, 11450 deletions.

Fresh proof:

- Red proof before the fix:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/operations/config-validation.integration.test.ts --reporter=verbose`
  failed only the two new controller-host-action validation tests.
- Focused green proof after the fix:
  the same command passed 1 file / 30 tests.
- Package typecheck passed:
  `pnpm --filter @agent-vm/agent-vm typecheck`.
- Full integration passed:
  `pnpm test:integration`
  passed 28 files / 443 tests.
- Fresh current-head quality gate passed:
  `pnpm check`
  passed 10 checks / 0 failed in 25.40s.
- `pnpm fmt:check` and `git diff --check` passed.

Still not PR-ready:

- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound
  proof remains required.
- PR-ready non-merge wrapup remains required after beta proof.

## Current Resume Edge - Event 212

Event 212 refreshes terminal VM/default e2e and `pnpm check` after two
post-review stale fixture fixes.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: refresh implementation review/Fable over the current branch diff.
If review comes back clean, continue to live `../shravan-claw-beta`
allowed-user Discord/OpenClaw inbound proof and PR-ready non-merge wrapup.

Latest checkpoint result:

- Checkpoint commit `b993f97` aligns
  `openclaw-default-runtime.openclaw.e2e.test.ts` with the hard-cutover single
  trusted managed OpenClaw agent rule.
- Checkpoint commit `05ae556` aligns
  `live-tool-vm-mediated-env.vm.e2e.test.ts` with the same runtime rule while
  leaving multi-agent Tool VM mediated-secret selection proof in the pure unit
  owner.
- Closed reviewer agent `019f302e-b8b2-7312-9b21-5cf67b24d3ea` after it failed
  to settle; previous status was running, so no findings were harvested.
- Regenerated branch inventory from `git diff origin/master...HEAD`:
  - `staged-name-status.txt`: 413 rows.
  - `staged-stat.txt`: 413 files changed, 70820 insertions, 11450 deletions.

Fresh proof:

- Full OpenClaw e2e passed:
  `mise exec -- pnpm run test:e2e:openclaw`
  passed 7 files / 12 tests / 0 skipped / 0 todo.
  Result: `tmp/vitest-results/e2e-openclaw-5669-vFMNLU/results.json`.
- Full Worker e2e passed:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  passed 3 files / 5 tests / 0 skipped / 0 todo.
  Result: `tmp/vitest-results/e2e-worker-23955-UXSfTg/results.json`.
- Focused mediated-env live VM proof passed:
  `live-tool-vm-mediated-env.vm.e2e.test.ts` passed 1 file / 1 test.
- Tool VM secret-selection unit owner passed:
  `tool-vm-secret-selection.unit.test.ts` passed 1 file / 5 tests.
- Full VM e2e passed:
  `mise exec -- pnpm run test:e2e:vm`
  passed 5 files / 9 tests / 0 skipped / 0 todo.
  Result: `tmp/vitest-results/e2e-vm-45468-Dji5pd/results.json`.
- Default e2e passed:
  `mise exec -- pnpm test:e2e`
  passed 4 lanes / 0 failed in 77.92s:
  e2e-host-docker 1 file / 2 tests, e2e-host 22 files / 180 tests,
  e2e-vm 5 files / 9 tests, and e2e-vm-mediation passed.
  Results:
  `tmp/vitest-results/e2e-host-docker-50198-YczXZM/results.json`,
  `tmp/vitest-results/e2e-host-50199-NeLqex/results.json`, and
  `tmp/vitest-results/e2e-vm-50197-vRqLdN/results.json`.
- Fresh current-head quality gate passed:
  `pnpm check`
  passed 10 checks / 0 failed in 25.37s.

Still not PR-ready:

- Implementation review/Fable freshness remains required after this packet
  refresh commit.
- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound
  proof remains required.
- PR-ready non-merge wrapup remains required.

## Current Resume Edge - Event 211

Event 211 fixes Composer/Bugbot follow-up findings after Event 210 and records
fresh full unit, full integration, and `pnpm check` proof.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: refresh implementation review/Fable over the current branch diff.
If review comes back clean, continue to live `../shravan-claw-beta`
allowed-user Discord/OpenClaw inbound proof and PR-ready non-merge wrapup.

Latest checkpoint result:

- Checkpoint commit `8b70b76` fixes Composer/Bugbot follow-up findings:
  multi-agent managed OpenClaw scaffold rejection, stale trusted-agent fixtures,
  non-protected zone-git success fixtures, exact deprecated MCP Portal load-path
  stripping, and active docs/manual multi-agent wording.
- The previous Event 210 checkpoint commit `e8b8e6a` fixes
  `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts`.
- Wired `connectWorkerControlSession()` to
  `workerControlDeliveryPolicyByOperation`, so controller-originated Worker
  control commands derive delivery policy through the real controller client
  instead of failing locally with `no derived delivery policy`.
- Added an integration proof that `connectWorkerControlSession()` sends
  controller-originated `operation_cancel` to the real Worker control service
  and receives the intended hard-rejected `command_result`.
- Updated Gateway and Worker peer control services to clear accepted session
  state and reject pending command-result waiters immediately when the accepted
  socket disconnects.
- Added Gateway and Worker integration proofs for prompt pending-command
  rejection on accepted-socket disconnect.
- Added config validation that rejects multi-agent managed OpenClaw zones
  before runtime/caller-context registration during this hard cutover.
- Updated active OpenClaw architecture docs, system config reference, and
  generated manual template to stop advertising shared multi-agent managed
  OpenClaw zones in this cutover.
- Expanded the portal package export verifier to cover the six omitted
  published `@agent-vm/mcp-portal` subpath exports.

Fresh proof:

- Full unit proof passed:
  `pnpm test:unit`
  passed 241 files / 2110 tests.
- Full integration proof passed:
  `pnpm test:integration`
  passed 28 files / 441 tests.
- Fresh current-head quality gate passed:
  `pnpm check`
  passed 10 checks / 0 failed in 25.52s.
- Focused integration proof passed 3 files / 106 tests.
- Focused host-e2e proof passed 1 file / 55 tests.
- Focused unit/manual/schema proof passed selected Event 211 tests.

Still not PR-ready:

- Implementation review/Fable freshness remains required after this reducer
  commit.
- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound
  proof remains required.
	- PR-ready non-merge wrapup remains required.

## Event 211 Composer/Bugbot Follow-Up Reduction

Completed in this checkpoint:
- Closed the remaining security/review lane
  `019f300f-de5b-7fe0-8123-8a15a1073bf1` after harvesting two findings.
- Fixed accepted review findings and checkpointed them in commit `8b70b76`:
  - Managed OpenClaw init/scaffold now rejects multi-agent
    `--openclaw-agents` during this cutover.
  - Stale OpenClaw test fixtures now declare the single trusted `main` or
    `shravan` agent as appropriate.
  - Gateway zone-git integration success fixtures use non-protected
    `agent/main` instead of `main`.
  - Managed OpenClaw stale MCP Portal load-path stripping now removes only exact
    deprecated `mcp-portal` load targets while preserving unrelated paths such
    as `acme-mcp-portal-bridge`.
  - Active docs/manuals no longer tell users to use same-zone multi-agent
    managed OpenClaw layouts during this cutover.
- Verified Bugbot documentation drift findings against current source:
  - `docs/specs/2026-06-25-tool-portal-composition-contract.md` now treats
    `zones[].toolPortal` as the managed Tool Portal root.
  - The same spec names `runtimePluginConfigs.gondolin.toolPortal` as the
    generated plugin materialization path and bans only stale
    `runtimePluginConfigs["mcp-portal"]`.
  - `docs/architecture/overview.md` already includes
    `control-protocol-contracts`, `gateway-control-contracts`, and
    `worker-control-contracts` in the package graph and responsibility table.
- Regenerated branch inventory from `git diff origin/master...HEAD`:
  - `staged-name-status.txt`: 408 rows.
  - `staged-stat.txt`: 408 files changed, 70655 insertions, 11129 deletions.

Fresh proof:
- `pnpm fmt:check` passed.
- Focused integration proof passed:
  `packages/agent-vm/src/cli/build-command.integration.test.ts`,
  `packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`,
  and
  `packages/agent-vm/src/operations/controller-offline-cleanup.integration.test.ts`
  passed 3 files / 106 tests.
- Focused host-e2e proof passed:
  `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts` passed
  1 file / 55 tests.
- Focused unit/manual/schema proof passed selected tests across
  `agent-vm-entrypoint.unit.test.ts`, `manual-templates.unit.test.ts`, and
  `system-config.unit.test.ts`.
- Previously flaky Tool Portal unit file passed in isolation:
  `managed-tool-portal-runtime.unit.test.ts` passed 1 file / 5 tests.
- Full unit gate passed:
  `pnpm test:unit` passed 241 files / 2110 tests.
- Full integration gate passed:
  `pnpm test:integration` passed 28 files / 441 tests.
- Fresh current-head quality gate passed:
  `pnpm check` passed 10 checks / 0 failed in 25.52s.

Review reducer notes:
- Composer's high-severity stale fixture failures are fixed and full unit is
  green.
- Composer's multi-agent managed OpenClaw runtime concern remains intentionally
  fail-closed for this PR; same-zone multi-agent managed OpenClaw requires
  future controller-signed agent attestation.
- Composer low-severity error-classification concerns remain follow-up
  candidates unless later review promotes them.
- Security lane's substring load-path finding is fixed with host-e2e regression
  coverage.

Still not PR-ready:
- Implementation review/Fable freshness remains required after Event 211.
- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound proof
  remains required.
- PR-ready non-merge wrapup remains required.

## Current Resume Edge - Event 208

Event 208 resolves the fresh Worker terminal proof gap raised by the latest
source/proof review lane after shared `control-session-client.ts` changed.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: reduce the newly accepted implementation review findings, then
refresh focused proof, static proof, review packet evidence, beta
Discord/OpenClaw proof, and PR-ready non-merge wrapup.

Checkpoint result:

- Reran the full Worker e2e gate with the repo-local test OpenAI key mapped to
  the expected Worker e2e environment name in a redacted shell.
- Confirmed the Worker e2e gate now covers the shared control-session client
  after the priority-lane change.
- Refreshed the legacy-named review inventory files from the committed branch
  diff `origin/master...HEAD`.

Fresh proof:

- `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  passed 3 files / 5 tests / 0 skipped / 0 todo in 201.49s.
- Worker result artifact:
  `tmp/vitest-results/e2e-worker-91602-cGthgw/results.json`.
- Branch diff inventory refreshed from `git diff origin/master...HEAD`:
  404 files changed, 69966 insertions, 11059 deletions.

Accepted review findings still open after this checkpoint:

- Runtime/reliability: controller-side Worker control cannot currently send
  the controller-originated `operation_cancel` path that should be rejected by
  the real Worker control service.
- Runtime/reliability: Gateway and Worker peer services should reject
  outstanding pending command results promptly on accepted-socket disconnect
  instead of waiting for long per-command timeouts.
- Security/trust: multi-agent managed OpenClaw zones are still accepted by
  config/docs but fail later at caller-context registration; this should be
  surfaced before runtime use for this cutover.
- Contracts/residue: portal package export verification misses six published
  `@agent-vm/mcp-portal` subpath exports.

Still not PR-ready:

- Accepted implementation review findings above need code/docs fixes or
  evidence-backed rejection.
- Fresh focused proof and `pnpm check` are required after those fixes.
- Implementation review packet and external/Fable review freshness remain
  required after fixes.
- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound
  proof remains required.
- PR-ready non-merge wrapup remains required.

## Current Resume Edge - Event 205

Event 205 resolves the remaining accepted Popper follow-up from the latest
review reduction: controller-issued `operation_cancel` now uses the priority
lane instead of being blocked behind a saturated normal critical queue.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: reduce the stale `live-openclaw-control-link.openclaw.e2e.test`
health/recovery failures, then refresh terminal OpenClaw proof and review
packet evidence before external implementation review.

Checkpoint result:

- Accepted Popper's cancellation/backpressure follow-up as a real transport
  contract gap.
- Added integration coverage proving `operation_cancel` crosses the control
  session while the normal critical command queue is saturated.
- Fixed `isPriorityControlSessionMessage` so `heartbeat` and
  `operation_cancel` bypass the normal pending-capacity lane.
- Rechecked the latest full OpenClaw result artifact:
  `tmp/vitest-results/e2e-openclaw-54278-JiJTJA/results.json`.
  It still fails only the stale `live-openclaw-control-link.openclaw.e2e.test`
  health/recovery assertions, while newer control-session e2e coverage had
  already passed in that run.

Fresh proof:

- Red proof before the classifier fix:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts -t 'preserves the operation_cancel priority lane' --reporter=verbose`
  failed with `control session pending queue overflow: messages=257/256`.
- Green focused proof after the classifier fix:
  same command passed 1 file / 1 selected test / 30 skipped in 609ms.
- Full control-session integration proof passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts --reporter=verbose`
  passed 1 file / 31 tests in 1.06s.

Still not PR-ready:

- Fresh full OpenClaw e2e must pass after the stale health/recovery test is
  reduced or fixed.
- Fresh `pnpm check` is required after this checkpoint.
- Implementation review packet and external/Fable review freshness remain
  required.
- Live `../shravan-claw-beta` actual allowed-user Discord/OpenClaw inbound
  proof remains required.
- PR-ready non-merge wrapup remains required.

## Event 192 Historical Checkpoint

Event 192 resolved the post-Event-191 Worker-control scope gap before rerunning
Fable / implementation-review.

Checkpoint result:

- Added VM-side Worker control application handling for `control_ping`,
  controller-originated `operation_cancel`, and
  `recovery_command.refresh_runtime_status`.
- Rejected controller-originated Worker git commands on the VM side because
  `git_push` and `git_pull_default` remain Worker-originated operations in this
  cutover.
- Added Worker-originated advisory runtime event publishing for capacity
  snapshots, runtime observations, and runtime status.
- Wired the controller Worker domain handler and Worker task runner to persist
  advisory runtime observation/status events without granting task authority.
- Exported the Worker control payload types needed by the runtime seams.
- Repaired typed zone-git fixtures exposed by the fresh typecheck.
- Added execution report:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-192.md`.

Fresh proof:

- Focused Worker/control unit set passed, 5 files / 34 tests.
- Focused Worker/control plus zone-git unit set passed, 9 files / 223 tests.
- Controller fixture/unit subset passed, 4 files / 69 tests.
- `pnpm typecheck` passed across 17 workspace projects.
- Targeted `pnpm lint` and `pnpm lint:types` over the Worker handler/main files
  passed with 0 warnings / 0 errors.
- `git diff --cached --check` passed.
- `pnpm check` exited 0 with 10 passed / 0 failed in 29.45s, including build,
  package-version sync, Zod guard, test taxonomy, portal architecture/export
  audits, lint, format, type-aware lint, and typecheck.

Boundary:

- This is implementation-review/Fable readiness, not PR readiness.
- Terminal runtime e2e and `../shravan-claw-beta` actual Discord/OpenClaw proof
  still need fresh treatment after accepted review findings are fixed or
  explicitly rejected.

phase_result: complete
evidence: Event 192 Worker-control implementation gap fixed, report written,
focused proof and `pnpm check` green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Rerun Fable / implementation-review against the
current staged Event 192 packet before terminal e2e and beta proof refresh.

## Current Resume Edge - Event 184

Event 184 resolves the controller-restart reconnect design gap recorded in
Event 183.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Parent rechecked local `@earendil-works/gondolin@0.12.0` public API and
  DeepWiki evidence:
  - `VM` exposes `VM.create(...)` plus lifecycle instance methods such as
    `enableIngress(...)`, but no public full-VM adoption API for an existing
    session;
  - `listSessions`, `findSession`, and `connectToSession` expose attach IPC;
  - attach IPC is exec/snapshot shaped and rejects lifecycle actions.
- Updated the accepted plan/proof semantics:
  - `RESILIENT-GRACE` now applies to in-process transport/socket flaps while
    the controller process still owns the VM/ingress handle;
  - controller process restart/redeploy is a managed-VM recreate boundary for
    this cutover;
  - same-VM reconnect after controller restart is deferred unless a future
    Gondolin VM-adoption API is specified and proven.
- Updated:
  - `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`;
  - `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`;
  - `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`;
  - `docs/specs/2026-07-02-socketio-control-plane/slices/03-s3-controller-session-runtime.md`;
  - `docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md`.
- Renamed misleading control-session material unit-test descriptions from
  "restart reconnect" to host-only persistence.
- Added reducer report:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-184.md`.
- Refreshed the Fable review packet and copy-paste prompt:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`;
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Refreshed staged inventory:
  357 files changed, 54711 insertions, 10853 deletions against
  `origin/master`.
- Fresh proof:
  - focused unit proof passed, 4 files / 22 tests;
  - `oxfmt --check` over touched TS test files passed;
  - `git diff --check && git diff --cached --check` passed.

Boundary:

- This is implementation-review/Fable readiness, not PR readiness.
- Terminal runtime e2e and `../shravan-claw-beta` actual Discord/OpenClaw proof
  still need fresh treatment after accepted review findings are fixed or
  explicitly rejected.

phase_result: complete
evidence: Event 183 controller-restart gap resolved by narrowing semantics to
recreate-on-controller-restart, artifacts refreshed, focused proof green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Rerun Fable / implementation-review against the
current staged Event 184 packet before terminal e2e and beta proof refresh.

## Current Resume Edge - Event 183

Event 183 records the parent-validated signer-material security fix after the
post-Event-182 review-readiness packet exposed a remaining blocker.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- Fixed the gateway control-session private signer exposure:
  - `gateway-runtime.json` under `zone.gateway.stateDir` no longer accepts or
    stores `controlSession.privateKeyPkcs8Pem`;
  - gateway private signer material is now written to host-only
    `runtimeDir/control-sessions/gateway/<zoneId>/session-material.json`;
  - OpenClaw runtime shutdown deletes the host-only session material alongside
    the gateway runtime record;
  - startup integration coverage proves the guest-visible runtime record has no
    private-key field/text while the controller-only material store contains
    the signer material.
- Added reducer report:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-183.md`.
- Fresh proof:
  - focused unit proof passed, 3 files / 18 tests;
  - focused gateway orchestrator integration proof passed, 1 file / 49 tests;
  - OpenClaw zone runtime unit proof passed, 1 file / 27 tests;
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed;
  - touched-file `oxfmt --check`, `git diff --check`, and
    `git diff --cached --check` passed.

Remaining concern:

- Controller restart reconnect is still not proven by signer persistence alone.
  Current Gondolin 0.12.0 source exposes CLI/session IPC attach and checkpoint
  resume primitives, but I did not find a public TypeScript `VM` API that
  reconstructs a full `ManagedVm` wrapper from an existing session with
  `enableIngress(...)`. This requires a focused implementation/design decision
  before claiming controller-restart reconnect is implemented.

Boundary:

- This is a blocker fix plus proof, not PR readiness.
- Terminal runtime e2e gates and `../shravan-claw-beta` actual Discord/OpenClaw
  proof remain stale after runtime-affecting changes.

phase_result: needs_revision
evidence: signer exposure blocker fixed with focused proof; controller restart
reconnect design gap remains unresolved.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue executing accepted review fixes and
resolve the controller-restart reconnect model before rerunning Fable /
implementation-review.

## Current Resume Edge - Event 182

Event 182 records the post-Event-181 reducer fixes and routes the workflow back
to implementation review / Fable review.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Event 181 accepted blocker and important findings are fixed in the staged
  diff.
- Staged diff has 0 unstaged files and 0 untracked non-ignored files.
- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Staged inventory regenerated from explicit `git diff --cached origin/master`:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`
  and `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Live branch evidence: branch `mcp-portal-better-interface`, HEAD
  `ed40896`, base `origin/master` `479ad73`, 354 files changed, 54151
  insertions, 10847 deletions against `origin/master`.
- Accepted fixes staged:
  - gateway control-session signer material is serialized into the runtime
    record and restored;
  - worker control-session material serialize/deserialize helpers are
    implemented and tested, with full durable worker reconnect persistence still
    outside this cutover's durable worker-task/session scope;
  - active lease operations refresh stale caller context on `absent`;
  - managed SSH Git egress uses trusted repo allowlists and fails closed without
    them;
  - generated lease manual and shipped OpenClaw plugin metadata no longer teach
    stale controller lease API semantics;
  - portal export audit and control-contract JSON Schema equality proof are
    expanded;
  - stale `credentialed-runner-boundary` Vitest alias is removed.
- Fresh proof after Event 181 fixes:
  - focused unit proof passed, 4 files / 25 tests;
  - Worker lifecycle unit proof passed, 1 file / 8 tests;
  - OpenClaw lifecycle host e2e proof passed, 1 file / 53 tests;
  - focused control-session integration proof passed, 3 files / 65 tests;
  - cleanup/schema/audit unit proof passed, 5 files / 47 tests;
  - portal architecture audit passed;
  - portal package export verifier passed;
  - `pnpm lint`, `pnpm lint:types`, `pnpm test:taxonomy`, `pnpm typecheck`,
    `git diff --check && git diff --cached --check`, and `pnpm check` passed.

Boundary:

- This is Fable / implementation-review readiness, not PR readiness.
- Terminal runtime e2e gates and `../shravan-claw-beta` actual Discord/OpenClaw
  proof must still be refreshed after accepted Fable findings are fixed or
  rejected with evidence.

phase_result: complete
evidence: post-Event-181 accepted implementation-review fixes are staged,
review artifacts are refreshed, and focused/static proof is green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Rerun Fable / implementation-review against the
current staged post-Event-181 packet before terminal e2e and beta proof.

## Current Resume Edge - Event 181

Event 181 reduces the post-Event-180 implementation-review swarm and routes the
workflow back to implementation execution.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- Reducer report written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-181.md`.
- Six read-only reviewer lanes completed and were closed:
  whole-source trace `019f2ba1-80ac-7d82-bd8c-3b4de7aff20a`,
  spec/plan compliance `019f2ba1-8564-73b3-ab0b-a97fa318a65c`,
  proof/reachability `019f2ba1-8953-73f0-9227-7c5f655bfc64`,
  security/trust `019f2ba1-8d6d-7b22-9c02-a8d40c06f2fc`,
  reliability/lifecycle `019f2ba1-925e-7b91-8a71-3a0f3f418eac`, and
  contracts/tests/code quality `019f2ba1-96b4-7770-b6e8-e73da66a769d`.
- Accepted blockers:
  control-session reconnect across controller restart is impossible with
  in-memory-only signer material; existing leases lose caller-context authority
  after controller restart because only `lease_create` refreshes absent cached
  caller context.
- Accepted important issues:
  pending command-result waiter timeout race on same-messageId retry; managed
  SSH egress host GitHub SSH-agent read access without production repo
  allowlists; stale Tool VM lease manual HTTP wording; shipped OpenClaw plugin
  manifest "controller lease API" residue; incomplete portal export audit;
  incomplete JSON Schema equality/snapshot proof.
- Accepted proof gaps:
  Worker control e2e uses a fake controller socket rather than the real
  controller-backed git RPC path; terminal e2e and beta Discord/OpenClaw proof
  are stale after later runtime-affecting fixes.
- Accepted follow-up:
  Vitest alias still advertises removed `credentialed-runner-boundary` subpath.

Boundary:

- This is no longer Fable / implementation-review readiness.
- Fix accepted findings, rerun focused proof, refresh the review packet, and
  then rerun implementation-review-swarm before terminal e2e/beta proof.

phase_result: needs_revision
evidence: post-Event-180 implementation-review reducer report accepted blocker
and important implementation/proof findings; all six reviewer agents closed.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation and proof findings
remain after review and must be fixed before another review-ready claim.

## Current Resume Edge - Event 180

Event 180 records the post-Event-179 reducer fixes and routes the workflow back
to implementation review.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Post-Event-179 reducer report written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-180.md`.
- Latest accepted implementation-review fixes are staged with 0 unstaged files
  and 0 untracked non-ignored files.
- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Staged inventory regenerated from explicit `git diff --cached origin/master`:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`
  and `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Live branch evidence: branch `mcp-portal-better-interface`, HEAD
  `ed40896`, base `origin/master` `479ad73`, 351 files changed, 53071
  insertions, 10841 deletions against `origin/master`.
- Fixed post-Event-179 findings: Tool Portal discovery no longer registers
  controller-host-action caller context; controller-host-action caller-context
  registration is lazy at `tool_portal_call`; shippable docs/manual audit scope
  includes `docs/reference/**` and `docs/subsystems/**`; generated manual text
  uses current `{ ok, items, diagnostics? }` Tool Portal response shape; stale
  Worker raw-control docs no longer mention retired push-branches callback
  guidance.
- Focused unit proof passed: 4 files / 16 tests.
- Focused integration proof passed: 3 files / 65 tests.
- Residue proof passed: `scripts/audit-portal-architecture.ts` passed and
  direct grep for `push-branches|worker-push-branches|worker-pull-default`
  across shippable docs/manual roots returned no matches.
- Static proof passed: `pnpm fmt:check`, `pnpm lint`, `pnpm lint:types`,
  `pnpm typecheck`, `git diff --check`, and `git diff --cached --check` all
  exited 0.
- Broad gate passed: `pnpm check` exited 0 with 9 passed / 0 failed including
  build, package-version sync, Zod guard, test taxonomy, portal architecture
  audit, portal export audit, format, type-aware lint, and typecheck.

Boundary:

- This is Fable / implementation-review readiness, not PR-readiness.
- Terminal runtime e2e gates and beta Discord/OpenClaw proof must still be
  refreshed after accepted Fable findings are fixed or rejected with evidence.

phase_result: complete
evidence: post-Event-179 reducer fixes staged, review packet refreshed, focused
proof and `pnpm check` green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Current staged fixes are ready for a fresh
Fable / implementation-review pass before terminal e2e/beta proof and PR-ready
non-merge wrapup.

## Current Resume Edge - Event 179

Event 179 records the post-Event-178 accepted finding fixes and routes the
workflow back to implementation review.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Latest accepted implementation-review fixes are staged with 0 unstaged files
  and 0 untracked non-ignored files.
- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Staged inventory regenerated from explicit `git diff --cached origin/master`:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`
  and `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Live branch evidence: branch `mcp-portal-better-interface`, HEAD
  `ed40896`, base `origin/master` `479ad73`, 344 files changed, 43324
  insertions, 10830 deletions against `origin/master`.
- Fixed accepted Event 178 findings: Worker docs now route git push/pull through
  `worker_control_rpc`; residue audit covers shippable docs/manual surfaces;
  reconnect `resync_required` performs a resync/hello retry; reconnect hello
  timeout stales/closes the session; readiness credential fetch uses the
  control-session connect-budget abort signal; caller-context registry has a
  bounded cap; public `tool_vm_runner` config fails closed until a runtime
  backend exists; lease-side stale caller-context and gateway materialization
  proof rows are refreshed.
- Focused unit proof passed: accepted-finding unit set exited 0 with 7 files /
  48 tests passed.
- Focused integration proof passed:
  `control-session-client.integration.test.ts` exited 0 with 29 tests passed,
  and `gateway-zone-orchestrator.integration.test.ts` exited 0 with 49 tests
  passed.
- Residue proof passed: stale `push-branches` architecture-doc grep returned no
  matches; `scripts/audit-portal-architecture.unit.test.ts` exited 0 with 8
  tests passed; `pnpm exec tsx scripts/audit-portal-architecture.ts` passed.
- Static proof passed: `pnpm fmt:check`, `pnpm lint`, `pnpm lint:types`,
  `pnpm typecheck`, `git diff --check`, and `git diff --cached --check` all
  exited 0.
- Broad gate passed: `pnpm check` exited 0 with 9 passed / 0 failed including
  build, package-version sync, Zod guard, test taxonomy, portal architecture
  audit, portal export audit, format, type-aware lint, and typecheck.

Boundary:

- This is Fable / implementation-review readiness, not PR-readiness.
- Terminal runtime e2e gates and beta Discord/OpenClaw proof must still be
  refreshed after accepted Fable findings are fixed or rejected with evidence.

phase_result: complete
evidence: post-Event-178 accepted findings fixed, staged, review packet
refreshed, focused proof and `pnpm check` green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Current staged fixes are ready for a fresh
Fable / implementation-review pass before terminal e2e/beta proof and PR-ready
non-merge wrapup.

## Current Resume Edge - Event 178

Event 178 reduces the post-Event-177 implementation-review lane outputs and
routes the workflow back to implementation execution.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- Reducer report written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-178.md`.
- Seven reviewer lanes completed and were closed:
  whole-source trace `019f2b4b-2184-7a40-b2d5-ab44ab618b29`,
  implementation proof `019f2b4b-498c-7792-9971-be60e54201c5`,
  security/trust `019f2b4b-71c6-7a32-8aaf-06de7fc4707a`,
  runtime reliability `019f2b4b-99ae-7d90-b76d-08fd6049e27b`,
  contracts/tests `019f2b4b-c061-7322-aec5-5f65de4d7799`,
  recent-fix spot check `019f2b4d-5512-7372-b1d7-844bf3e68be5`, and
  raw-control residue audit `019f2b4d-85c5-71c3-fa3b2a238179`.
- Accepted important findings:
  stale Worker architecture docs still teach retired `push-branches` HTTP
  callback flow; residue audit misses shippable docs/manual surfaces;
  `resync_required` is treated as terminal stale; reconnect hello timeout is
  swallowed; ready credential fetch has no connect-budget abort; caller-context
  registry is unbounded; public `tool_vm_runner` config has no runtime backend;
  lease-side stale caller-context and gateway startup/materialization proof
  rows must be refreshed.

Boundary:

- This is no longer Fable / implementation-review readiness.
- Fix accepted findings, rerun focused proof, refresh the packet, and then
  rerun implementation-review-swarm before terminal e2e/beta proof.

phase_result: needs_revision
evidence: post-Event-177 reducer report accepted important implementation and
proof findings; all seven reviewer agents closed.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation and proof findings remain
after review and must be fixed before another review-ready claim.

## Current Resume Edge - Event 177

Event 177 records the latest accepted implementation-review fixes after Event
176 and routes the workflow back to implementation review.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Latest accepted review findings are staged with 0 unstaged files and 0
  untracked non-ignored files.
- Staged file inventory refreshed from explicit `origin/master` scope:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`.
- Staged stat refreshed from explicit `origin/master` scope:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Live branch evidence:
  branch `mcp-portal-better-interface`, HEAD `ed40896`, base
  `origin/master` `479ad73`, 0 unstaged files, 343 staged files,
  0 untracked non-ignored files.
- Staged diff evidence:
  343 files changed, 42841 insertions, 10798 deletions.
- Latest accepted fixes:
  host-action authorization proof overgrant fixed; MCP Portal agent parity
  startup/materialization fixed; Worker reconnect peer-sequence continuity
  fixed; Tool Portal caller-context cache scope narrowed by zone, purpose,
  agent, workspace, work mount, and session-key digest; stale Worker/raw-control
  docs updated; `scripts/live-sandbox-manual.mjs` deleted.
- Focused unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts`
  exited 0 with 5 files / 40 tests passed.
- Focused config-validation proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/operations/config-validation.integration.test.ts -t "MCP Portal agents" --reporter verbose`
  exited 0 with 1 selected test passed and 27 skipped by filter.
- Focused gateway/worker control integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts`
  exited 0 with 2 files / 34 tests passed.
- Architecture audit proof:
  `pnpm vitest run --config vitest.config.ts --project unit scripts/audit-portal-architecture.unit.test.ts`
  exited 0 with 1 file / 7 tests passed.
- Static proof:
  `pnpm lint` exited 0 with 0 warnings / 0 errors;
  `pnpm typecheck` passed across 17 workspace projects;
  `pnpm lint:types` exited 0 with 0 warnings / 0 errors;
  `git diff --check && git diff --cached --check` exited 0;
  `pnpm check` exited 0 with 9 passed / 0 failed including build,
  package-version sync, Zod guard, test taxonomy, portal architecture/export
  audits, format, type-aware lint, and typecheck.

Boundary:

- This is Fable / implementation-review readiness, not PR-readiness.
- Runtime terminal e2e gates and beta Discord/OpenClaw proof must be refreshed
  again after accepted Fable findings are fixed or rejected with evidence.

phase_result: complete
evidence: latest accepted implementation-review fixes staged; focused unit,
integration, architecture audit, lint, typecheck, lint:types, diff hygiene, and
`pnpm check` are green; Fable packet refreshed with 343-file origin/master
staged inventory.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Current staged fixes are ready for a fresh
Fable / implementation-review pass before terminal e2e/beta proof and PR-ready
non-merge wrapup.

## Current Resume Edge - Event 171

Event 171 records the post-Event-170 blocker fixes and routes the workflow back
to implementation review.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Fresh blocker-fix files are staged with 0 unstaged files and 0 untracked
  files.
- Staged file inventory refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`.
- Staged stat refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Live branch evidence:
  branch `mcp-portal-better-interface`, HEAD `ed40896`, base
  `origin/master` `479ad73`, 0 unstaged files, 292 staged files,
  0 untracked non-ignored files.
- Staged diff evidence:
  292 files changed, 36040 insertions, 19881 deletions.
- Focused unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts`
  exited 0 with 7 files / 58 tests passed.
- Focused integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  exited 0 with 4 files / 105 tests passed.
- Focused OpenClaw zone-git proof:
  `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.
- Focused typecheck proof passed for
  `@agent-vm/control-protocol-contracts`,
  `@agent-vm/gateway-control-contracts`,
  `@agent-vm/worker-control-contracts`, `@agent-vm/agent-vm`,
  `@agent-vm/openclaw-agent-vm-plugin`, and `@agent-vm/agent-vm-worker`.
- Portal export verifier proof:
  `pnpm exec tsx scripts/verify-portal-package-exports.ts` exited 0 with
  20 required imports resolved, 48 named exports present, and 4 deferred
  imports absent.
- Broad static proof:
  `pnpm check` exited 0 with 8 passed / 0 failed, including package-version
  sync, Zod guard, test taxonomy, portal architecture audit, portal export
  audit, format, type-aware lint, and typecheck.
- Diff hygiene:
  `git diff --cached --check` exited 0.

Boundary:

- This is Fable / implementation-review readiness, not PR-readiness.
- Runtime terminal e2e gates and beta Discord/OpenClaw proof must be refreshed
  again after accepted Fable findings are fixed or rejected with evidence.

phase_result: complete
evidence: post-Event-170 blocker fixes staged; focused unit, integration,
OpenClaw zone-git e2e, typecheck, portal export verifier, diff hygiene, and
`pnpm check` are green; Fable packet refreshed.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Current staged fixes are ready for a fresh
Fable / implementation-review pass before PR-ready non-merge wrapup.

## Current Resume Edge - Event 170

Event 170 reduces the post-Event-168 Fable / implementation-review packet and
routes the workflow back to implementation execution.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- Reducer report written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report.md`.
- Five reviewer lanes completed and were closed:
  whole-source trace `019f2a9c-19df-7293-be37-1cf483d8cb0b`,
  implementation proof `019f2a9c-a8db-7fa2-9d3b-16e8d89a6f8a`,
  security/trust `019f2a9c-af6c-74c2-b333-0c26ddb68dbe`,
  runtime/reliability `019f2a9c-b5cd-72e3-8281-72e6e6b404b6`, and
  contracts/tests/PR hygiene `019f2a9c-bc9d-7e20-9ea1-a08986075905`.
- Parent reran focused gateway orchestrator integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts -t 'provisions plugin verifier config and connects the gateway control session after ingress'`.
  It exited 1 because the current test still sends legacy `toolPortalAgentId`
  and omits required `payload.callerContext`.
- Parent reran focused OpenClaw zone-git e2e proof:
  `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`.
  It exited 1 with `Controller host action failed.`
- Parent inspected `scripts/verify-portal-package-exports.ts`; the verifier
  still imports source-mapped `src/*.ts` modules instead of real built/package
  export targets.

Accepted blocker findings:

1. Fresh managed Tool Portal `zone_git_push` fails without a prior lease caller
   context.
2. Managed OpenClaw still lets the plugin choose trusted agent identity.
3. Gateway and Worker peers advance sequence state before accepted ack.
4. Gateway orchestrator integration proof is false on the current tree.

Accepted important findings:

1. Portal export verifier still proves source modules, not shipped exports.
2. Beta Discord/OpenClaw proof is stale relative to current staged runtime.

Accepted follow-ups:

1. Upgrade exceptions can strand consumed credentials without `terminalAtMs`.
2. `scripts/live-sandbox-manual.mjs` still exercises raw
   `controller.vm.host:18800`.
3. `vitest.config.ts` still has a stale deleted-boundary alias.

phase_result: needs_revision
evidence: post-Event-168 review reducer report written; parent reran two
focused proof commands and both failed on current staged tree; accepted
blocker/important findings remain.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Fix accepted blocker/important findings before
rerunning terminal proof and implementation-review-swarm.

## Current Resume Edge - Event 169

Event 169 prepares the fresh post-Event-168 Fable / implementation-review packet
against the current staged tree.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Fresh review packet written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`.
- Copy-paste Fable prompt written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`.
- Staged file inventory captured:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`.
- Staged stat captured:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`.
- Live branch evidence:
  branch `mcp-portal-better-interface`, HEAD `ed40896`, base
  `origin/master` `479ad73`, 0 unstaged files, 291 staged files,
  0 untracked non-ignored files.
- Packet artifact proof:
  review packet 373 lines, copy-paste prompt 70 lines,
  staged-name-status 291 lines, staged-stat 292 lines.
- Current proof:
  `git diff --cached --check` passed.
- Current proof:
  `pnpm check` exited 0 with 8 passed / 0 failed, including package-version
  sync, Zod guard, test taxonomy, portal architecture audit, portal export
  audit, format, type-aware lint, and typecheck.

Boundary:

- This is review-readiness, not PR-readiness. Fable / implementation-review
  findings still need parent reduction and either fixes or evidence-backed
  rejection before PR-ready non-merge wrapup.
- The fresh packet asks reviewers to verify that the Event 168 blocker and
  important findings are fixed in the current staged diff.

phase_result: complete
evidence: fresh post-Event-168 review packet and Fable prompt written, current
staged tree sanity checks passed, and `pnpm check` is green.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Current staged fixes are ready for Fable /
implementation-review-swarm reduction before PR-ready non-merge wrapup.

## Current Resume Edge - Event 161

Event 161 closes the beta Discord/OpenClaw proof gap by using the
deployment-approved cross-bot test path instead of waiting for a manual human
message.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Sent a Discord REST API message from the test `clawfest` bot identity to the
  beta debug channel, mentioning the beta Pulse bot so beta's bot-mention
  policy would accept it.
- Sender identity matched beta's configured allowlist:
  `1508937355816472747`.
- Discord API message id:
  `1522681935779069992`.
- Nonce:
  `socketio-control-proof-20260703T191423Z`.
- Beta OpenClaw log recorded a real inbound Discord message, successful
  preflight, session turn creation, lane processing, message completion, and one
  delivered Discord reply.
- Beta trajectory recorded `trigger: "user"`,
  `messageProvider: "discord"`, session key
  `agent:beta:discord:channel:1505884477535158352`, model completion, success
  artifacts, and assistant reply
  `CONTROL_PROOF_OK socketio-control-proof-20260703T191423Z`.

Fresh proof:

- Sender proof:
  `curl -fsS -H "Authorization: Bot <redacted>" https://discord.com/api/v10/users/@me`
  returned bot id `1508937355816472747`, username `clawfest`, `bot: true`.
- Message send proof:
  `POST https://discord.com/api/v10/channels/1505884477535158352/messages`
  returned message id `1522681935779069992` at
  `2026-07-03T19:14:23.552000+00:00`.
- Log proof:
  `/Users/shravansunder/.agent-vm/runtime/zones/beta/logs/openclaw-2026-07-03.log`
  lines 323, 325, 335, 374, and 376 show inbound Discord id
  `1522681935779069992`, preflight success, `trigger=user`, message processed,
  and one reply delivered.
- Trajectory proof:
  `/Users/shravansunder/.agent-vm/state/beta/agents/beta/sessions/e3e4cfc7-db79-4609-b4b1-e45c41ebe79f.trajectory.jsonl`
  lines 1, 5, 6, and 7 show Discord/user trigger, model completion,
  `finalStatus: success`, and successful session end.

Boundary:

- This is an external Discord API cross-bot inbound proof through actual
  Discord/OpenClaw/beta, not a manually typed human message. It is stronger than
  heartbeat proof and exercises the actual inbound channel route, but reviewers
  should decide whether they require manual human keystroke proof separately.

phase_result: complete
evidence: beta Discord/OpenClaw inbound route proven with external cross-bot
Discord API message, non-heartbeat `trigger=user` Discord trajectory, model
success, and delivered Discord reply.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Accepted implementation fixes and live beta
inbound Discord/OpenClaw proof are now captured; rerun implementation review
against the current branch and proof chain.

## Current Remade Goal - Event 119

This section records the SG lifecycle repo-scoping/spec-disposition fix. The
active Codex host goal object remains active and cannot be text-replaced while
unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- SG now explicitly means the delivered managed VM SSH Git host-boundary policy:
  allow `git-upload-pack` to configured upstream git hosts, deny
  `git-receive-pack` unconditionally, and deny non-git SSH exec.
- The docs/spec/plan/proof no longer claim lifecycle-level per-repo enforcement
  for OpenClaw or Worker builders, because those zone-level builders do not
  receive trusted task/zone repo lists at VM-spec construction time.
- `gondolin-adapter` still supports optional repo allowlisting for future
  callers that do have a trusted repo set, and that helper-level path remains
  covered by adapter unit tests.
- OpenClaw and Worker lifecycle tests now assert delivered VM specs deny
  non-git SSH exec in addition to allowing upload-pack and denying receive-pack.

Fresh proof in this checkpoint:

- Focused SG unit proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gondolin-adapter/src/vm-adapter.unit.test.ts packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
  exited 0 with 2 files / 27 tests passed.
- Focused Worker post-format unit proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
  exited 0 with 1 file / 7 tests passed.
- Focused OpenClaw lifecycle host e2e proof passed:
  `pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
  exited 0 with 1 file / 52 tests passed.
- `pnpm --filter @agent-vm/gondolin-adapter typecheck` exited 0.
- `pnpm --filter @agent-vm/worker-gateway typecheck` exited 0.
- `pnpm --filter @agent-vm/openclaw-gateway typecheck` exited 0.
- Focused `oxfmt --check` exited 0 over touched lifecycle test files.
- `git diff --check` exited 0 over touched SG docs and lifecycle test files.
- Residue scan found no stale claim that lifecycle builders enforce task/zone
  repo allowlists. The remaining `lifecycle-level per-repo enforcement` phrase
  is the explicit non-claim in the implementation plan.

Current resume edge:

- Continue implementation-execute-plan on missing Worker git RPC e2e, missing
  OpenClaw controller-host-action positive e2e, canonical docs/config residue,
  fresh terminal proof after accepted fixes, and another
  implementation-review-swarm.

phase_result: needs_revision
evidence: SG host-boundary policy is now precisely specified as host+verb
enforcement for lifecycle-built VM specs, helper-level repo allowlisting remains
separate, and focused unit/host-e2e/typecheck/format/diff proof passed.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue through the remaining accepted
implementation-review findings before rerunning implementation-review-swarm.

## Current Remade Goal - Event 118

This section records the reconnect/resync semantics fix. The active Codex host
goal object remains active and cannot be text-replaced while unfinished; this
event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- The controller control-session client no longer reuses one immutable hello.
  It builds hello dynamically from the last accepted session id plus
  controller/peer sequence watermarks.
- After reconnect, hello includes `previousSessionId`,
  `lastSeenControllerSequence`, and `lastSeenPeerSequence`.
- Controller-emitted acknowledged messages advance the controller sequence
  watermark; peer-originated dispatched messages advance the peer sequence
  watermark.
- Gateway and Worker VM control services preserve the last accepted session
  fence after socket disconnect so reconnect proof can be evaluated.
- Gateway and Worker VM control services return `resync_required` when a
  replacement socket lacks previous-session or sequence-continuity evidence.
- The controller client treats `resync_required`, `rejected`, and
  `generation_mismatch` hello outcomes as fail-closed stale states instead of
  treating raw Socket.IO reconnect as ready.

Fresh proof in this checkpoint:

- Focused reconnect/resync integration proof passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts`
  exited 0 with 3 files / 35 tests passed.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- `pnpm --filter @agent-vm/agent-vm-worker typecheck` exited 0.
- Focused `oxfmt --check` exited 0 over touched reconnect/resync files.
- `git diff --check` exited 0 over touched reconnect/resync files.
- Residue scan confirmed the old immutable `const hello = buildControlHello(...)`
  pattern is gone from the controller client and the new continuity fields are
  covered in controller, gateway, and worker tests.

Current resume edge:

- Continue implementation-execute-plan on SG lifecycle repo scoping/spec
  disposition, missing Worker git RPC e2e, missing OpenClaw
  controller-host-action positive e2e, canonical docs/config residue, fresh
  terminal proof after accepted fixes, and another implementation-review-swarm.

phase_result: needs_revision
evidence: Reconnect now carries previous-session and sequence evidence, VM
services require continuity before accepting replacement sockets, and
`resync_required` fails closed with focused integration, package typecheck,
format, diff-check, and residue proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue through the remaining accepted
implementation-review findings before rerunning implementation-review-swarm.

## Current Remade Goal - Event 117

This section records the ready-route pre-auth fix. The active Codex host goal
object remains active and cannot be text-replaced while unfinished; this event
plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- Gateway and Worker ready endpoints now require a controller-signed
  `ControlReadyRequestProofSchema` proof before issuing a one-use Socket.IO
  upgrade credential.
- The controller signs ready requests with the same private key material used
  for the later upgrade proof.
- VM-side services verify ready proof identity, generation, controller epoch,
  TTL, and signature before nonce issuance.
- Replayed ready request IDs are rejected before a second credential can be
  minted.
- Unsigned ready calls return 401 and do not mint credentials.
- Raw `issueCredential` is no longer exposed on the public gateway or Worker
  control-service interfaces; it remains only as a private implementation
  helper behind the ready-proof path.

Fresh proof in this checkpoint:

- Focused unit proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/agent-vm-worker/src/server.unit.test.ts`
  exited 0 with 2 files / 25 tests passed.
- Focused integration proof passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
  exited 0 with 3 files / 32 tests passed.
- `pnpm --filter @agent-vm/control-protocol-contracts typecheck` exited 0.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- `pnpm --filter @agent-vm/agent-vm-worker typecheck` exited 0.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- Focused `oxfmt --check` exited 0 over touched ready-preauth files.
- `git diff --check` exited 0 over touched ready-preauth files.
- Residue scan found no public raw `issueCredential` service surface, no direct
  `.issueCredential()` test call, and no unsigned `fetchIssuedCredential(...)`
  helper usage in the ready-preauth service tests. The remaining exported
  `issueCredentialForReadyHeaders` entry point is the Hono route adapter guard.

Current resume edge:

- Continue implementation-execute-plan on reconnect/resync semantics, SG
  lifecycle repo scoping/spec disposition, missing Worker git RPC e2e, missing
  OpenClaw controller-host-action positive e2e, canonical docs/config residue,
  fresh terminal proof after accepted fixes, and another
  implementation-review-swarm.

phase_result: needs_revision
evidence: Ready endpoint nonce issuance is now gated by signed one-use
controller ready proofs with focused unit, integration, package typecheck,
format, diff-check, and residue proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue through the remaining accepted
implementation-review findings before rerunning implementation-review-swarm.

## Current Remade Goal - Event 116

This section records the close-reason vocabulary alignment fix. The active
Codex host goal object remains active and cannot be text-replaced while
unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- `ControlSessionCloseReasonSchema` now matches the accepted protocol
  close-reason vocabulary.
- Runtime queue overflow now marks the session stale with `queue_overflow`
  instead of the drifted `backpressure_overflow` reason.
- Contract tests assert the exact close-reason set and the absence of
  `backpressure_overflow`.

Fresh proof in this checkpoint:

- Focused contract unit proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts`
  exited 0 with 1 file / 11 tests passed.
- Focused runtime integration proof passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
  exited 0 with 1 file / 20 tests passed.
- `pnpm --filter @agent-vm/control-protocol-contracts typecheck` exited 0.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Focused `oxfmt --check` exited 0 over touched close-reason files.
- `git diff --check` exited 0 over touched close-reason files.

Current resume edge:

- Continue implementation-execute-plan on reconnect/resync semantics,
  ready-route pre-auth, SG lifecycle repo scoping/spec disposition, missing
  positive e2e proofs, canonical docs/config residue, and fresh terminal proof
  after accepted fixes.

phase_result: needs_revision
evidence: Close-reason drift fixed with contract unit, runtime integration,
package typecheck, format, and diff-check proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue through the remaining accepted
implementation-review findings before rerunning implementation-review-swarm.

## Current Remade Goal - Event 115

This section records the stale controller lease peek/release CLI/client fix.
The active Codex host goal object remains active and cannot be text-replaced
while unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- The external controller HTTP client no longer exposes `peekLease` or
  `releaseLease`.
- The command tree no longer advertises `agent-vm controller lease peek` or
  `agent-vm controller lease release`.
- `runLeaseCommand` keeps `list` as the diagnostic lease surface and fails
  loudly for legacy direct helper calls to `peek` or `release`.
- The server route-disposition test still proves old `/lease*` routes return
  404, including `GET /lease/:id/peek` and `DELETE /lease/:id`.

Fresh proof in this checkpoint:

- Focused CLI/client unit proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-client.unit.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts packages/agent-vm/src/cli/openclaw-auth-command.unit.test.ts packages/agent-vm/src/cli/ssh-commands.unit.test.ts`
  exited 0 with 5 files / 113 tests passed.
- Focused route-disposition proof passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
  exited 0 with 1 file / 49 tests passed.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Focused `oxfmt --check` exited 0 over touched CLI/client files.
- `git diff --check` exited 0 over touched CLI/client files.

Current resume edge:

- Continue implementation-execute-plan on reconnect/resync semantics,
  ready-route pre-auth, SG lifecycle repo scoping/spec disposition, missing
  positive e2e proofs, close-reason vocabulary drift, canonical docs/config
  residue, and fresh terminal proof after accepted fixes.

phase_result: needs_revision
evidence: Stale lease CLI/client false-success path fixed with focused
CLI/client, route-disposition, typecheck, format, and diff-check proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue through the remaining accepted
implementation-review findings before rerunning implementation-review-swarm.

## Current Remade Goal - Event 112

This section records the fresh terminal proof ladder checkpoint. The active
Codex host goal object remains active and cannot be text-replaced while
unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

Checkpoint result:

- Terminal proof ladder is green through the repo-owned layers.
- `mise exec -- pnpm run test:e2e:openclaw` was already green before Event 111
  with 7 files / 12 tests, 0 skipped, 0 todo.
- `mise exec -- pnpm run test:e2e:worker` is now green with 3 files / 3 tests,
  0 skipped, 0 todo.
- `mise exec -- pnpm run test:e2e:vm` is green with 5 files / 9 tests,
  0 skipped, 0 todo.
- `mise exec -- pnpm test:e2e` is green with 4 lanes passed / 0 failed.
- Final `pnpm check` is green with 8 checks passed / 0 failed.

Fresh proof in this checkpoint:

- Worker e2e result:
  `tmp/vitest-results/e2e-worker-48494-y26RFk/results.json`.
- VM e2e result:
  `tmp/vitest-results/e2e-vm-89894-72WGP7/results.json`.
- Default e2e results:
  `tmp/vitest-results/e2e-host-docker-2115-4LMHpE/results.json`,
  `tmp/vitest-results/e2e-host-2113-g9x9ml/results.json`,
  `tmp/vitest-results/e2e-vm-2114-6koHMI/results.json`,
  `tmp/vitest-results/e2e-vm-mediation-2112-kG3BVk/results.json`.
- Final `pnpm check` result: 8 passed / 0 failed; type-aware lint reported 403
  warnings and 0 errors.

Current resume edge:

- Move to `shravan-dev-workflow:implementation-review-swarm` over the full
  implementation diff and proof chain.
- After review findings are addressed or explicitly rejected with evidence,
  continue to PR-ready non-merge wrapup and `../shravan-claw-beta` actual
  Discord/OpenClaw proof.

Hard boundaries still active:

- No raw `controller.vm.host:18800` control fallback.
- No Worker `CONTROLLER_BASE_URL` callback path.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Worker task submit/state/close stay over ingress HTTP in this cutover.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.
- Do not revert unrelated dirty files.

phase_result: complete
evidence: Terminal proof ladder passed through e2e-openclaw, e2e-worker,
e2e-vm, default e2e, and final `pnpm check`.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Run adversarial implementation review over the
full cutover diff and proof chain before PR-ready wrapup and beta proof.

## Current Remade Goal - Event 111

This section records the terminal Worker e2e gate repair and fresh pass. The
active Codex host goal object remains active and cannot be text-replaced while
unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- The previous full `mise exec -- pnpm run test:e2e:worker` terminal blocker is
  resolved in the current worktree.
- The original failure was caused by the Worker VM local package overlay
  installing `@agent-vm/agent-vm-worker` without local tarballs for new
  unpublished workspace dependencies, so pnpm attempted to fetch
  `@agent-vm/worker-control-contracts` from npm.
- The Worker e2e overlay now installs a local package set for
  `agent-vm-worker`, `control-protocol-contracts`, `worker-control-contracts`,
  `gateway-interface`, `gondolin-adapter`, and `secret-management`.
- A second failure was traced to `AGENT_VM_ZONE_ID` being both normal Worker env
  and worker-control identity input. `AGENT_VM_ZONE_ID` alone no longer enables
  the private Worker control service; worker-control-specific boot fields are
  required.

Fresh proof in this checkpoint:

- Worker package overlay focused integration passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/worker-task-runner.integration.test.ts`
  exited 0 with 1 file / 37 tests passed.
- Worker lifecycle focused unit passed:
  `pnpm vitest run --config vitest.config.ts --project unit packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
  exited 0 with 1 file / 7 tests passed.
- Worker control service focused integration passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts`
  exited 0 with 1 file / 5 tests passed.
- Focused package typechecks passed for `@agent-vm/agent-vm`,
  `@agent-vm/worker-gateway`, and `@agent-vm/agent-vm-worker`.
- `git diff --check -- <worker-overlay touched files>` exited 0.
- `pnpm check` exited 0 with 8 passed / 0 failed before the Worker e2e rerun.
- Full Worker e2e terminal gate passed:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  exited 0 with 3 files / 3 tests, 0 skipped, 0 todo.
- Worker e2e result:
  `tmp/vitest-results/e2e-worker-48494-y26RFk/results.json`.

Current resume edge:

- Continue the terminal proof ladder:
  `mise exec -- pnpm run test:e2e:vm`, `mise exec -- pnpm test:e2e`, and final
  `pnpm check`, then implementation-review-swarm, PR-ready non-merge wrapup,
  and `../shravan-claw-beta` actual Discord/OpenClaw proof.
- `mise exec -- pnpm run test:e2e:openclaw` was already green before this
  checkpoint with 7 files / 12 tests, 0 skipped, 0 todo.
- `mise exec -- pnpm run test:e2e:worker` is now green with 3 files / 3 tests,
  0 skipped, 0 todo.

Hard boundaries still active:

- No raw `controller.vm.host:18800` control fallback.
- No Worker `CONTROLLER_BASE_URL` callback path.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Worker task submit/state/close stay over ingress HTTP in this cutover.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.
- Do not revert unrelated dirty files.

phase_result: complete
evidence: Worker e2e terminal gate passed after local package-overlay and
worker-control env parser fixes.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the remaining terminal proof ladder,
then implementation-review-swarm, PR-ready non-merge wrapup, and beta actual
Discord/OpenClaw proof.

## Current Remade Goal - Event 110

This section records the S5c / OPEN-2 collector fail-closed checkpoint. The
active Codex host goal object remains active and cannot be text-replaced while
unfinished; this event plus `events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- S5c / OPEN-2 is locally complete for the current worktree.
- Managed OpenClaw collector-mode observability now fails closed before
  managed gateway VM creation if it would require raw collector `tcpHosts`.
- The previous positive collector `tcpHosts` fixture was converted into a
  planted fail-closed fixture.
- Gateway observability readiness policy remains separate: degraded/off/skip
  readiness settings do not override the raw TCP hard-cutover ban.

Fresh proof in this checkpoint:

- Focused OpenClaw lifecycle host e2e passed:
  `pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
  exited 0 with 1 file / 51 tests passed.
- Focused gateway orchestrator integration passed:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  exited 0 with 1 file / 48 tests passed.
- Full unit passed:
  `pnpm test:unit` exited 0 with taxonomy plus 231 files / 1996 tests passed.
- Full integration passed:
  `pnpm test:integration` exited 0 with 27 files / 379 tests passed.
- `git diff --check -- <S5c touched files>` exited 0.
- `pnpm check` exited 0 with 8 passed / 0 failed:
  package version sync, zod version guard, taxonomy, portal architecture,
  portal exports, format, type-aware lint, and typecheck.
- Type-aware lint reports 403 existing warnings and 0 errors.

Current resume edge:

- Continue into the terminal proof ladder from the slice index:
  `mise exec -- pnpm run test:e2e:openclaw`,
  `mise exec -- pnpm run test:e2e:worker`,
  `mise exec -- pnpm run test:e2e:vm`, `mise exec -- pnpm test:e2e`,
  `pnpm check`, then `../shravan-claw-beta` actual Discord/OpenClaw proof.
- Preserve the known terminal caveat: full `mise exec -- pnpm run
  test:e2e:worker` previously failed because the no-skip evidence runner saw
  two older skipped live Worker tests. Re-run it fresh before deciding whether
  this is still a blocker.

Hard boundaries still active:

- No raw `controller.vm.host:18800` control fallback.
- No Worker `CONTROLLER_BASE_URL` callback path.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Worker task submit/state/close stay over ingress HTTP in this cutover.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.
- Do not revert unrelated dirty files.

phase_result: complete
evidence: S5c / OPEN-2 fail-closed proof passed with focused lifecycle and
orchestrator tests, full unit, full integration, `git diff --check`, and
`pnpm check`.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue into terminal proof ladder, then
implementation-review-swarm, PR-ready non-merge wrapup, and beta actual
Discord/OpenClaw proof.

## Current Remade Goal - Event 109

This section records the SG / GIT-1 SSH Git egress policy checkpoint and
remakes the active compact goal after current proof. The Codex host goal object
remains active and cannot be text-replaced while unfinished, so this event plus
`events.jsonl` owns the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- SG / GIT-1 is locally complete for the current worktree.
- SG means SSH Git: allow `git-upload-pack`; deny `git-receive-pack`.
- The live VM proof now covers both the positive read path and negative push
  path at the Gondolin host boundary.
- SG remains separate from SWc Worker RPC Rewire.

Fresh proof in this checkpoint:

- Added `@agent-vm/worker-control-contracts` as a workspace dependency of
  `@agent-vm/agent-vm` so current controller Worker control imports build
  through package boundaries.
- `pnpm --filter @agent-vm/agent-vm build` passed after refreshing workspace
  links.
- Added `packages/agent-vm/src/integration-tests/live-git-ssh-egress-policy.vm.e2e.test.ts`
  to prove read-only SSH Git egress with a real upstream VM and Gateway VM.
- Targeted SG VM proof passed:
  `mise exec -- env AGENT_VM_GONDOLIN_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-vm packages/agent-vm/src/integration-tests/live-git-ssh-egress-policy.vm.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.
- Full VM proof passed:
  `mise exec -- pnpm run test:e2e:vm` exited 0 with 5 files / 9 tests, 0
  skipped, 0 todo.
- `git diff --check -- <SG touched files>` exited 0.
- `pnpm check` exited 0 with 8 passed / 0 failed:
  package version sync, zod version guard, taxonomy, portal architecture,
  portal exports, format, type-aware lint, and typecheck.
- Type-aware lint now reports 403 existing warnings and 0 errors; the temporary
  new `no-await-in-loop` warning in the SG e2e helper was fixed before this
  checkpoint.

Honest SG caveat:

- Current implementation supports optional repository allowlisting at the
  adapter helper boundary, but exact per-task repo allowlisting is not fully
  enforceable at zone-level VM-spec creation without a broader model change.
  Delivered zone-level VM specs currently enforce the GitHub read-only verb
  policy, not per-task repository allowlisting.

Current resume edge:

- Continue with the remaining last/removal implementation edge, especially
  S5c / OPEN-2 collector disposition, then terminal proof ladder,
  implementation-review-swarm, PR-ready non-merge wrapup, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof.

Hard boundaries still active:

- No raw `controller.vm.host:18800` control fallback.
- No Worker `CONTROLLER_BASE_URL` callback path.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Worker task submit/state/close stay over ingress HTTP in this cutover.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.
- Do not revert unrelated dirty files.

phase_result: complete
evidence: SG / GIT-1 proof passed with targeted live VM proof, full e2e-vm
proof, `git diff --check`, and `pnpm check`; active host goal text remains
stale on the historical OpenClaw version sentence and cannot be replaced while
unfinished, so this event is the authoritative current state.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue to S5c / OPEN-2 collector disposition
and then terminal proof, implementation review, PR-ready non-merge wrapup, and
beta actual Discord/OpenClaw proof.

## Current Remade Goal - Event 108

This section remakes the active compact goal after the latest compaction and
after the upstream-freshness check. The Codex host goal object remains active
and cannot be text-replaced while unfinished, so the current resume contract is
owned by this orchestrator event plus `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Durable objective:

- Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
  accepted specs and reviewed vertical-slice plan through implementation,
  proof, implementation review, and PR-ready non-merge wrapup.

Fresh upstream status:

- `git fetch origin master` exited 0 on 2026-07-03.
- `origin` HEAD is `master`, not `main`.
- Current `HEAD` is `ed40896`, the prior merge commit that merged
  `origin/master` into `mcp-portal-better-interface`.
- Fetched `origin/master` is `479ad73` and is still an ancestor of `HEAD`, so
  no new merge commit was necessary for the current remote state.

Version rule:

- OpenClaw `2026.6.5` is the minimum accepted runtime for this PR.
- A newer OpenClaw may be selected only when fresh GATE-0a/runtime evidence
  shows it materially helps or is required for plugin `handleUpgrade(req,
  socket, head)` plus pre-101 private auth.
- Stale host-goal or historical workflow text that treats a newer runtime as a
  fixed target is superseded by this rule.

Current resume edge:

- Continue SG / GIT-1 SSH Git egress policy from the current worktree.
- A build-blocker was found during `mise exec -- pnpm run test:e2e:vm` before
  VM tests executed: `packages/agent-vm/src/controller/control-session/worker-control-domain-handler.ts`
  imports `@agent-vm/worker-control-contracts`, but
  `packages/agent-vm/package.json` is missing that workspace dependency.
- First implementation step: add `@agent-vm/worker-control-contracts` to
  `packages/agent-vm/package.json`, then prove `pnpm --filter
  @agent-vm/agent-vm build` before rerunning SG/VM proof.

SG / GIT-1 state:

- SG means SSH Git.
- Allow `git-upload-pack`.
- Deny `git-receive-pack`.
- SG remains separate from SWc Worker RPC Rewire.
- Current implementation provides optional repository allowlisting at the
  adapter helper boundary, but exact per-task repo allowlisting is not fully
  enforceable at zone-level VM-spec creation without a broader model change.
  Record this honestly in SG proof/handoff.

Hard boundaries:

- No raw `controller.vm.host:18800` control fallback.
- No Worker `CONTROLLER_BASE_URL` callback path.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Worker task submit/state/close stay over ingress HTTP in this cutover.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.
- Do not revert unrelated dirty files.

Outstanding proof:

- Rerun SG proof after the package dependency fix:
  `mise exec -- pnpm run test:e2e:vm`.
- Run `git diff --check -- <SG touched files>`.
- Run `pnpm check` after SG code settles.
- Then record the SG checkpoint as Event 109 and continue through OPEN-2,
  terminal proof, implementation-review-swarm, PR-ready non-merge wrapup, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: needs_revision
evidence: active host goal remains text-stale and cannot be replaced while
unfinished; `git fetch origin master` succeeded; `origin/master` is still an
ancestor of `HEAD`; OpenClaw version rule is remade as `2026.6.5` minimum with
newer only by fresh runtime evidence; current SG proof is blocked by missing
`@agent-vm/worker-control-contracts` dependency in `packages/agent-vm`.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Fix the in-scope agent-vm package dependency,
rerun SG/VM proof, then continue the remaining cutover proof ladder.

## Current Remade Goal - Event 107

This section records the SWc Worker RPC Rewire proof-finalization checkpoint.
The active Codex host goal remains open; this is a slice checkpoint, not the
terminal goal.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Checkpoint result:

- SWc Worker RPC Rewire is locally complete for the current worktree.
- Worker git push / pull-default are on Worker control RPC instead of raw
  Worker `CONTROLLER_BASE_URL` / `controller.vm.host:18800` callbacks.
- Worker task submit/state/close remain over ingress HTTP.
- Controller push authority carries `expectedHead` from Worker git push and
  refuses stale heads before pushing.
- SG / GIT-1 remains separate and is not claimed by SWc.

Fresh proof in this checkpoint:

- `git diff --check -- <SWc touched files>` exited 0.
- Raw Worker callback residue scan found only intentional negative assertions
  or historical OpenClaw/generic-policy tests:
  - `worker-lifecycle.unit.test.ts` asserts no `CONTROLLER_BASE_URL` and no
    `controller.vm.host:18800`.
  - `controller-request-policy.unit.test.ts` asserts no
    `worker-push-branches` / `worker-pull-default` policy and retains generic
    old URL policy examples.
  - `gateway-zone-orchestrator.integration.test.ts` retains OpenClaw-side
    historical test references, not live Worker runtime callbacks.
- `pnpm check` exited 0:
  - package version sync passed: 17 `@agent-vm/*` packages synced at `0.0.108`.
  - zod version guard passed.
  - test taxonomy audit passed.
  - portal architecture audit passed.
  - portal package export audit passed: 20 required imports, 47 named exports,
    4 deferred imports absent.
  - format check passed: 781 files.
  - type-aware lint passed with 403 warnings and 0 errors.
  - typecheck passed for the workspace and recursive package typechecks.

Lower-layer SWc proof carried from the compacted implementation handoff and not
rerun in this checkpoint because no SWc product code changed after compaction:

- Focused SWc unit: 3 files / 24 tests passed.
- Focused git push integration: 1 file / 16 tests passed.
- Larger focused SWc unit: 5 files / 34 tests passed.
- Worker control + git integration: 2 files / 21 tests passed.
- Worker task HTTP semantic regression:
  `worker-task-runner.integration.test.ts`, 1 file / 36 tests passed.
- Full integration: 27 files / 379 tests passed.
- Full unit: 231 files / 1993 tests passed.
- `pnpm typecheck` passed.
- `pnpm lint:types` exited 0 with warnings only.
- `pnpm test:taxonomy` passed.

Outstanding terminal proof:

- Full `mise exec -- pnpm run test:e2e:worker` remains blocked because the
  no-skip evidence runner sees two older skipped live Worker tests, even though
  the dedicated Worker control e2e passed in Event 104.
- This remains a terminal proof blocker, not an SWc local-proof failure.

Current resume edge:

- Continue to SG / GIT-1 SSH Git egress policy unless a fresher plan-state
  inspection shows an earlier unblocked required slice.
- SG means SSH Git: allow `git-upload-pack`, deny `git-receive-pack` at the
  host boundary.
- Do not fold SG into SWc retroactively.
- Continue carrying OPEN-2 collector disposition, terminal proof ladder,
  implementation-review-swarm, PR-ready non-merge wrapup, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof as remaining goal gates.

phase_result: complete
evidence: SWc current-worktree proof finalization passed with `git diff
--check` over SWc touched files and `pnpm check` 8/8 gates; compacted handoff
lower-layer unit/integration/typecheck/lint evidence remains valid because no
SWc product code changed after compaction.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue to SG / GIT-1 SSH Git egress policy
or the next unblocked slice from `slices/README.md`, while keeping terminal
e2e-worker no-skip proof outstanding.

## Current Remade Goal - Event 106

This section remakes the active compact goal after the latest compaction and
after the OpenClaw version-rule correction. The Codex host goal object remains
active and cannot be text-replaced while unfinished; `create_goal` was rejected
for that reason. The current resume contract is therefore owned by this
orchestrator event plus `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Durable objective:

- Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
  accepted specs and reviewed vertical-slice plan through implementation,
  proof, implementation review, and PR-ready non-merge wrapup.

Version rule:

- OpenClaw `2026.6.5` is the minimum accepted runtime for this PR.
- A newer OpenClaw may be selected only when fresh GATE-0a/runtime evidence
  shows it materially helps or is required for plugin `handleUpgrade(req,
  socket, head)` plus pre-101 private auth.
- Do not treat stale `2026.6.8`-only plan text as normative. The active plan
  packet has been normalized to the `2026.6.5` minimum rule.

Current resume edge:

- Continue with SWc Worker RPC Rewire proof finalization.
- The compacted implementation handoff reports SWc code changes and focused
  proof already ran for Worker control RPC git push/pull-default, Worker task
  HTTP preservation, unit/integration/typecheck/lint/taxonomy, and full
  unit/integration.
- Before recording SWc complete, rerun the current-worktree proof gates that
  were outstanding after the compacted handoff:
  - `git diff --check -- <SWc touched files>`
  - `pnpm check`
- If those pass, record the SWc checkpoint as the next official transition and
  continue to SG / GIT-1 SSH Git egress policy or the next unblocked slice from
  `slices/README.md`.

SWc boundaries to preserve:

- Worker task submit/state/close stay over ingress HTTP.
- Worker git push / pull-default use Worker control RPC, not raw Worker
  `CONTROLLER_BASE_URL` or `controller.vm.host:18800` callbacks.
- SG / GIT-1 remains separate: SG means SSH Git, allow `git-upload-pack`, deny
  `git-receive-pack` at the host boundary.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.

Outstanding terminal proof:

- Full `mise exec -- pnpm run test:e2e:worker` remains blocked because the
  no-skip evidence runner sees two older skipped live Worker tests, even though
  the dedicated Worker control e2e passed in Event 104.
- Remaining goal gates include SWc proof finalization, SG / GIT-1 SSH Git
  egress policy proof, OPEN-2 collector disposition, terminal proof ladder,
  implementation review, PR-ready non-merge wrapup, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: needs_revision
evidence: host goal object remains active and rejected direct replacement;
current plan packet OpenClaw version anchors were normalized to `2026.6.5`
minimum; compacted implementation handoff says SWc code/proof mostly ran and
current worktree still needs `git diff --check` plus `pnpm check` before SWc is
recorded complete.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume implementation at SWc proof
finalization, then continue through SG, OPEN-2, terminal proof,
implementation-review-swarm, PR-ready wrapup, and beta actual Discord/OpenClaw
proof.

## Current Remade Goal - Event 105

This section remakes the active compact goal after the latest compaction. The
Codex host goal object is still active and cannot be text-replaced while
unfinished, so the current resume contract is owned by this orchestrator event
plus `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Durable objective:

- Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
  accepted specs and reviewed vertical-slice plan through implementation,
  proof, implementation review, and PR-ready non-merge wrapup.

Current resume edge:

- Event 104 remains the latest focused implementation checkpoint: SWb Worker
  VM-side control service cleanup and proof are complete.
- Continue to SWc Worker RPC rewire.
- Remove Worker git-tool raw `CONTROLLER_BASE_URL` / `controller.vm.host:18800`
  callback paths.
- Register controller-side Worker RPC handling for the Worker control session.
- Preserve Worker task submit/state/close over ingress HTTP in this cutover.
- Keep SG / GIT-1 SSH Git receive-pack denial in the SG slice; do not satisfy
  that policy inside SWc.

Required reading before editing SWc:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/10-swb-worker-control-service.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/11-swc-worker-rpc-rewire.md`

Live implementation facts to preserve:

- Worker VM-side control service files exist under
  `packages/agent-vm-worker/src/control-session/`.
- Worker private routes are `GET /__agent-vm/worker-ready` and
  `/__agent-vm/worker-control`.
- `createWorkerControlServiceOptionsFromEnvironment()` must stay absent-safe
  when no Worker control env vars are set and must throw on partial
  configuration.
- Generic controller control-session client already knows
  `/__agent-vm/worker-control`; Worker-specific controller session material and
  connector wiring are still missing.
- Current Worker git tools still use raw HTTP callbacks and belong to SWc.

Hard boundaries:

- No raw `controller.vm.host:18800` control fallback.
- No `CONTROLLER_BASE_URL` Worker callback path after SWc.
- No Socket.IO polling fallback.
- No OpenClaw sidecar control service.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not restore deleted `/lease*` mutation/read routes except the accepted
  `GET /leases` diagnostic.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta`.

Outstanding terminal proof:

- Full `mise exec -- pnpm run test:e2e:worker` remains blocked because the
  no-skip evidence runner sees two older skipped live Worker tests, even though
  the dedicated Worker control e2e passed in Event 104.
- Remaining goal gates include SWc Worker RPC rewire, SG / GIT-1 SSH Git egress
  policy proof, OPEN-2 collector disposition, terminal proof ladder,
  implementation review, PR-ready non-merge wrapup, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: needs_revision
evidence: host goal object remains active; Event 104 is the latest focused
implementation checkpoint; current resume edge is SWc Worker RPC rewire with
Worker task HTTP preserved and SG/GIT-1 kept separate.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume implementation on SWc Worker RPC rewire,
then continue through SG, OPEN-2, terminal proof, implementation-review-swarm,
PR-ready wrapup, and beta actual Discord/OpenClaw proof.

## Current Remade Goal - Event 104

This section records the SWb Worker control-service cleanup/proof checkpoint.
The Codex host goal object is still active and cannot be text-replaced while
unfinished, so the current contract is owned by this orchestrator event plus
`events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented / cleaned in this checkpoint:

- Removed the duplicated Worker control Socket.IO e2e smoke from
  `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`.
- Kept the dedicated Worker control e2e as the single owner:
  `packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`.
- Verified residue: Worker control handshake/socket strings no longer appear in
  `worker-runtime.worker.e2e.test.ts`; they appear only in the dedicated Worker
  control e2e file.
- Preserved the existing Worker runtime smoke task-completion wait improvements
  in `worker-runtime.worker.e2e.test.ts` and removed the new lint warning from
  that touched file.

Fresh proof:

- Format:
  `pnpm exec oxfmt --write packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts packages/agent-vm-worker/src/server.unit.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.ts packages/agent-vm-worker/src/control-session/worker-control-http-server.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm-worker/src/server.ts packages/agent-vm-worker/src/main.ts`
  exited 0.
- Unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/server.unit.test.ts packages/agent-vm-worker/src/main.unit.test.ts`
  exited 0 with 2 files / 17 tests passed.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts`
  exited 0 with 1 file / 5 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/agent-vm-worker typecheck` exited 0.
- Package build:
  `pnpm --filter @agent-vm/agent-vm-worker build` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Dedicated Worker control e2e:
  `AGENT_VM_WORKER_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.
- Lint:
  `mise run lint -- .` exited 0 with 0 errors and 3 existing warnings outside
  the Worker cleanup surface.
- Diff hygiene:
  `git diff --check -- <SWb Worker touched files>` exited 0.
- Residue:
  `rg worker-control|WORKER_CONTROL|ControlHandshake|socket.io-client|control:hello|buildWorkerControlSignaturePayload|activeSocketIoClients packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  found Worker control strings only in the dedicated
  `worker-control-session.worker.e2e.test.ts` file.

Blocked / not full terminal proof:

- `mise exec -- pnpm run test:e2e:worker` exited 1 after the workspace build
  because the e2e-worker evidence project found 2 skipped older live Worker
  tests:
  `worker-runtime.worker.e2e.test.ts` and
  `packages/agent-vm/src/integration-tests/worker-loop.worker.e2e.test.ts`.
- The same wrapper did run and pass
  `worker-control-session.worker.e2e.test.ts` with 1 test passed.
- This keeps the full Worker e2e no-skip gate outstanding for terminal proof,
  but does not contradict the focused SWb control-session proof.

Current resume edge:

- SWb Worker VM-side control service is locally implemented and focused-proof
  clean.
- Continue to SWc Worker RPC rewire:
  remove Worker git-tool raw `CONTROLLER_BASE_URL` callback paths, register
  controller Worker RPC handlers on the S3 seam, preserve task
  submit/state/close ingress HTTP, and keep GIT-1 with SG.

Remaining accepted blockers:

- SWc Worker RPC rewire and git RPC proof.
- Full Worker e2e no-skip proof remains blocked by older skipped live Worker
  tests until their prerequisites or gating are resolved.
- SG / GIT-1 SSH Git egress policy implementation and VM proof.
- OPEN-2 collector fail-closed disposition.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw
  proof.

phase_result: complete
evidence: SWb duplicate Worker control e2e cleanup is complete; focused unit,
integration, typecheck, build, taxonomy, lint, diff hygiene, residue scan, and
dedicated Worker control e2e are green; full e2e-worker wrapper still exits 1
because two older live Worker tests are skipped by the no-skip evidence runner.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue to SWc Worker RPC rewire, then SG,
OPEN-2, terminal proof, implementation review, PR-ready wrapup, and beta actual
Discord/OpenClaw proof.

## Current Remade Goal - Event 103

This section remakes the active compact goal after compaction and supersedes
Event 102 as the current resume edge. The Codex host goal object is still active
and cannot be text-replaced while unfinished, so the current contract is owned
by this orchestrator event plus `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Durable objective:

- Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
  accepted specs and reviewed vertical-slice plan through implementation,
  proof, implementation review, and PR-ready non-merge wrapup.

Current resume edge:

- Event 101 remains the latest fully recorded implementation proof checkpoint
  before Worker control work began.
- Gateway `controller_host_action` for narrow trusted `zone_git_push` is
  implemented and proven.
- Gateway inbound `operation_cancel` and `recovery_command` no longer dead-end;
  they have explicit controller-side rejection disposition.
- Post-compaction handoff plus live file inspection show SWb Worker VM-side
  control service work is present: private readiness, Socket.IO upgrade wiring,
  Worker control service implementation, package dependencies, and focused
  Worker control tests.
- SWb must not be advanced as cleanly recorded until the duplicated
  worker-control e2e additions in `worker-runtime.worker.e2e.test.ts` are
  inspected and likely removed in favor of the dedicated
  `worker-control-session.worker.e2e.test.ts` file.

Required reading before editing the next slice:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/09-swa-worker-control-contracts.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/10-swb-worker-control-service.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/11-swc-worker-rpc-rewire.md`

Current Worker facts from live inspection:

- Worker contracts are present in `packages/worker-control-contracts`.
- Worker VM-side private Socket.IO service files are present under
  `packages/agent-vm-worker/src/control-session/`.
- `GET /__agent-vm/worker-ready` and `/__agent-vm/worker-control` anchors are
  present in the Worker package.
- A dedicated Worker control e2e exists at
  `packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`.
- Similar Worker control e2e helpers/test code also appears in
  `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`; treat this
  as the immediate cleanup target before recording SWb complete.
- Worker raw-control residue still exists in `packages/worker-gateway` and
  `packages/agent-vm-worker` and belongs to SWc.
- Worker task submit/state/close stay ingress HTTP in this cutover.

Fresh proof from the post-compaction handoff, not rerun in this checkpoint:

- Unit: `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/server.unit.test.ts packages/agent-vm-worker/src/main.unit.test.ts`
  exited 0 with 2 files / 17 tests.
- Integration: `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts`
  exited 0 with 1 file / 5 tests.
- Typecheck: `pnpm --filter @agent-vm/agent-vm-worker typecheck` exited 0.
- Build: `pnpm --filter @agent-vm/agent-vm-worker build` exited 0.
- Taxonomy: `pnpm test:taxonomy` exited 0.
- Dedicated Worker control e2e:
  `AGENT_VM_WORKER_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  exited 0 with 1 file / 1 test.
- Full Worker e2e lane remains blocked because existing live Worker task tests
  skipped due missing live prerequisites; that is not proof against the focused
  Worker control e2e, but it remains a terminal-ladder blocker.

Immediate next checkpoint:

- Inspect the diff in `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`.
- Remove redundant Worker control e2e additions from that file if the dedicated
  `worker-control-session.worker.e2e.test.ts` fully owns the smoke.
- Re-run SWb focused gates after cleanup:
  `pnpm exec oxfmt --write <touched Worker files>`,
  `pnpm --filter @agent-vm/agent-vm-worker typecheck`,
  focused Worker unit and integration tests,
  dedicated Worker control e2e,
  `pnpm test:taxonomy`,
  `mise run lint -- .`, and `git diff --check -- <touched files>`.
- Then record SWb complete and continue to SWc Worker RPC rewire.

Remaining accepted blockers:

- Worker control cutover and proof, with SWb cleanup/recording first and SWc
  raw callback removal next.
- Worker control Socket.IO handshake plus git RPC e2e proof.
- SG / GIT-1 SSH Git egress policy implementation and VM proof.
- OPEN-2 collector fail-closed disposition.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw
  proof.

Non-goals and hard boundaries:

- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` mutation/read routes except the
  accepted `GET /leases` diagnostic.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not add Socket.IO polling fallback.
- Do not add an OpenClaw sidecar control service.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not re-expose managed `mcp_portal_*` model-visible compatibility tools.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta` for full-system proof.

phase_result: needs_revision
evidence: post-compaction goal contract remade; Worker control service files and
route/test anchors exist from live inspection; focused SWb proof is carried from
handoff but not rerun in this checkpoint; duplicate Worker control e2e additions
in `worker-runtime.worker.e2e.test.ts` require cleanup before recording SWb
complete.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by cleaning the duplicated Worker e2e
surface and rerunning SWb focused proof, then continue to SWc Worker RPC rewire,
SG, OPEN-2, terminal proof, implementation review, PR-ready wrapup, and beta
actual Discord/OpenClaw proof.

## Current Remade Goal - Event 102

This section remakes the active compact goal after compaction and supersedes
the stale host-goal starting text. The Codex host goal object is still active
and cannot be text-replaced while unfinished, so the current contract is owned
by this orchestrator event plus `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Durable objective:

- Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
  accepted specs and reviewed vertical-slice plan through implementation,
  proof, implementation review, and PR-ready non-merge wrapup.

Current resume edge:

- Event 101 remains the latest implementation proof checkpoint.
- Gateway `controller_host_action` for narrow trusted `zone_git_push` is
  implemented and proven.
- Gateway inbound `operation_cancel` and `recovery_command` no longer dead-end;
  they have explicit controller-side rejection disposition.
- The next safe implementation slice is Worker control service/cutover work,
  beginning with the Worker VM-side private readiness and Socket.IO service
  before removing raw Worker controller callbacks.

Required reading before editing the next slice:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/09-swa-worker-control-contracts.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/10-swb-worker-control-service.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/11-swc-worker-rpc-rewire.md`

Current Worker facts from live inspection:

- Worker contracts are present in `packages/worker-control-contracts`.
- Worker raw-control residue still exists in `packages/worker-gateway` and
  `packages/agent-vm-worker`.
- Worker VM-side private Socket.IO service is not yet implemented.
- Worker git push/pull tools still call controller HTTP routes and must move to
  `worker_control_rpc` in the appropriate slice.
- Worker task submit/state/close stay ingress HTTP in this cutover.

Remaining accepted blockers:

- Worker control cutover and proof.
- Worker control Socket.IO handshake plus git RPC e2e proof.
- SG / GIT-1 SSH Git egress policy implementation and VM proof.
- OPEN-2 collector fail-closed disposition.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw
  proof.

Non-goals and hard boundaries:

- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` mutation/read routes except the
  accepted `GET /leases` diagnostic.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not add Socket.IO polling fallback.
- Do not add an OpenClaw sidecar control service.
- Do not re-expose managed `mcp_portal_*` model-visible compatibility tools.
- Do not print secrets or resolved `op://` references while using
  `../shravan-claw-beta` for full-system proof.

Proof gates still required before terminal completion:

- Each remaining slice must run focused unit/integration/typecheck/lint/taxonomy
  proof appropriate to its touched packages.
- Terminal proof still includes `mise exec -- pnpm run test:e2e:openclaw`,
  `mise exec -- pnpm run test:e2e:worker`,
  `mise exec -- pnpm run test:e2e:vm`, `mise exec -- pnpm test:e2e`,
  `pnpm check`, implementation-review-swarm, PR-ready non-merge wrapup, and
  live `../shravan-claw-beta` actual Discord/OpenClaw proof or an explicit
  blocker for any layer that cannot run.

phase_result: needs_revision
evidence: post-compaction goal contract remade; Event 101 remains the latest
implementation proof checkpoint; active host goal object remains active and was
not marked complete or blocked.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume with Worker control service/cutover work,
then continue through SG, OPEN-2, terminal proof, implementation review,
PR-ready wrapup, and beta actual Discord/OpenClaw proof.

## Current Remade Goal - Event 101

This section records the gateway `operation_cancel` / `recovery_command`
disposition completed after Event 100.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented in this checkpoint:

- Inbound gateway `operation_cancel` no longer throws an unimplemented handler
  error.
- Because the controller-side gateway dispatcher does not yet own an
  active-operation registry, inbound gateway cancel requests return a structured
  rejected `command_result` with `activeOperationId` preserved and safe error
  class `active_operation_not_found`.
- Inbound controller-initiated cancel frames sent by the gateway are rejected as
  `controller_only_operation`.
- Inbound gateway `recovery_command` no longer throws an unimplemented handler
  error.
- `recovery_command` is explicitly rejected as controller-only control on this
  controller-side inbound dispatcher.
- No generic host execution, recovery engine, or fake active-operation state was
  introduced.

Fresh proof:

- Format:
  `pnpm exec oxfmt --write packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  exited 0.
- Unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  exited 0 with 1 file / 15 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Lint:
  `mise run lint -- .` exited 0 with 0 errors and four existing warnings.
- Diff hygiene:
  `git diff --check -- packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  exited 0.
- Check:
  `pnpm check` exited 0 with 8 passed / 0 failed. It reported existing
  type-aware lint warnings, but no errors.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: Gateway `operation_cancel` and `recovery_command` no longer dead-end
as unimplemented in the controller-side dispatcher; they return explicit,
schema-validated rejected `command_result` payloads where controller-owned state
is absent or the operation is controller-only. Focused unit, package typecheck,
taxonomy, lint, diff check, and `pnpm check` are green.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on Worker control, SG, OPEN-2,
terminal proof, and beta actual Discord/OpenClaw proof before rerunning
implementation-review-swarm.

## Current Remade Goal - Event 100

This section records the `controller_host_action` / gateway-control executable
path slice completed after Event 99.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented in this checkpoint:

- Added a narrow gateway-control response shape for sanitized
  `tool_portal_controller_host_action` results.
- Kept the request payload strict: only `actionId: "zone_git_push"`,
  `expectedHead`, and allowed correlation are accepted. Generic host execution
  fields such as `argv`, `cwd`, `env`, `executablePath`, and host path authority
  remain rejected by Zod.
- Added `GatewayControlControllerHostActionOperations` with only
  `pushZoneGit`.
- Routed `tool_portal_controller_host_action` through the domain handler instead
  of throwing unimplemented.
- Missing controller-host-action wiring now returns a structured rejected
  `command_result`, not an unimplemented throw.
- Production `startGatewayZone` wiring now injects a controller-owned
  `zone_git_push` handler into the gateway-control dispatcher.
- The production handler reuses the existing controller-owned `pushZoneGit`
  implementation, zone git operation locks, and trusted controller config
  resolution. It does not reopen the deleted VM-facing HTTP push route.
- `operation_cancel` and `recovery_command` remain separate blockers and were
  not broadened into this slice.

Fresh proof:

- Format:
  `pnpm exec oxfmt --write packages/gateway-control-contracts/src/index.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/gateway/gateway-zone-support.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts packages/agent-vm/src/controller/controller-runtime.ts`
  exited 0.
- Unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  exited 0 with 2 files / 21 tests passed.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  exited 0 with 1 file / 48 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/gateway-control-contracts typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Lint:
  `mise run lint -- .` exited 0 with 0 errors and four existing warnings.
- Diff hygiene:
  `git diff --check -- <touched slice files>` exited 0.
- Check:
  `pnpm check` exited 0 with 8 passed / 0 failed. It reported existing
  type-aware lint warnings, but no errors.
- Unit gate:
  `pnpm test:unit` exited 0 with taxonomy plus 230 files / 1983 tests passed.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `operation_cancel` and `recovery_command` remain contract members without live
  gateway-control handlers.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: The narrow `tool_portal_controller_host_action` path now executes
`zone_git_push` through trusted controller-owned state over gateway-control RPC,
with strict Zod payload validation, structured unconfigured rejection, focused
unit/integration proof, package typechecks, taxonomy, lint, `pnpm check`, and
full unit proof green.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on Worker control, SG,
OPEN-2, and remaining gateway operations before rerunning
implementation-review-swarm.

## Current Remade Goal - Event 99

This section is the current compact goal contract after context compaction and
the explicit request to remake the goal.

The active Codex host goal object remains active and cannot be replaced while
unfinished. Per `orchestrator-goal` precedence, this section and the latest
valid orchestrator-written event in `events.jsonl` supersede stale host goal
wording about earlier starting checkpoints such as upstream merge, GATE-0a, or
already-addressed review blockers.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest proven checkpoint carried forward:

- Event 97 completed gateway-control failed-upgrade throttling with generic
  pre-101 rejection, non-consumption of valid credentials while rate-limited,
  and post-window successful connection proof.
- Event 98 reconciled `command_ack` out of the shared wire contract. Socket.IO
  callback acknowledgements are transport receipt only; semantic completion is
  `command_result`.

Immediate next implementation slice:

- Continue with the remaining accepted blocker for
  `controller_host_action` / full gateway-control executable path.
- Inspect the controller-owned host-action boundary and existing zone git push
  implementation before editing.
- Implement only the smallest safe executable path for
  `actionId: "zone_git_push"` if it can be wired through trusted controller
  state. Do not add generic guest-driven host action execution.
- Keep `operation_cancel` and `recovery_command` separate unless a narrow,
  explicitly proven no-op/rejected behavior is required by the slice.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `controller_host_action` / full gateway-control executable path still
  dead-ends.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

Hard-cutover invariants still active:

- Do not restore deleted `/lease*` mutation/read routes except the accepted
  `GET /leases` diagnostic surface.
- Do not restore health-event/runtime-status HTTP mutation routes.
- Do not reintroduce raw `controller.vm.host:18800` control fallback.
- Do not add Socket.IO polling fallback.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed `mcp_portal_*` model-visible compatibility tools.

phase_result: needs_revision
evidence: Active host goal remains open and not replaceable; Event 97 and Event
98 are the latest proven implementation checkpoints; the next safe execution
edge is the `controller_host_action` / gateway-control executable path blocker.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on the remaining accepted
blockers before rerunning implementation-review-swarm.

## Current Remade Goal - Event 98

This section records the command-ack model reconciliation completed after Event
97.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented in this checkpoint:

- Removed `command_ack` from `ControlMessageKindSchema` and from
  `controlMessageKindDisposition`.
- Removed `ControlCommandAckPayloadSchema` from the shared contract JSON Schema
  export surface.
- Updated the shared Socket.IO control protocol spec to make Socket.IO callback
  acknowledgements the transport receipt surface only. Semantic command
  completion remains `kind: "command_result"`.
- Updated the hard-cutover spec and shared lane packet so implementors no longer
  inherit an unowned `command_ack` wire message requirement.

Fresh proof:

- Unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts`
  exited 0 with 3 files / 22 tests passed.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
  exited 0 with 1 file / 20 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/control-protocol-contracts typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/gateway-control-contracts typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/worker-control-contracts typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Lint:
  `mise run lint -- .` exited 0 with 0 errors and four existing warnings.
- Residue search:
  `rg command_ack ...` finds only the intentional negative spec/test assertions
  that `command_ack` does not exist.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `controller_host_action` / full gateway-control executable path still
  dead-ends.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: `command_ack` was reconciled out of the shared wire contract and
durable specs; Socket.IO callback acks are transport receipt only and
`command_result` remains the semantic completion path. Focused contract tests,
control-session integration, package typechecks, taxonomy, and lint are green.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on remaining accepted blockers
before rerunning implementation-review-swarm.

## Current Remade Goal - Event 97

This section records the failed-upgrade rate-limiting slice completed after
Event 96.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented in this checkpoint:

- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts`
  now tracks failed upgrade attempts in a bounded per-source fixed window.
- Once the source reaches the failed-attempt budget, further upgrades are
  rejected before proof parsing or credential consumption.
- The rejection shape remains the same generic pre-101
  `HTTP/1.1 400 Bad Request` response, so callers do not learn whether the
  failed component was missing headers, query credential material, stale nonce,
  identity mismatch, signature failure, or rate limit.
- Failed-attempt windows expire on the service clock using the same bounded
  nonce TTL window, so a later fresh credential can still connect.

Fresh proof:

- Format:
  `pnpm exec oxfmt --write packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  exited 0.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  exited 0 with 1 file / 5 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Lint:
  `mise run lint -- .` exited 0 with 0 errors and four existing warnings.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `controller_host_action` / full gateway-control executable path still
  dead-ends.
- Explicit wire-level `command_ack` semantics still need implementation or spec
  reconciliation.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: Failed-upgrade throttling landed with generic pre-101 rejection,
non-consumption of valid credentials while rate-limited, post-window successful
connect proof, focused integration proof, package typecheck, taxonomy, format,
and root lint.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on remaining accepted blockers
before rerunning implementation-review-swarm.

## Current Remade Goal - Event 96

This section is the current compact goal contract after context compaction.
The active Codex host goal object is still active and should not be marked
complete or blocked. Per `orchestrator-goal` precedence, this section and the
latest valid orchestrator-written event in `events.jsonl` supersede stale host
goal wording about the starting checkpoint.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Immediate next implementation slice:

- Add failed-upgrade rate limiting/backoff in
  `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts`.
- Prove it in
  `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`.
- Preserve the generic pre-101 failure shape; do not expose which credential,
  identity, route, generation, or proof component failed.

Fresh state carried forward from Event 95:

- Gateway-control hello/session gating, accepted-session envelope identity,
  production session fence registry wiring, caller-context retry, lease TTL
  parity, and bounded ready credential retention have focused proof.
- Stop-hook lint/format errors from Event 94 have been repaired.
- Root lint exits 0 with only existing warnings, and focused gateway-control
  unit/package typecheck proof remains green.

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `controller_host_action` / full gateway-control executable path still
  dead-ends.
- Explicit wire-level `command_ack` semantics still need implementation or spec
  reconciliation.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: Active goal was remade after compaction; host goal object is active
and not replaceable, Event 95 remains the latest implementation proof checkpoint,
and the next safe implementation slice is failed-upgrade rate limiting.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on failed-upgrade rate
limiting, then proceed through remaining accepted blockers before rerunning
implementation-review-swarm.

## Current Remade Goal - Event 95

This section records the stop-hook lint/format repair after Event 94.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

What was fixed:

- Resolved the lint errors introduced in the gateway-control lease client unit
  test by avoiding unsafe optional chaining in assertions.
- Cleaned in-scope gateway-control lint warnings:
  - avoided shadowing `options` in `registerCallerContext`;
  - used `T[]` array syntax for accepted-session waiters;
  - used a `const` timer in `waitForAcceptedSession`.

Fresh proof:

- `mise run lint -- .` exited 0. It still reports four warnings from existing
  branch files, but there are 0 errors.
- `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts`
  exited 0 with 1 file / 2 tests passed.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.

Remaining accepted blockers are unchanged from Event 94:

- Worker control cutover and proof.
- `controller_host_action` / full gateway-control executable path.
- Explicit wire-level `command_ack` semantics or spec reconciliation.
- SG / GIT-1 SSH Git egress policy implementation and VM proof.
- OPEN-2 collector fail-closed disposition.
- Terminal proof ladder and beta actual Discord/OpenClaw proof.

phase_result: needs_revision
evidence: Stop-hook lint errors were repaired and root lint now exits 0; focused
unit and package typechecks remain green.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on remaining Event 94
blockers before rerunning implementation-review-swarm.

## Current Remade Goal - Event 94

This section is the current implementation-execute-plan checkpoint after
addressing a bounded gateway-control correctness subset from Event 93.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Implemented in this checkpoint:

- VM-side gateway control messages now wait for validated `control:hello`
  before an accepted session exists.
- `GatewayControlLeaseClient` and `GatewayControlEventPublisher` now build
  envelopes with live accepted `sessionId` / `connectionId` from the gateway
  control service instead of locally generated long-lived IDs.
- Production gateway control wiring now installs a
  `ControlSessionFenceRegistry` and accepts the gateway session fence from the
  hello response.
- `GatewayControlLeaseClient` invalidates a cached caller context and
  re-registers once when `lease_create` returns `absent` for a cached
  `callerContextId`.
- Gateway-control lease create options now default from
  `systemConfig.leaseIdleTtl`, preserving the old route TTL policy.
- Gateway ready credential records now have bounded terminal retention and
  capacity handling.

Fresh proof:

- Unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/agent-vm/src/controller/leases/openclaw-tool-vm-lease-create-options.unit.test.ts`
  exited 0 with 3 files / 7 tests passed.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  exited 0 with 1 file / 4 tests passed.
- Integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
  exited 0 with 1 file / 20 tests passed.
- Typecheck:
  `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck` exited 0.
- Typecheck:
  `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- Taxonomy:
  `pnpm test:taxonomy` exited 0 with `Test taxonomy audit passed.`
- Formatting:
  `pnpm exec oxfmt --write ...` exited 0 on 12 files.
- Whitespace:
  `git diff --check -- <touched tracked files>` exited 0.

Execution brief:

- `tmp/plan-workflows/2026-07-03-agent-vm-mcp-portal-better-interface-socketio-control-plane/implementation-execute-plan-brief.md`

Remaining accepted blockers:

- Worker control cutover is still not implemented.
- Worker e2e still needs real worker-control handshake + git RPC proof.
- `controller_host_action` / full gateway-control executable path still
  dead-ends.
- Explicit wire-level `command_ack` semantics still need implementation or spec
  reconciliation.
- SG / GIT-1 SSH Git egress policy implementation and VM proof remain.
- OPEN-2 collector fail-closed disposition remains.
- Terminal proof ladder and `../shravan-claw-beta` actual Discord/OpenClaw proof
  remain.

phase_result: needs_revision
evidence: Gateway-control hello/session gating, accepted-session envelope
identity, production session fence registry wiring, caller-context retry,
lease TTL parity, and ready credential bounds were patched with fresh focused
unit, integration, typecheck, taxonomy, formatting, and whitespace evidence.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue execution on remaining Event 93
blockers before rerunning implementation-review-swarm.

## Current Remade Goal - Event 93

This section is the current remade goal contract after all four implementation
review lanes returned and the parent accepted the implementation blockers.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Accepted blockers and important fixes:

- Worker hard cutover is not landed. Production Worker runtime still injects and
  consumes raw controller callbacks:
  - `packages/worker-gateway/src/worker-lifecycle.ts` still sets
    `CONTROLLER_BASE_URL: "http://controller.vm.host:18800"`.
  - `packages/agent-vm-worker/src/coordinator/task-runner.ts` still falls back
    to `process.env.CONTROLLER_BASE_URL ?? "http://controller.vm.host:18800"`.
  - Worker git tools still POST `push-branches` and `pull-default` to
    controller HTTP task routes.
- Worker control-session implementation is missing beyond contracts/client
  constants. The Worker-side VM control service/routes for
  `/__agent-vm/worker-ready` and `/__agent-vm/worker-control` are not landed.
- The fresh Worker e2e report is proof substitution. It covers direct Worker
  runtime smoke and controller-route Worker loop smoke, not Worker Socket.IO
  handshake or Worker `git_push` / `git_pull_default` RPC.
- Gateway-control union is only partially executable. The replacement
  `tool_portal_controller_host_action` / `controller_host_action` path still
  dead-ends, and `operation_cancel` / `recovery_command` are contract members
  without live handlers.
- Gateway control messages can be emitted before validated
  `control:hello`/resync completes. `emitApplicationMessage()` must wait on an
  accepted-session promise, not raw socket connection.
- Gateway RPC frames are not bound to authenticated accepted session identity in
  production wiring. Production must fence every frame by live
  `{bootId, controllerEpoch, peerId, zoneId, sessionId, connectionId}`.
- Cached `callerContextId` can survive controller/session reset and poison
  future `lease_create` calls. Cache must be scoped to accepted session identity
  or invalidated/re-registered on `absent`.
- Gateway-control lease creation ignores `systemConfig.leaseIdleTtl`; the RPC
  path must preserve old route TTL policy semantics.
- Shared control protocol ack semantics are not yet implemented as explicit
  wire-level `command_ack` messages. Socket.IO callback acks can remain
  transport receipt, but the protocol lifecycle needs explicit ack frames or a
  spec revision before implementation can be called conforming.
- Ready/upgrade credential state needs bounded cleanup and failed-handshake
  throttling: delete expired/failed/accepted entries, cap outstanding
  credentials, and rate-limit bad upgrades.
- SG / GIT-1 is still unproven. Add proof that SSH egress allows
  `git-upload-pack` and denies `git-receive-pack`.
- Collector fail-closed remains an explicit OPEN-2 stop-condition row; do not
  claim hard-cutover readiness while collector mode can recreate raw gateway
  `tcpHosts` without the accepted disposition.
- External `../shravan-claw-beta` actual Discord/OpenClaw proof is still
  outstanding and remains required before final PR-ready/done claims.

Immediate implementation checkpoint:

1. Finish SWb/SWc instead of treating SWa contracts as the Worker cutover.
2. Remove Worker raw control surfaces and Worker controller-tools HTTP POST
   callbacks.
3. Add Worker e2e proof for Worker control handshake, `git_push` RPC, and
   `git_pull_default` RPC while task submit/state/close remain ingress HTTP.
4. Finish S7/S4a runtime wiring for `controller_host_action`:
   implement the Tool Portal backend path, emit
   `tool_portal_controller_host_action`, implement the controller-side handler,
   and either implement or remove dead `operation_cancel` /
   `recovery_command` union members.
5. Fix gateway session gating/fencing: no app messages before validated hello,
   and every frame uses accepted live session identity.
6. Fix caller-context cache invalidation and `leaseIdleTtl` parity in the
   gateway-control lease path.
7. Implement explicit wire-level `command_ack` semantics or route back to spec
   if the intended contract is Socket.IO callback ack only.
8. Bound ready credential state and failed upgrade attempts.
9. Add SG / GIT-1 implementation and VM proof.
10. Resolve OPEN-2 collector fail-closed disposition.
11. Rerun focused proof, terminal proof ladder,
    `implementation-review-swarm`, PR-ready wrapup, and beta live proof.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken proof by relabeling direct/runtime absence checks as positive
  control-session, `controller_host_action`, or SG proof.

Review agent hygiene:

- All four completed review agents were closed after collection:
  `019f26d1-a651-7af0-97c0-180622db3e9a`,
  `019f26d1-e92e-7201-878a-f8a809cdff62`,
  `019f26d2-25e2-7ca3-8ab0-dfa27a50127f`, and
  `019f26d2-593c-78d2-8078-422ffbb3c799`.

phase_result: needs_revision
evidence: Four implementation-review lanes returned `not_ready` or important
findings; parent source/report checks accepted Worker raw-control residue,
Worker proof substitution, missing `controller_host_action` executable path,
gateway hello-before-message risk, missing production session fencing,
caller-context cache poisoning, lease TTL policy regression, callback-ack vs
wire-level `command_ack` mismatch, unbounded ready credential state, missing
SG / GIT-1 implementation and proof, OPEN-2 collector stop-condition risk, and
missing beta live proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation blockers route back to
execution before another implementation review, PR-ready wrapup, and beta live
proof.

## Current Remade Goal - Event 92

This section is the current remade goal contract after three implementation
review lanes returned and the parent accepted their implementation blockers.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Accepted blockers and important fixes:

- Worker hard cutover is not landed. Production Worker runtime still injects and
  consumes raw controller callbacks:
  - `packages/worker-gateway/src/worker-lifecycle.ts` still sets
    `CONTROLLER_BASE_URL: "http://controller.vm.host:18800"`.
  - `packages/agent-vm-worker/src/coordinator/task-runner.ts` still falls back
    to `process.env.CONTROLLER_BASE_URL ?? "http://controller.vm.host:18800"`.
  - Worker git tools still POST `push-branches` and `pull-default` to
    controller HTTP task routes.
- Worker control-session implementation is missing beyond contracts/client
  constants. The Worker-side VM control service/routes for
  `/__agent-vm/worker-ready` and `/__agent-vm/worker-control` are not landed.
- The fresh Worker e2e report is proof substitution. It covers direct Worker
  runtime smoke and controller-route Worker loop smoke, not Worker Socket.IO
  handshake or Worker `git_push` / `git_pull_default` RPC.
- Gateway control messages can be emitted before validated
  `control:hello`/resync completes. `emitApplicationMessage()` must wait on an
  accepted-session promise, not raw socket connection.
- Gateway RPC frames are not bound to authenticated accepted session identity in
  production wiring. Production must fence every frame by live
  `{bootId, controllerEpoch, peerId, zoneId, sessionId, connectionId}`.
- Cached `callerContextId` can survive controller/session reset and poison
  future `lease_create` calls. Cache must be scoped to accepted session identity
  or invalidated/re-registered on `absent`.
- Gateway-control lease creation ignores `systemConfig.leaseIdleTtl`; the RPC
  path must preserve old route TTL policy semantics.
- Shared control protocol ack semantics are not yet implemented as explicit
  wire-level `command_ack` messages. Socket.IO callback acks can remain
  transport receipt, but the protocol lifecycle needs explicit ack frames or a
  spec revision before implementation can be called conforming.
- Ready/upgrade credential state needs bounded cleanup and failed-handshake
  throttling: delete expired/failed/accepted entries, cap outstanding
  credentials, and rate-limit bad upgrades.
- SG / GIT-1 is still unproven. Add proof that SSH egress allows
  `git-upload-pack` and denies `git-receive-pack`.

Immediate implementation checkpoint:

1. Finish SWb/SWc instead of treating SWa contracts as the Worker cutover.
2. Remove Worker raw control surfaces and Worker controller-tools HTTP POST
   callbacks.
3. Add Worker e2e proof for Worker control handshake, `git_push` RPC, and
   `git_pull_default` RPC while task submit/state/close remain ingress HTTP.
4. Fix gateway session gating/fencing: no app messages before validated hello,
   and every frame uses accepted live session identity.
5. Fix caller-context cache invalidation and `leaseIdleTtl` parity in the
   gateway-control lease path.
6. Implement explicit wire-level `command_ack` semantics or route back to spec
   if the intended contract is Socket.IO callback ack only.
7. Bound ready credential state and failed upgrade attempts.
8. Add SG / GIT-1 proof.
9. Rerun focused proof, terminal proof ladder, and
   `implementation-review-swarm` before PR-ready wrapup.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by relabeling direct runtime or controller
  route smoke as Worker control-session proof.

Review agent hygiene:

- Completed review agents closed after collection:
  `019f26d1-e92e-7201-878a-f8a809cdff62`,
  `019f26d2-25e2-7ca3-8ab0-dfa27a50127f`, and
  `019f26d2-593c-78d2-8078-422ffbb3c799`.
- Remaining lane `019f26d1-a651-7af0-97c0-180622db3e9a` had not returned at
  the time of this goal remake. Its later result should be reduced into a new
  orchestrator event if it changes the accepted blocker set.

phase_result: needs_revision
evidence: Three implementation-review lanes returned `not_ready` or important
findings; parent source/report checks accepted Worker raw-control residue,
Worker proof substitution, gateway hello-before-message risk, missing
production session fencing, caller-context cache poisoning, lease TTL policy
regression, callback-ack vs wire-level `command_ack` mismatch, unbounded ready
credential state, and missing SG / GIT-1 proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation blockers route back to
execution before another implementation review, PR-ready wrapup, and beta live
proof.

## Current Remade Goal - Event 91

This section is the current remade goal contract after the first
implementation-review lane returned `not_ready` and the parent source check
accepted its blockers.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-review-swarm`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Accepted review blockers:

- Worker hard cutover is not landed. Production Worker runtime still injects and
  consumes raw controller callbacks:
  - `packages/worker-gateway/src/worker-lifecycle.ts` still sets
    `CONTROLLER_BASE_URL: "http://controller.vm.host:18800"`.
  - `packages/agent-vm-worker/src/coordinator/task-runner.ts` still falls back
    to `process.env.CONTROLLER_BASE_URL ?? "http://controller.vm.host:18800"`.
  - `packages/agent-vm-worker/src/work-phase/controller-tools/git-push-tool.ts`
    and `git-pull-default-tool.ts` still POST to controller HTTP task routes.
- Worker control-session implementation is missing beyond contracts/client
  constants. Source search found `worker_control`,
  `/__agent-vm/worker-ready`, and `/__agent-vm/worker-control` only in the plan,
  contracts, and controller client test surface, not in a Worker-side VM control
  service.
- The fresh Worker e2e report is not proof for the required cutover lane. It
  contains only:
  - `worker-runtime.worker.e2e.test.ts`: direct Worker server runtime smoke.
  - `worker-loop.worker.e2e.test.ts`: controller route Worker loop smoke.
  It does not exercise Worker Socket.IO handshake, Worker git push over RPC, or
  Worker pull-default over RPC.
- Shared control protocol ack semantics are not yet implemented as explicit
  wire-level `command_ack` messages. The contracts define `command_ack`, but
  gateway/control runtime currently relies on Socket.IO callback acks through
  `emitWithAck("control:message", ...)`.
- Gateway RPC frames are not yet bound to the accepted authenticated session
  identity in production wiring. The review found the fence logic exists in
  tests, but production `gateway-zone-orchestrator.ts` constructs the dispatcher
  without an active session fence/registry; VM-side emitters also invent or
  cache session IDs rather than using live accepted hello/session metadata on
  every frame.
- Ready/upgrade credential state needs bounded cleanup and failed-handshake
  throttling. The implementation expires records logically but does not delete
  expired/failed/accepted credential entries, and failed upgrade attempts are
  not rate limited.

Accepted proof gap:

- SG / GIT-1 is still unproven. The current VM proof report does not show SSH
  git egress policy coverage for allowing `git-upload-pack` and denying
  `git-receive-pack`.

Immediate implementation checkpoint:

1. Finish SWb/SWc instead of treating SWa contracts as the Worker cutover:
   add the Worker-side control-session server/routes, controller Worker RPC
   handlers, and real Worker git RPC execution path.
2. Remove Worker raw control surfaces:
   `CONTROLLER_BASE_URL`, `controller.vm.host:18800` `tcpHosts`, Worker
   `controller.vm.host` allowed-host preservation, and Worker controller-tools
   HTTP POST callbacks.
3. Add Worker e2e proof that explicitly covers Worker control handshake,
   `git_push` over `worker_control_rpc`, and `git_pull_default` over
   `worker_control_rpc`, while Worker task submit/state/close continue over
   ingress HTTP for this cutover.
4. Implement or reconcile explicit wire-level `command_ack` semantics so the
   implementation matches `ControlEnvelopeSchema` and the shared protocol spec.
5. Wire production session fencing for gateway control:
   bind every gateway RPC frame to the accepted
   `{bootId, controllerEpoch, peerId, zoneId, sessionId, connectionId}` and
   reject mismatches after reconnect/restart.
6. Bound private-ready credential state:
   delete expired/failed/consumed records, cap outstanding credentials, and add
   failed-upgrade rate limiting/backoff.
7. Add SG / GIT-1 proof for SSH egress git read policy:
   allow `git-upload-pack`, deny `git-receive-pack`.
8. Rerun focused unit/integration/e2e proof for these fixes, then repeat the
   terminal proof ladder before another implementation-review pass.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by relabeling direct runtime or controller
  route smoke as Worker control-session proof.

phase_result: needs_revision
evidence: One implementation-review lane returned `not_ready`; parent source
checks confirmed Worker raw controller callback residue, missing Worker-side
control-session implementation, Worker proof substitution, callback-ack vs
wire-level `command_ack` mismatch, missing production gateway session fencing,
unbounded ready credential retention/rate limiting, and missing SG / GIT-1
proof.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation blockers route back to
execution; finish Worker control cutover, gateway session fencing, explicit ack
semantics, credential bounds, and SG proof before rerunning implementation
review and PR-ready wrapup.

## Current Remade Goal - Event 90

This section is the current remade goal contract after clearing the Worker
direct-runtime taxonomy blocker and rerunning the Worker terminal e2e gate.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-review-swarm`.

What was fixed:

- `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts` no longer
  uses a wall-clock polling helper for direct-runtime task completion.
- The direct-runtime smoke waits on the task JSONL filesystem watcher and the
  Worker process-exit event, then validates terminal state through the Worker
  HTTP `/tasks/:taskId` protocol endpoint.
- The watcher shutdown is non-blocking so a completed task result is not hidden
  by `fs.promises.watch()` iterator cleanup.
- `packages/openclaw-agent-vm-plugin/openclaw.plugin.json` was formatted with
  `oxfmt`; this was a required `pnpm check` format-gate cleanup on an already
  changed in-scope OpenClaw plugin file.

Proof completed in this edge:

- `pnpm test:taxonomy`: exit 0; `Test taxonomy audit passed.`
- `pnpm --filter @agent-vm/agent-vm-worker typecheck`: exit 0.
- Focused Worker direct-runtime e2e:
  `AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- env AGENT_VM_WORKER_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts --reporter verbose`
  exited 0 with 1 file / 1 test in 76.45s.
- `pnpm check`: exit 0; check gate 8 passed / 0 failed.
- Full Worker gate:
  `AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  exited 0 with 2 files / 2 tests, 0 skipped, 0 todo.
- Worker report:
  `tmp/vitest-results/e2e-worker-5141-wPSfSI/results.json`.

Previously proven terminal-gate artifacts still present:

- Broad OpenClaw terminal gate:
  `tmp/vitest-results/e2e-openclaw-38588-WmjesO/results.json`.
- VM e2e:
  `tmp/vitest-results/e2e-vm-96468-2E8vmJ/results.json`.
- Default e2e proof reports:
  `tmp/vitest-results/e2e-host-docker-8647-58kfil/results.json`,
  `tmp/vitest-results/e2e-host-8646-Vs9aWw/results.json`,
  `tmp/vitest-results/e2e-vm-8648-0dO8lo/results.json`, and
  `tmp/vitest-results/e2e-vm-mediation-8645-bvKDnV/results.json`.

Immediate next checkpoint:

1. Run `shravan-dev-workflow:implementation-review-swarm` over the current
   branch diff and proof packet.
2. Address accepted review findings through `implementation-execute-plan`.
3. Continue to PR-ready non-merge wrapup and external
   `../shravan-claw-beta` proof with actual Discord/OpenClaw before any final
   done claim.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by skipping the direct runtime smoke.

phase_result: complete
evidence: Worker e2e completion wait now satisfies taxonomy and preserves the
direct runtime smoke; taxonomy, Worker typecheck, focused Worker runtime e2e,
`pnpm check`, and full Worker e2e are green with fresh evidence.
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: The known implementation proof blocker is fixed
and the required quality/Worker gates are green; run implementation review
before PR-ready wrapup and beta live proof.

## Current Remade Goal - Event 89

This section is the current remade goal contract after VM/default e2e proof and
the `pnpm check` taxonomy failure.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, fixing the
Worker direct-runtime e2e observation helper before continuing the terminal
proof ladder.

Current blocker:

- `pnpm test:taxonomy` exits 1 because
  `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts` uses
  wall-clock `setTimeout` polling in `waitForWorkerTaskStatePollInterval()`.
- `pnpm check` therefore cannot pass until the Worker e2e wait observes a real
  process, filesystem, protocol, or VM event instead of sleeping.
- Do not weaken `scripts/audit-test-taxonomy.ts`, skip the direct Worker runtime
  smoke, or relabel the e2e proof.

What is already proven at this edge:

- Broad OpenClaw terminal gate passed:
  `mise exec -- pnpm run test:e2e:openclaw`, 7 files / 12 tests, 0 skipped,
  0 todo; report `tmp/vitest-results/e2e-openclaw-38588-WmjesO/results.json`.
- Worker debug lane resolved by upgrading `packages/agent-vm-worker` to
  `@openai/codex-sdk@^0.142.5`; `pnpm-lock.yaml` resolves the SDK/native Codex
  packages to `0.142.5`.
- Worker package typecheck currently exits 0:
  `pnpm --filter @agent-vm/agent-vm-worker typecheck`.
- Full Worker e2e previously passed:
  `mise exec -- pnpm run test:e2e:worker`, 2 files / 2 tests, 0 skipped,
  0 todo; report `tmp/vitest-results/e2e-worker-55631-jD6qDm/results.json`.
- VM e2e report exists at
  `tmp/vitest-results/e2e-vm-96468-2E8vmJ/results.json`.
- Default e2e proof reports exist at:
  `tmp/vitest-results/e2e-host-docker-8647-58kfil/results.json`,
  `tmp/vitest-results/e2e-host-8646-Vs9aWw/results.json`,
  `tmp/vitest-results/e2e-vm-8648-0dO8lo/results.json`, and
  `tmp/vitest-results/e2e-vm-mediation-8645-bvKDnV/results.json`.

Immediate implementation checkpoint:

1. Replace `waitForWorkerTaskStatePollInterval()` with an event/protocol-driven
   completion wait. Prefer filesystem append/watch events plus immediate
   `/tasks/:taskId` rechecks, or a real Worker protocol event if one already
   exists.
2. Run `pnpm test:taxonomy`.
3. Run `pnpm --filter @agent-vm/agent-vm-worker typecheck`.
4. Rerun the focused Worker direct-runtime e2e with the required env mapping:
   `AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- env AGENT_VM_WORKER_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts --reporter verbose`.
5. Rerun `pnpm check`.
6. If green, record a new orchestrator event and continue to implementation
   review, PR-ready non-merge wrapup, and `../shravan-claw-beta` proof with
   actual Discord/OpenClaw where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by skipping the direct runtime smoke.

phase_result: needs_revision
evidence: VM/default e2e proof artifacts exist and Worker package typecheck
currently passes, but `pnpm test:taxonomy` exits 1 because
`worker-runtime.worker.e2e.test.ts` uses a wall-clock `setTimeout` polling
helper for task completion.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Fix the Worker e2e completion wait to be driven
by real filesystem/protocol/process events, then rerun taxonomy, Worker focused
proof, `pnpm check`, implementation review, PR-ready wrapup, and beta actual
Discord/OpenClaw proof.

## Current Remade Goal - Event 88

This section is the current remade goal contract after resolving the Worker e2e
debug lane.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, continuing
the terminal proof ladder with VM e2e.

What was fixed:

- The original Worker gate failure timed out in the direct worker runtime smoke.
- A focused diagnostic first exposed local `@openai/codex` native binary
  `ENOENT`; `pnpm install --frozen-lockfile --force` restored the binary.
- After the binary was restored, `@openai/codex-sdk@0.130.0` still produced zero
  SDK stream events for 60s with the same model/options.
- `packages/agent-vm-worker` now depends on `@openai/codex-sdk@^0.142.5`.
- With `0.142.5`, the same SDK diagnostic emitted `thread.started`,
  `turn.started`, `agent_message: READY`, and `turn.completed` in about 7s.
- The direct worker runtime e2e wait helper now observes terminal state through
  the worker HTTP task endpoint with a named bounded poll interval instead of
  relying on lossy `fs.watch` terminal append delivery.

Proof completed:

- `pnpm --filter @agent-vm/agent-vm-worker typecheck`: exit 0.
- Focused SDK diagnostic with `@openai/codex-sdk@0.142.5`: exit 0, 4 stream
  events, `READY`, about 7s.
- Focused Worker runtime e2e:
  `AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- env AGENT_VM_WORKER_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts --reporter verbose`
  exited 0 with 1 file / 1 test.
- Full Worker gate:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  exited 0 with 2 files / 2 tests, 0 skipped, 0 todo.
- Worker report:
  `tmp/vitest-results/e2e-worker-55631-jD6qDm/results.json`.

Immediate implementation checkpoint:

1. Continue the terminal proof ladder with `mise exec -- pnpm run test:e2e:vm`.
2. Then run `mise exec -- pnpm test:e2e`.
3. Then run `pnpm check`.
4. Then proceed to implementation review, PR-ready non-merge wrapup, and
   `../shravan-claw-beta` proof with actual Discord/OpenClaw where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by skipping the direct runtime smoke.

phase_result: complete
evidence: Worker debug lane resolved by upgrading `@openai/codex-sdk` from
`^0.130.0` to `^0.142.5`, replacing the lossy direct-runtime e2e `fs.watch`
wait with bounded HTTP task-state polling, and proving focused SDK, focused
Worker runtime e2e, Worker package typecheck, and full Worker e2e.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Worker terminal proof is now green; continue the
terminal proof ladder with VM e2e.

## Current Remade Goal - Event 87

This section is the current remade goal contract after the Worker direct-runtime
smoke timeout was narrowed to a local `@openai/codex` native binary install
failure.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:debug-investigation`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, after the
focused direct-worker diagnostic is rerun against the repaired local install and
the Worker proof path either passes or exposes a scoped implementation failure.

What changed after Event 86:

- A narrower standalone direct-worker diagnostic exposed the masked inner
  failure:
  `spawn .../@openai/codex/vendor/aarch64-apple-darwin/codex/codex ENOENT`.
- `pnpm install --frozen-lockfile` did not repair the missing native binary.
- `pnpm install --frozen-lockfile --force` restored the executable Codex native
  binary at:
  `node_modules/.pnpm/@openai+codex@0.130.0-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex`.
- `test -x` now confirms that binary is executable.
- The forced install also changed `pnpm-lock.yaml`; inspect it as normal
  implementation diff rather than blindly reverting it, because the lockfile may
  be catching up to package manifest changes from the current branch.

Immediate debug checkpoint:

1. Rerun the same focused standalone direct-worker diagnostic that previously
   produced `ENOENT`.
2. If the diagnostic passes, update the debug artifact and return to
   `shravan-dev-workflow:implementation-execute-plan`.
3. Then rerun the Worker gate with the required env mapping:
   `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`.
4. If the diagnostic fails differently, follow the new concrete failure and do
   not skip, weaken, or relabel the Worker proof.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by skipping the direct runtime smoke.

phase_result: needs_revision
evidence: Worker e2e failed at the direct worker-runtime smoke, then the focused
diagnostic narrowed the masked inner failure to missing local
`@openai/codex` native binary `ENOENT`. `pnpm install --frozen-lockfile --force`
restored the executable binary; the diagnostic still needs to be rerun.
recommended_next_workflow: shravan-dev-workflow:debug-investigation
recommended_transition_reason: Rerun the focused diagnostic against the repaired
install before resuming implementation proof, then rerun Worker e2e without
weakening the gate.

## Current Remade Goal - Event 86

This section is the current remade goal contract after the Worker e2e terminal
gate failed.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:debug-investigation`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, after the
Worker direct-runtime smoke timeout is explained and any scoped fix is made.

What just failed:

- Command:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
- Result: exit 1.
- JSON report:
  `tmp/vitest-results/e2e-worker-75274-AdrSK5/results.json`
- Passed:
  `packages/agent-vm/src/integration-tests/worker-loop.worker.e2e.test.ts`,
  1 file / 1 test, about 171s.
- Failed:
  `packages/agent-vm-worker/src/worker-runtime.worker.e2e.test.ts`, 1 file /
  1 test, timed out at the 900s Vitest test timeout.
- The failed run had 0 skipped tests and 0 todo tests; this is a real runtime
  failure, not a gate-shape failure.

Observed failure seam:

- The direct worker-server smoke accepted task `worker-only-smoke`.
- The leftover task event log showed:
  - `task-accepted`
  - `phase-started` with `phase: "plan"`
- No `plan-agent-turn`, `plan-finalized`, `phase-completed`, work phase, wrapup
  phase, terminal state, or `READY.txt` was observed.
- The test-level 900s timeout fired before the test catch could preserve
  `worker.log`, so the current proof has task-state evidence but not direct
  stdout/stderr from the worker process.

Immediate debug checkpoint:

1. Use `shravan-dev-workflow:debug-investigation`.
2. Keep investigation read-only until the root cause is sufficiently proven.
3. Compare direct worker-server smoke against the controller-mediated Worker e2e
   that passed in the same broad gate.
4. Prove whether the timeout is:
   - a direct-runtime Codex executor hang before `plan-agent-turn`,
   - missing or different env/runtime setup in the direct worker process,
   - test timeout/observability masking an inner worker timeout,
   - or a task-state watcher/server observation bug.
5. Do not skip, weaken, or relabel the Worker e2e proof.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the Worker proof by skipping the direct runtime smoke.

phase_result: needs_revision
evidence: Worker e2e exited 1. The controller-mediated Worker loop passed, but
the direct worker-server runtime smoke timed out at the 900s Vitest timeout
after task acceptance and `phase-started: plan`, with no `plan-agent-turn` or
terminal task state.
recommended_next_workflow: shravan-dev-workflow:debug-investigation
recommended_transition_reason: Investigate the direct worker-runtime smoke
timeout before any implementation edits; resume implementation only after the
failure seam is proven and fixed.

## Current Remade Goal - Event 85

This section is the current remade goal contract after compaction while the
Worker e2e terminal gate is still running.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, beginning
with the already-running Worker e2e terminal gate session.

Live gate edge:

- Worker e2e is running in Codex command session `76481`.
- Command:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
- This env mapping is intentional: repo-local `.env.local` currently provides
  `OPEN_AI_TEST_KEY`, while the Worker e2e gate expects
  `AGENT_VM_TEST_OPENAI_API_KEY`.
- First poll after compaction showed:
  - `worker-loop.worker.e2e.test.ts` passed, 1 file / 1 test.
  - `worker-runtime.worker.e2e.test.ts` is still active.
  - Overall progress at poll time: 1 passed test out of 2; no final Worker gate
    result yet.

Immediate implementation checkpoint:

1. Poll Codex command session `76481`; do not start another Worker e2e gate
   while it is active.
2. If Worker e2e passes, record the Worker gate result in this workflow state
   and continue:
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm check`
   - implementation review
   - PR-ready non-merge wrapup
   - `../shravan-claw-beta` proof with actual Discord and actual OpenClaw
     where required
3. If Worker e2e fails, inspect the latest `tmp/vitest-results/e2e-worker-*`
   JSON report and debug only the scoped Worker failure path. Do not skip,
   weaken, or relabel the Worker proof.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade. Only move newer if
  concrete runtime evidence shows a newer OpenClaw materially reduces
  implementation risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the subagent lease proof to avoid the normalized-workMountDir
  invariant.

phase_result: needs_revision
evidence: Broad OpenClaw terminal gate already passed. Worker e2e has been
started with the required `.env.local` key mapping and is still running in Codex
session `76481`; one Worker e2e test has passed and the direct worker runtime
smoke remains active.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue polling the active Worker e2e gate
instead of restarting it; record the Worker result only after the active session
exits.

## Current Remade Goal - Event 84

This section is the current remade goal contract after the broad OpenClaw
terminal gate passed.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, beginning
with the Worker e2e terminal gate.

What just changed:

- The fresh broad OpenClaw gate in Codex session `4184` completed successfully.
- Command:
  `mise exec -- pnpm run test:e2e:openclaw`
- Result:
  - exit 0
  - 7 files passed
  - 12 tests passed
  - 0 skipped
  - 0 todo
  - JSON report:
    `tmp/vitest-results/e2e-openclaw-38588-WmjesO/results.json`
- The previously flaky broad subagent proof passed inside the full OpenClaw
  run:
  `openclaw-subagent-lease.openclaw.e2e.test.ts`, 1 file / 1 test passed.

Immediate implementation checkpoint:

1. Record no more OpenClaw work unless a later gate reopens that surface.
2. Continue the terminal proof ladder:
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm check`
3. If a later gate fails, debug only the scoped failing path and preserve the
   hard-cutover invariants.
4. After terminal gates, run implementation review, PR-ready non-merge wrapup,
   and the `../shravan-claw-beta` proof with actual Discord and actual
   OpenClaw where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade. Only move newer if
  concrete runtime evidence shows a newer OpenClaw materially reduces
  implementation risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the subagent lease proof to avoid the normalized-workMountDir
  invariant.

phase_result: needs_revision
evidence: The broad OpenClaw terminal gate passed with exit 0, 7 files / 12
tests, 0 skipped, 0 todo, and report
`tmp/vitest-results/e2e-openclaw-38588-WmjesO/results.json`.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with Worker
e2e, then VM e2e, default e2e, pnpm check, implementation review, PR-ready
wrapup, and beta proof.

## Current Remade Goal - Event 83

This section is the current remade goal contract after compaction and the live
broad OpenClaw gate resume.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, beginning
with the already-running broad OpenClaw terminal gate session.

Why execution is back in implementation:

- Event 82 moved execution into `debug-investigation` after the broad OpenClaw
  gate failed in `openclaw-subagent-lease.openclaw.e2e.test.ts` with a live
  subagent smoke timeout, not the earlier control-session-not-connected failure.
- The focused subagent diagnostic run now passes:
  - command:
    `mise exec -- env AGENT_VM_OPENCLAW_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts --reporter verbose`
  - result: exit 0, 1 file / 1 test passed
- The original broad failure is therefore not deterministic in the isolated
  focused proof. The focused diagnostics remain valuable if the broad run fails
  in the subagent file again.
- A fresh broad OpenClaw gate is already running in Codex session `4184`:
  - command: `mise exec -- pnpm run test:e2e:openclaw`
  - current observed progress at goal remake time: build/image prep completed;
    gateway stability passed; live control-link/recovery passed; OpenClaw MCP /
    Tool Portal file is active.

Immediate implementation checkpoint:

1. Poll Codex command session `4184`; do not start another broad OpenClaw gate
   while it is active.
2. If the broad OpenClaw gate fails:
   - if the failure is again in
     `openclaw-subagent-lease.openclaw.e2e.test.ts`, inspect the diagnostic
     payload added to that test before changing implementation;
   - if the failure is in recovery, stability, Tool Portal, zone git, or a
     different OpenClaw proof file, debug only that scoped path;
   - do not restore old HTTP control surfaces or weaken the hard-cutover proof.
3. If the broad OpenClaw gate passes, record the gate result, then continue the
   terminal proof ladder:
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm check`
4. Then run implementation review, PR-ready non-merge wrapup, and the
   `../shravan-claw-beta` proof with actual Discord and actual OpenClaw where
   required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade. Only move newer if
  concrete runtime evidence shows a newer OpenClaw materially reduces
  implementation risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the subagent lease proof to avoid the normalized-workMountDir
  invariant.

phase_result: needs_revision
evidence: The previous broad OpenClaw failure moved the goal to debug, but the
focused live subagent proof now passes with diagnostics. A fresh broad
`mise exec -- pnpm run test:e2e:openclaw` gate is already running in Codex
session `4184`, with gateway stability and live control-link/recovery observed
green before continuing into the OpenClaw MCP / Tool Portal file.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the active broad OpenClaw gate instead
of restarting earlier slices; debug only the scoped failure if this gate fails.

## Current Remade Goal - Event 82

This section is the current remade goal contract after the focused recovery
fix passed and the broad OpenClaw terminal gate exposed a new live subagent
timeout.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:debug-investigation`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, after the
OpenClaw subagent timeout is explained and any scoped fix is agreed or made.

Why execution is back in debug:

- The scoped `controlSessionDeathGraceMs` fixture/typecheck fallout was fixed.
- The focused local proof after that repair passed:
  - `pnpm --filter @agent-vm/agent-vm typecheck`
  - config and gateway-service-health-monitor unit proof, 2 files / 183 tests
  - focused recovery/runtime unit proof, 3 files / 64 tests
  - targeted `oxfmt --check`
  - focused live recovery OpenClaw e2e, 1 file / 3 tests
- The narrow auto-recovery fix is implemented in
  `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`.
  Auto-recovery can now fall back to identity-fenced host cleanup when graceful
  VM close times out; operator stop remains owner-unsafe.
- The broad OpenClaw gate then failed:
  - command: `mise exec -- pnpm run test:e2e:openclaw`
  - result: exit 1
  - report: `tmp/vitest-results/e2e-openclaw-97930-82A9V7/results.json`
  - passed before failure: gateway stability, live control-link/recovery,
    MCP/Tool Portal surface, control-session upgrade/resync, zone git, default
    runtime
  - failed file:
    `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
  - failed assertion: subagent history did not contain
    `SUBAGENT_LEASE_SMOKE_OK`
  - observed run result: `FailoverError: operation has timed out <- Error:
    operation has timed out`
- This is not the earlier `gateway control session is not connected` failure.
  The failing output shows the subagent was accepted and had a session, then the
  run timed out before producing the expected smoke output.

Immediate debug checkpoint:

1. Use `shravan-dev-workflow:debug-investigation`.
2. Read the failed test and its runtime path:
   - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service-runtime.ts`
   - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-manager.ts`
   - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
   - `packages/agent-vm/src/controller/control-session/`
   - `packages/agent-vm/src/controller/leases/observed-lease-create-request.ts`
3. Determine whether the timeout is:
   - an external/provider/runtime timeout unrelated to the control-plane cutover,
   - a lease/subagent lifecycle regression introduced by the control RPC path,
   - an e2e wait/assertion mismatch after the hard cutover, or
   - a real OpenClaw 2026.6.8 plugin/runtime behavior issue.
4. Preserve the original proof intent: the subagent path must prove normalized
   lease creation without sending `/workspace` as controller `workMountDir`.
5. Do not restore the old HTTP `/lease` mutation path, raw controller callback,
   or any test-only replacement route to make this green.

Current proof status:

- Focused recovery proof is green.
- Broad OpenClaw terminal proof is red, one failed file / one failed test.
- No worker, VM, default e2e, `pnpm check`, implementation review, PR wrapup,
  or beta proof is complete after this red gate.

After the subagent timeout is resolved:

1. Rerun the focused subagent OpenClaw e2e.
2. Rerun the broad OpenClaw gate:
   - `mise exec -- pnpm run test:e2e:openclaw`
3. Continue terminal gates in order:
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm check`
4. Run implementation review.
5. Perform PR-ready non-merge wrapup.
6. Validate `../shravan-claw-beta` with actual Discord and actual OpenClaw
   where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current branch
  proof target remains `2026.6.8`; do not downgrade. Only move newer if
  concrete runtime evidence shows a newer OpenClaw materially reduces
  implementation risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the subagent lease proof to avoid the normalized-workMountDir
  invariant.

phase_result: needs_revision
evidence: The focused recovery fix is green through typecheck, focused unit,
targeted format, and focused live OpenClaw recovery e2e. The broad
`mise exec -- pnpm run test:e2e:openclaw` gate exits 1 in
`openclaw-subagent-lease.openclaw.e2e.test.ts`; the subagent is accepted but the
run ends with `FailoverError: operation has timed out`, and the history never
contains `SUBAGENT_LEASE_SMOKE_OK`.
recommended_next_workflow: shravan-dev-workflow:debug-investigation
recommended_transition_reason: Diagnose the live OpenClaw subagent timeout
before more implementation; only patch the scoped cutover/proof path once the
failure boundary is known.

## Current Remade Goal - Event 81

This section is the current remade goal contract after the subagent lease
observer fix and the first broad OpenClaw recovery-grace investigation.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, beginning
with the scoped typecheck repair for `controlSessionDeathGraceMs`.

Why execution is back in implementation:

- The prior stale e2e lease observer blocker was fixed by moving the observer to
  the gateway-control RPC lease-create path.
- `ObservedLeaseCreateRequest` now lives at
  `packages/agent-vm/src/controller/leases/observed-lease-create-request.ts`.
- `createGatewayControlLeaseRpcOperations()` now emits the observer after
  lease-create authority resolution and before `leaseManager.createLease()`.
- The focused live OpenClaw subagent lease e2e passed after that observer fix.
- The broader OpenClaw gate then progressed to the live recovery test and
  exposed a timing/config mismatch: production uses
  `CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace` = `600_000` ms, while
  the live e2e recovery wait budget is shorter.
- The in-progress fix adds a controller health config field
  `controlSessionDeathGraceMs`, defaults it to `600_000`, passes it into
  `createGatewayServiceHealthMonitor()`, and sets the live recovery e2e to
  `30_000`.
- Unit proof for config parsing and the gateway-service health monitor is
  green, but package typecheck is currently red because test fixtures with
  literal `LoadedSystemConfig` health objects are missing the new required
  field.

Immediate implementation checkpoint:

1. Fix the scoped typecheck failures without broad refactor:
   - `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts`
2. Prefer updating shared fixture/default health objects once instead of
   scattering unrelated changes.
3. Rerun:
   - `pnpm --filter @agent-vm/agent-vm typecheck`
   - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/config/system-config.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts --reporter verbose`
   - targeted format check on touched files.
4. Rerun the focused live recovery proof:
   - `mise exec -- env AGENT_VM_OPENCLAW_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts --reporter verbose`
5. If focused recovery is green, rerun the broad OpenClaw gate:
   - `mise exec -- pnpm run test:e2e:openclaw`

Current proof status:

- Subagent observer fix proof:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts --reporter verbose` passed.
  - Focused control-session unit proof passed 3 files / 18 tests.
  - `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts --reporter verbose` passed 1 file / 48 tests.
  - Focused live subagent OpenClaw e2e passed 1 file / 1 test.
- Recovery-grace config proof:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/config/system-config.unit.test.ts --reporter verbose` passed 1 file / 157 tests.
  - `packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts` passed 1 file / 26 tests.
- Current blocker:
  - `pnpm --filter @agent-vm/agent-vm typecheck` exits 2 because literal
    health config fixtures omit required `controlSessionDeathGraceMs`.

After OpenClaw passes:

1. Continue terminal gates in order:
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm check`
2. Run implementation review.
3. Perform PR-ready non-merge wrapup.
4. Validate `../shravan-claw-beta` with actual Discord and actual OpenClaw
   where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch runtime is `2026.6.8`; do not downgrade. Only move newer if concrete
  runtime evidence shows a newer OpenClaw materially reduces implementation
  risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not weaken the live recovery test to dodge the large control-session death
  grace invariant; use the explicit test config override.

phase_result: needs_revision
evidence: The stale subagent lease observer was moved to the gateway-control RPC
lease-create path and focused unit/integration/live OpenClaw proof passed. The
broad OpenClaw gate then exposed a recovery-grace timing/config mismatch. A
`controlSessionDeathGraceMs` health config override is partially implemented and
unit-proven, but `pnpm --filter @agent-vm/agent-vm typecheck` currently exits 2
because `LoadedSystemConfig` fixtures omit the new required field.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Finish the scoped health-config fixture repair,
restore typecheck, then rerun focused and broad OpenClaw e2e before continuing
the terminal proof ladder.

## Current Remade Goal - Event 80

This section is the current remade goal contract after compaction and the
process-global OpenClaw gateway-control runtime fix.

The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:debug-investigation`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, after the
stale e2e observer question is resolved.

Why execution is in debug:

- The previous architecture suspicion was handled as a VM-side service-lifetime
  bug first, not as a VM-local bridge.
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service-runtime.ts`
  now owns a process-global `GatewayControlService` runtime keyed by
  `zoneId`, `peerId`, `bootId`, `generationId`, `controllerEpoch`, and
  `verifierPublicKeyPem`.
- `openclaw-plugin-registration.ts` now reuses that runtime across repeated
  full registration for the same identity and starts heartbeat once per
  runtime.
- The red proof for repeated full registration failed before the fix and is
  green after the fix.
- Focused plugin unit, gateway-control service integration, plugin package
  typecheck, targeted format check, and sequential plugin/controller package
  builds are green.
- The focused live OpenClaw subagent e2e no longer fails with
  `Error: gateway control session is not connected`.
- The current failure is now an e2e assertion mismatch:
  `observedLeaseRequests` is empty in
  `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`,
  while the test expected three normalized lease create observations.
- That observer appears likely to be wired to the old HTTP `/lease` request
  hook through `startE2eControllerRuntime({ onLeaseCreateRequest })`, while
  lease creation now flows through gateway-control RPC.

Immediate debug checkpoint:

1. Use `shravan-dev-workflow:debug-investigation`.
2. Read the current control RPC and stale observer seams:
   - `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
   - `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
   - `packages/agent-vm/src/controller/http/controller-http-routes.ts`
   - `packages/agent-vm/src/integration-tests/e2e-harness.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
3. Decide whether the e2e should observe the new gateway-control lease RPC
   request path or assert the authoritative resulting lease state instead.
4. Preserve the original proof intent: `/workspace`, `/workspace/subdir`, and
   `/work/tmp` must not cross into controller lease authority as raw VM paths;
   normalized controller-owned work mount state must still be proven.
5. Do not restore the old HTTP `/lease` mutation path or fallback client.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch runtime is `2026.6.8`; do not downgrade. Only move newer if concrete
  runtime evidence shows a newer OpenClaw materially reduces implementation
  risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not replace the current failure with a weaker assertion; move the proof to
  the correct new control-RPC boundary.

phase_result: needs_revision
evidence: The process-global VM-side gateway control service runtime fix removed
the prior `gateway control session is not connected` failure in the focused
OpenClaw subagent e2e. The current failure is now an empty
`observedLeaseRequests` array in
`openclaw-subagent-lease.openclaw.e2e.test.ts`, likely because the observer is
attached to the retired HTTP `/lease` route instead of the gateway-control RPC
lease path.
recommended_next_workflow: shravan-dev-workflow:debug-investigation
recommended_transition_reason: Diagnose and update the subagent lease e2e
observer/proof boundary so the hard-cutover control RPC path is proven without
restoring old HTTP lease mutation surfaces.

## Current Remade Goal - Event 79

This section is the current remade goal contract after compaction,
orchestrator-goal audit, and the first OpenClaw runtime-boundary evidence pass.
The active Codex host goal object still cannot be rewritten while unfinished.
Per `orchestrator-goal` precedence, the latest valid orchestrator-written event
in `events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:discuss-with-me`.

Why execution is paused:

- The broader OpenClaw e2e gate exposed a remaining architecture/model break in
  the subagent Tool VM lease path.
- Tool Portal native tool discovery is fixed and proven.
- The WebSocket-only control-session health proof is fixed and proven.
- `GatewayControlService.emitApplicationMessage` has a bounded same-process
  connect wait, and its integration proof is green.
- The subagent lease path still fails with
  `Error: gateway control session is not connected`.
- That failure is no longer classified as a simple first-connect retry problem.
- DeepWiki evidence against `openclaw/openclaw` says OpenClaw v2026.6.x stores
  sandbox backend factories process-globally through
  `Symbol.for("openclaw.sandboxBackendFactories")`.
- Local installed OpenClaw `2026.6.8` evidence confirms
  `registerSandboxBackend()` stores backend factories in that global registry,
  and sandbox context creation calls `requireSandboxBackendFactory(...)`.
- The original "subagent runs in a separate process" hypothesis is now less
  likely. The stronger branches are that the accepted Socket.IO session drops
  before the subagent lease command, or a later plugin/runtime activation
  overwrites the process-global `gondolin` backend factory with a fresh
  disconnected `GatewayControlService`.

Immediate next discussion/research checkpoint:

1. Inspect OpenClaw plugin loader cache and activation behavior around
   `getReusableCachedPluginRegistry`, `activatePluginRegistry`,
   `ensureRuntimePluginsLoaded`, `ensureStandaloneRuntimePluginRegistryLoaded`,
   and gateway startup `loadOpenClawPlugins(...)`.
2. Prove whether subagent or agent runtime plugin load re-runs full plugin
   registration and overwrites the process-global `gondolin` sandbox backend
   factory after the controller has connected to the gateway startup service.
3. If later registration overwrites the factory, design the smallest
   hard-cutover-conforming fix: process-global VM-side control service per
   identity, or backend registration that reuses the active service instead of
   constructing a fresh disconnected one.
4. If registration is not overwritten, diagnose socket lifecycle: connection,
   disconnect reason, accepted socket visibility, and timing relative to the
   subagent lease command.
5. Only after the architecture is proven, resume
   `shravan-dev-workflow:implementation-execute-plan` on the chosen fix.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch runtime is `2026.6.8`; do not downgrade. Only move newer if the
  architecture proof shows that a newer OpenClaw version materially reduces the
  implementation risk, and reconcile the specs/plans first.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` remains the full-system e2e proof system for actual
  Discord and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.
- Do not add another retry-only patch before proving the OpenClaw process/module
  boundary.

phase_result: needs_revision
evidence: Event 77 stopped implementation after the broader OpenClaw e2e gate
left `openclaw-subagent-lease.openclaw.e2e.test.ts` failing with
`Error: gateway control session is not connected`; Tool Portal native smoke and
gateway-control-service integration proof were already green. Event 79 adds
OpenClaw v2026.6.x and local 2026.6.8 evidence that sandbox backend factories
are process-global, so the next checkpoint should scrutinize plugin
re-registration/overwrite and socket lifecycle before considering any VM-local
bridge.
recommended_next_workflow: shravan-dev-workflow:discuss-with-me
recommended_transition_reason: Reconverge on the OpenClaw subagent lease
control-service ownership, plugin registration, and socket lifecycle boundary
before more implementation changes.

## Previous Remade Goal - Event 78

This section preserves the prior compacted edge before the OpenClaw
process-global registry evidence was folded into the orchestrator state.

## Current Resume Edge - Event 76

This section is the current remade goal contract after the focused
control-session health proof.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 72: S5b managed MCP Portal identity removal is locally complete and
  green through focused proof, full unit, full integration, `pnpm check`,
  host-docker evidence-project execution, and e2e inventory.
- Event 75: current edge was to poll the active focused OpenClaw control-session
  e2e proof instead of restarting earlier slices.
- Event 76: the focused `records control-session and gateway-service health`
  OpenClaw proof passed after the VM-side heartbeat publisher and
  `safeDetails.peerId` mapper fix.

Immediate next execution:

1. Run the broader OpenClaw gate without the focused `-t` filter.
2. If it fails, use `shravan-dev-workflow:debug-investigation`, inspect the
   exact new failure, and only patch the in-scope Socket.IO control-plane
   cutover/proof path.
3. After OpenClaw passes, continue sequentially to
   `mise exec -- pnpm run test:e2e:worker`,
   `mise exec -- pnpm run test:e2e:vm`, then
   `mise exec -- pnpm test:e2e`.
4. Then rerun `pnpm check` if files changed, run implementation review, perform
   PR-ready non-merge wrapup, and validate `../shravan-claw-beta` with actual
   Discord and actual OpenClaw where required.

Focused proof captured:

- Command: `mise exec -- env AGENT_VM_OPENCLAW_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts -t 'records control-session and gateway-service health' --reporter verbose`.
- Result: exit 0; 1 file passed; 1 test passed; 2 tests skipped due to the
  intentional `-t` filter.

Hard non-goals at this edge remain unchanged:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.

phase_result: complete
evidence: focused OpenClaw `records control-session and gateway-service health`
proof passed with exit 0 after the gateway control-session heartbeat and
`safeDetails.peerId` mapper fix; this is targeted proof only, not the full
OpenClaw gate.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution by running the
broader OpenClaw proof gate without the focused test filter.

## Current Blocked Design Edge - Event 77

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest evidence:

- The Tool Portal native OpenClaw smoke is fixed and green after manifest,
  tool-discovery registration, and assertion updates.
- The WebSocket-only control-session proof is green.
- The subagent Tool VM lease path still fails with
  `Error: gateway control session is not connected` even after a bounded
  same-process connect wait inside `GatewayControlService.emitApplicationMessage`.

Current interpretation:

- This is no longer a simple initial connection race.
- The remaining subagent failure may mean subagent sandbox backend lease calls
  do not share the gateway process/plugin instance that owns the accepted
  controller Socket.IO connection, or that the accepted socket is being dropped
  before subagent lease calls run.
- Do not add another retry-only patch without proving the exact OpenClaw
  process/module boundary.

Next action:

1. Reconverge on the subagent lease architecture before more code changes.
2. Prove whether the subagent sandbox backend lease path runs in the same
   OpenClaw process/module instance as the private `registerHttpRoute`
   control-session service.
3. If it does not, design a VM-local bridge to the gateway-owned private
   control service, keeping the hard-cutover invariants intact.
4. If it does, diagnose why the controller Socket.IO connection is disconnected
   before subagent lease commands.

phase_result: needs_revision
evidence: Tool Portal smoke passed 1 file / 4 tests; gateway-control-service
integration passed 1 file / 4 tests; subagent lease e2e still fails with
`gateway control session is not connected` after the same-process wait fix.
recommended_next_workflow: shravan-dev-workflow:discuss-with-me
recommended_transition_reason: The implementation exposed a model break around
where subagent sandbox backend lease calls execute relative to the gateway-owned
control session.

## Current Resume Edge - Event 75

This section is the current remade goal contract after compaction and host goal
audit. The active Codex host goal object still cannot be rewritten while
unfinished, and its compact text still names an older starting checkpoint. Per
orchestrator precedence, the latest valid orchestrator-written event in
`events.jsonl` owns the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 72: S5b managed MCP Portal identity removal is locally complete and
  green through focused proof, full unit, full integration, `pnpm check`,
  host-docker evidence-project execution, and e2e inventory.
- Event 73 remade the post-compaction edge around terminal e2e proof, starting
  with `mise exec -- pnpm run test:e2e:openclaw`.
- Event 74 remade the edge during in-flight OpenClaw proof debugging. It fixed
  in-scope package-manifest and local-package-overlay blockers and left the live
  OpenClaw e2e gate open.
- The current OpenClaw e2e session is already running; do not start a duplicate
  run until that session exits or is intentionally stopped.

Immediate next execution:

1. Poll the active `mise exec -- pnpm run test:e2e:openclaw` session.
2. If the OpenClaw gate fails, use
   `shravan-dev-workflow:debug-investigation`, inspect the exact new failure,
   and only patch the in-scope Socket.IO control-plane cutover/proof path.
3. After OpenClaw passes, continue sequentially to
   `mise exec -- pnpm run test:e2e:worker`,
   `mise exec -- pnpm run test:e2e:vm`, then
   `mise exec -- pnpm test:e2e`.
4. Then rerun `pnpm check` if files changed, run implementation review, perform
   PR-ready non-merge wrapup, and validate `../shravan-claw-beta` with actual
   Discord and actual OpenClaw where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch target remains OpenClaw `2026.6.8`; do not downgrade unless the user
  explicitly changes the target and the specs/plans are reconciled.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` is the full-system e2e proof system for actual Discord
  and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.

phase_result: complete
evidence: active host goal object remains active and cannot be replaced while
unfinished; host goal compact text is older than Events 72-74; Event 74 remains
the latest in-flight OpenClaw proof edge; this Event 75 remake preserves the
same implementation workflow and directs the next agent to poll the active
OpenClaw e2e session instead of restarting earlier slices.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution from the
active OpenClaw e2e proof gate, preserving S5c/OPEN-2 and PR-ready non-merge
stop conditions.

## Previous Resume Edge - Event 74

This section is the current remade goal contract after compaction. The active
Codex host goal object still cannot be rewritten while unfinished, so future
agents must use this details section plus the latest valid orchestrator-written
event in `events.jsonl` as the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 72: S5b managed MCP Portal identity removal is locally complete and
  green through focused proof, full unit, full integration, `pnpm check`,
  host-docker evidence-project execution, and e2e inventory.
- Event 73 remade the post-compaction edge around terminal e2e proof, starting
  with `mise exec -- pnpm run test:e2e:openclaw`.
- The first OpenClaw e2e proof attempt exposed an in-scope controller package
  manifest miss: `@agent-vm/agent-vm` imported
  `@agent-vm/gateway-control-contracts` without declaring the workspace
  dependency. The dependency and lockfile were refreshed, and
  `pnpm --filter @agent-vm/agent-vm build` passed.
- The second OpenClaw e2e proof attempt progressed into Docker image
  preparation and exposed stale local package overlay closures for the new Tool
  Portal/control-contract package graph. The e2e harness and beta tarball sync
  package lists were updated, with focused host e2e/unit/build proof passing.
- Terminal live proof remains open. The next execution step is to poll or rerun
  `mise exec -- pnpm run test:e2e:openclaw` and debug only failures inside the
  agreed Socket.IO control-plane cutover/proof path.

Immediate next execution:

1. Resume terminal e2e proof. Do not restart at GATE-0a, S1, S2, S3, or S5b.
2. Complete `mise exec -- pnpm run test:e2e:openclaw`.
3. If the OpenClaw gate fails, use
   `shravan-dev-workflow:debug-investigation`, inspect the exact new failure,
   and only patch the in-scope cutover/proof path.
4. After OpenClaw passes, continue sequentially to
   `mise exec -- pnpm run test:e2e:worker`,
   `mise exec -- pnpm run test:e2e:vm`, then
   `mise exec -- pnpm test:e2e`.
5. Then rerun `pnpm check` if files changed, run implementation review, perform
   PR-ready non-merge wrapup, and validate `../shravan-claw-beta` with actual
   Discord and actual OpenClaw where required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch target remains OpenClaw `2026.6.8`; do not downgrade unless the user
  explicitly changes the target and the specs/plans are reconciled.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` is the full-system e2e proof system for actual Discord
  and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.

phase_result: complete
evidence: active host goal object remains active and cannot be replaced while
unfinished; Event 72 remains the latest completed implementation checkpoint;
Event 73 started terminal e2e proof; current OpenClaw e2e gate has had two
in-scope proof-environment blockers fixed with focused evidence, but the live
OpenClaw e2e gate is not complete yet.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution from the live
OpenClaw e2e proof gate, preserving S5c/OPEN-2 and PR-ready non-merge stop
conditions.

## Current Resume Edge - Event 73

This section is the current remade goal contract after compaction. The active
Codex host goal object still cannot be rewritten while unfinished, so future
agents must use this details section plus the latest valid orchestrator-written
event in `events.jsonl` as the current execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 72: S5b managed MCP Portal identity removal is locally complete and
  green through focused proof, full unit, full integration, `pnpm check`,
  host-docker evidence-project execution, and e2e inventory.
- Managed OpenClaw now exposes Tool Portal native model-visible tools:
  `tool_portal_list`, `tool_portal_search`, `tool_portal_describe`, and
  `tool_portal_call`.
- The old managed OpenClaw `openclaw-mcp-portal-plugin` identity and
  `mcp_portal_*` model-visible surface must not be restored.
- MCP Portal remains allowed only as backend/effective-config machinery and as
  standalone or Tool VM support where the accepted plan allows it.
- S5c collector fail-closed remains blocked on OPEN-2 and final shipment.
- Terminal live proof and delivery gates remain open before any PR-ready claim.

Immediate next execution:

1. Resume from Event 72; do not restart at GATE-0a, S1, S2, S3, or S5b.
2. Run terminal e2e proof gates sequentially to avoid Docker/QEMU/resource
   contention:
   `mise exec -- pnpm run test:e2e:openclaw`,
   `mise exec -- pnpm run test:e2e:worker`,
   `mise exec -- pnpm run test:e2e:vm`, then
   `mise exec -- pnpm test:e2e`.
3. If any e2e gate fails, use `shravan-dev-workflow:debug-investigation`,
   inspect logs, and only fix failures inside the agreed Socket.IO control-plane
   cutover scope. Stop before editing unrelated infra/tooling failures.
4. After terminal e2e gates, rerun `pnpm check` if files changed, then run
   implementation review, PR-ready non-merge wrapup, and external
   `../shravan-claw-beta` proof with actual Discord and actual OpenClaw where
   required.

Current fixed context:

- OpenClaw `2026.6.5` is the minimum acceptable runtime. The current proven
  branch target remains OpenClaw `2026.6.8`; do not downgrade unless the user
  explicitly changes the target and the specs/plans are reconciled.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- `shravan-claw-beta` is the full-system e2e proof system for actual Discord
  and actual OpenClaw.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.

phase_result: complete
evidence: active host goal object remains active and cannot be replaced while
unfinished; Event 72 is the latest proven implementation checkpoint; this
details file and Event 73 remake the current resume edge around terminal e2e
proof and delivery gates
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution from terminal
e2e proof gates, preserving S5c/OPEN-2 and PR-ready non-merge stop conditions.

## Previous Resume Edge - Event 72

This section is the current remade goal contract. The active Codex host goal
object may still contain older starting checkpoints, but the official
orchestrator precedence is:

1. Scope and non-goals from the host goal.
2. Current workflow and next execution edge from the latest valid
   orchestrator-written event in `events.jsonl`.
3. Expanded implementation context from this details file and the execution
   brief.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 72: S5b managed MCP Portal identity removal is locally complete and
  green through focused proof, full unit, full integration, `pnpm check`,
  host-docker evidence-project execution, and e2e inventory.
- `packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts` now
  registers the managed model-visible tools:
  `tool_portal_list`, `tool_portal_search`, `tool_portal_describe`, and
  `tool_portal_call`.
- The OpenClaw plugin full registration path calls
  `registerToolPortalNativeTools` when `gondolin.toolPortal.configDir` is
  present.
- Gateway effective-config materialization now writes a Tool Portal projection
  under `tool-portal-effective`, with
  `tool-portal-effective-manifest.json` naming `toolPortalConfigFile`.
- MCP Portal remains allowed as backend/effective-config machinery and
  standalone/Tool VM support; it must not reappear as the managed OpenClaw
  model-visible plugin surface.
- Managed OpenClaw init scaffolding, generated manuals, doctor/requirements,
  validation, gateway effective-config naming, beta/local gateway overlay sync,
  config docs, and the OpenClaw portal e2e now agree on the Tool Portal
  managed surface.
- Final shipment is not complete. S5c remains blocked on OPEN-2, and terminal
  live OpenClaw/Worker/VM/default e2e plus `../shravan-claw-beta` actual
  Discord/OpenClaw proof remain required before PR-ready status.

Immediate next execution:

1. Resume the implementation DAG after S5b. Do not treat the full cutover as
   complete.
2. S5c collector fail-closed remains blocked on OPEN-2 and final shipment.
3. Remaining terminal proof before PR-ready status still includes:
   `mise exec -- pnpm run test:e2e:openclaw`,
   `mise exec -- pnpm run test:e2e:worker`,
   `mise exec -- pnpm run test:e2e:vm`,
   `mise exec -- pnpm test:e2e`, `pnpm check`, implementation review, PR
   wrapup, and external `../shravan-claw-beta` actual Discord/OpenClaw proof.
4. Keep MCP Portal as backend/effective-config machinery and standalone or Tool
   VM support where the accepted plan allows it.
5. Do not restore the removed managed OpenClaw MCP Portal plugin identity or
   `mcp_portal_*` model-visible tools.

Hard non-goals at this edge:

- Do not restore deleted `/lease*` mutation/read routes. `GET /leases` remains
  the operator diagnostic route.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not restore raw `controller.vm.host:18800` as a control fallback.
- Do not add Socket.IO polling.
- Do not add an OpenClaw sidecar control service.
- Do not remove Worker raw callback wiring prematurely before `SWc` or an
  explicit split/blocker.
- Do not restore managed OpenClaw `mcp_portal_*` model-visible tools or the old
  managed `openclaw-mcp-portal-plugin` identity as a compatibility path.

phase_result: complete
evidence: S5b managed MCP Portal identity removal passed focused unit,
focused integration, `@agent-vm/agent-vm` typecheck, targeted format check,
host e2e Dockerfile smoke, full unit, full integration, `pnpm check`,
`test:e2e:host-docker`, and e2e inventory; host-docker did not include a
managed OpenClaw image rebuild assertion, so do not overclaim actual image
rebuild proof
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation from the next DAG-ready
slice or blocker, preserving terminal live proof gates and the S5c/OPEN-2 final
shipment stop.

## Objective

Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
accepted specs and reviewed vertical-slice plan, then carry the work through
implementation proof, implementation review, and PR-ready non-merge wrapup.

## Required Reading

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `docs/specs/2026-07-02-socketio-control-plane/relevant-file-profile.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/15-sg-ssh-egress-git-policy.md`

## Current Decisions

- OpenClaw `2026.6.5` is the minimum acceptable runtime for this PR.
- Current implementation target is `2026.6.8`.
  This supersedes the earlier exact-`2026.6.5` planning target because the
  branch must integrate `origin/master`, whose managed-image manifest already
  pins managed OpenClaw package overrides to `2026.6.8`. Stay on `2026.6.8`
  unless `GATE-0a` fails or concrete evidence requires a newer stable OpenClaw;
  do not downgrade to `2026.6.5`.
- `SG` means `SG (SSH Git)`: SSH egress git read policy. It allows
  `git-upload-pack` and denies `git-receive-pack` at the Gondolin host
  boundary.
- Proof matrix has 45 rows.
- Slice file count is 18 including `slices/README.md`.
- First implementation move is `GATE-0a`: prove the exact delivered OpenClaw
  `2026.6.8` runtime supports plugin `handleUpgrade` plus pre-101 private auth.
- `shravan-claw-beta` may be used as the full-system e2e proof system with
  actual Discord and actual OpenClaw. Do not treat mock-only proof as a
  substitute for that full-system lane when the plan requires live behavior.

## Current Git/Preflight State

- User requested merging origin main first.
- `origin/main` did not exist; `origin/master` was the real upstream default.
- `origin/master` has been merged into `mcp-portal-better-interface`.
- Merge commit: `ed408966 Merge remote-tracking branch 'origin/master' into
  mcp-portal-better-interface`.
- Current branch evidence after compaction: `mcp-portal-better-interface` is
  ahead of `origin/mcp-portal-better-interface`.
- Do not use destructive git operations and do not revert unrelated dirty
  files.

## Completed Implementation Evidence

- `GATE-0a` is complete and green.
  - Delivered runtime inspected as OpenClaw `2026.6.8`.
  - `docker run --rm --entrypoint openclaw agent-vm-gateway:latest --version`
    reported `OpenClaw 2026.6.8 (844f405)`.
  - Throwaway Socket.IO/OpenClaw route probe passed:
    readiness `204`, bad upgrade rejected before `101`, good client connected
    to `/__agent-vm/gateway-control`, transport `websocket`, one HTTP server
    port.
- `S1` control protocol contract packages are complete and green.
  - Created `@agent-vm/control-protocol-contracts`,
    `@agent-vm/gateway-control-contracts`, and
    `@agent-vm/worker-control-contracts`.
  - Package version sync uses `0.0.108`.
  - Last recorded S1 proof includes package unit/type/build checks,
    portal export and architecture audits, taxonomy, `pnpm check`, and
    `pnpm test:unit`.
- `SWa` worker-control-contracts population is complete and green.
  - Worker operations include `control_ping`, capacity/runtime snapshots,
    runtime observation, git push/pull default, cancel, and recovery command.
  - Worker git payloads follow the latest accepted implementation plan:
    explicit `repoUrl`, `branchName`, and optional `expectedHead`.
- `S2` OpenClaw plugin-hosted gateway control service placement is locally
  complete and green.
  - Added plugin-hosted private readiness and upgrade route registration:
    `GET /__agent-vm/ready` and `/__agent-vm/gateway-control`.
  - Implemented detached Engine.IO plus Socket.IO service behind the OpenClaw
    plugin `handleUpgrade(req, socket, head)` route.
  - Implemented pre-101 header-only private auth proof with VM-issued one-use
    nonce, Ed25519 verifier public key in VM config, stable signature payload,
    query-string credential rejection, and duplicate-nonce protection.
  - Local proof passed for plugin typecheck, gateway-control integration,
    registration/config unit tests, package build, targeted unit/integration
    coverage, `pnpm test:integration`, and `pnpm check`.
  - Caveat: full S2+S3 real OpenClaw ingress e2e is still open until
    controller-side signer/provisioning, production dialing, and runtime e2e
    proof land.

## Active Implementation Slice

- `S2/S3` controller-to-plugin bridge/provisioning is implemented and green at
  the broad static check gate.
- `S3` controller Socket.IO client foundation is complete and green; the full
  S3 slice remains open.
- Added `socket.io-client@4.8.1` and `socket.io@4.8.1` to
  `@agent-vm/agent-vm`.
- Created controller control-session client/dispatcher foundation under
  `packages/agent-vm/src/controller/control-session/`.
- Added shared handshake constants and the canonical signature payload to
  `@agent-vm/control-protocol-contracts`.
- Added controller helper
  `packages/agent-vm/src/controller/control-session/gateway-control-session.ts`
  to create Ed25519 material, fetch the private readiness credential, sign the
  upgrade headers, and connect to `/__agent-vm/gateway-control` with
  websocket-only Socket.IO.
- Wired OpenClaw gateway start to provision the VM-side verifier config,
  preserve controller-owned control material over user/runtime plugin config,
  enable ingress, and dial the private control session.
- `controller-runtime.ts` now carries a controller epoch into gateway starts,
  and OpenClaw runtime close closes the active control session before closing
  the VM.
- Direct S3 foundation evidence is green:
  - `pnpm lint:types` passed with 398 warnings and 0 errors.
  - S3 integration test passed: 1 file, 4 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm test:integration` passed: 26 files, 355 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- Current S2/S3 bridge proof before compaction:
  - targeted controller/plugin integration pair passed: 2 files, 53 tests.
  - package typechecks passed for `@agent-vm/control-protocol-contracts`,
    `@agent-vm/openclaw-agent-vm-plugin`, and `@agent-vm/agent-vm`.
  - targeted unit run passed: 3 files, 29 tests.
  - targeted integration run passed: 3 files, 55 tests.
  - `pnpm test:integration` passed: 27 files, 359 tests.
- Formatter/lint recovery after compaction:
  - `mise run lint --` on the formatter/lint target set passed with 0 errors.
  - `pnpm exec oxfmt --check` on the touched formatter targets passed.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 bounded-control-payload receipt:
  - Added a red/green integration test proving oversized control payloads are
    rejected before they enter the Socket.IO control channel.
  - Added controller-side serialized message byte measurement and
    `maxHttpBufferBytes` enforcement in the control-session client.
  - `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 6 tests.
  - S2/S3 targeted integration set passed: 3 files, 56 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm check` passed: 8 passed, 0 failed.
  - `pnpm test:integration` passed: 27 files, 360 tests.
- S3 no-reconnect-buffer receipt:
  - Added a red/green integration test proving critical application messages
    fail immediately while the Socket.IO client is disconnected instead of
    waiting on Socket.IO timeout or entering `sendBuffer`.
  - Added a controller-side disconnected-socket guard that clears `sendBuffer`,
    drops droppable/latest-wins messages, and rejects critical application
    messages with an explicit no-buffer error.
  - Red proof failed as expected with Socket.IO timeout instead of
    `control session is not connected`.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 7 tests.
  - S2/S3 targeted integration set passed: 3 files, 57 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm check` passed: 8 passed, 0 failed.
  - `pnpm test:integration` passed: 27 files, 361 tests.
- S3 bounded-pending-queue receipt:
  - Added a red/green integration test proving pending critical messages are
    capped by `CONTROL_QUEUE_LIMITS.queueMessageCap`; the overflow message is
    rejected before the peer observes it.
  - Added controller-side pending queue accounting for acked control messages:
    pending message count and pending byte count are reserved before
    `emitWithAck` and released in `finally`.
  - Red proof failed as expected with Socket.IO timeout instead of
    `control session pending queue overflow`.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 8 tests.
  - S2/S3 targeted integration set passed: 3 files, 58 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm check` passed: 8 passed, 0 failed.
  - `pnpm test:integration` passed: 27 files, 362 tests.
- S3 pending-overflow fail-safe receipt:
  - Added a red/green integration test proving pending critical queue overflow
    marks the control session stale/unusable, emits typed `control:close` with
    `backpressure_overflow` when the peer supports it, closes the socket, and
    prevents later critical sends from extending liveness.
  - Added sticky stale state in the controller control-session client; overflow
    now rejects locally, clears the Socket.IO send buffer, sends a bounded
    close-notify attempt, and rejects future application messages with a stale
    session error.
  - Exported the shared `ControlSessionCloseReason` type from
    `@agent-vm/control-protocol-contracts` so controller close classification
    stays tied to the Zod contract.
  - Red proof failed as expected: the new test observed no typed close/stale
    signal after overflow.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 9 tests.
  - S2/S3 targeted integration set passed: 3 files, 59 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 363 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 priority-heartbeat fail-safe receipt:
  - Added red/green integration tests for `BP-2`: heartbeat messages preserve a
    priority lane when the normal critical command lane is saturated, and a
    heartbeat that reaches the peer but cannot be acknowledged marks the session
    stale, sends typed `control:close` with `transport_error`, closes the
    socket, and prevents later critical sends from extending liveness.
  - Added controller-side priority classification for heartbeat messages so
    liveness does not consume or wait behind the normal pending critical queue.
  - Added fail-safe stale handling for priority heartbeat ack timeout.
  - Red proof 1 failed as expected: heartbeat was rejected with
    `control session pending queue overflow` when normal critical queue was
    saturated.
  - Red proof 2 failed as expected: heartbeat timeout produced no close/stale
    notification.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 11 tests.
  - S2/S3 targeted integration set passed: 3 files, 61 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:taxonomy` passed after removing a temporary wall-clock wait from
    the integration test.
  - `pnpm test:integration` passed: 27 files, 365 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 latest-wins controller-ceiling receipt:
  - Added a red/green integration test proving latest-wins snapshot flood
    traffic coalesces before it reaches Socket.IO, so the controller sends only
    the newest same-key snapshot rather than buffering every stale state value.
  - Added controller-side latest-wins coalescing keyed by
    domain/zone/peer/kind/operation with a scheduled `setImmediate` flush.
  - Cleaned the flood test to enqueue the latest-wins burst with `Promise.all`
    instead of awaiting inside the loop, then formatted the touched file.
  - Red proof failed as expected before the coalescer: the peer observed the
    first stale snapshot instead of the newest snapshot.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 12 tests.
  - S2/S3 targeted integration set passed: 3 files, 62 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 366 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 stale-generation fencing receipt:
  - Added a red/green integration test proving a stale accepted-session
    identity is rejected before the dispatcher can mutate handler state.
  - Added an optional `sessionFence` to the controller control-session
    dispatcher and checked domain, zone, peer, boot, controller epoch,
    session id, and connection id before handler execution.
  - Red proof failed as expected: the stale controller epoch reached the
    handler and resolved `{ ok: true }`.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 13 tests.
  - S2/S3 targeted integration set passed: 3 files, 63 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 367 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 command dedupe receipt:
  - Added a red/green integration test proving a retried command envelope with
    the same `commandId` and `idempotencyKey` returns the cached terminal
    result and does not run the domain handler side effect twice.
  - Added a bounded completed-command cache to the control-session dispatcher,
    keyed by domain, zone, peer, boot, controller epoch, operation, command id,
    and idempotency key.
  - Cache pruning uses `CONTROL_QUEUE_LIMITS.dedupeWindowMessages` and
    `CONTROL_QUEUE_LIMITS.dedupeWindowTtlMs`.
  - Red proof failed as expected: duplicate retry returned
    `{ ok: true, sideEffectCount: 2 }`.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 14 tests.
  - S2/S3 targeted integration set passed: 3 files, 64 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 368 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 out-of-window replay receipt:
  - Added a red/green integration test proving a duplicate command after the
    dedupe TTL expires does not silently re-run the side effect.
  - Changed expired completed-command replay handling to reject with
    `control session replay window expired`.
  - Red proof failed as expected: duplicate after TTL returned
    `{ ok: true, sideEffectCount: 2 }`.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 15 tests.
  - S2/S3 targeted integration set passed: 3 files, 65 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 369 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 control-session death-grace receipt:
  - Added a red/green unit test proving a control-session disconnect remains
    within grace before the exported deadline, reconnect cancels pending
    recovery, and a later disconnect becomes `recovery_due` only after the
    grace elapses.
  - Added `CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace` to the shared
    control protocol constants and asserted it is greater than the active-use
    stale TTL.
  - Added a pure S3 `control-session-death-grace` state helper for S6b to wire
    into recovery policy later without moving recovery ownership into S3.
  - Red proof failed as expected: the grace constant was undefined and the
    death-grace module was missing.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/agent-vm/src/controller/control-session/control-session-death-grace.unit.test.ts`
    passed: 2 files, 11 tests.
  - Focused S3 integration passed: 1 file, 14 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:unit` passed: 228 files, 2052 tests.
  - `pnpm test:integration` passed: 27 files, 368 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 recreate-fence receipt:
  - Added a red/green integration test proving the controller can accept a
    recreated peer session with a new boot id and controller epoch while
    fencing lingering old-boot traffic before domain handler mutation.
  - Added `createControlSessionFenceRegistry` to track the current accepted
    session per domain/zone/peer and assert envelopes against the current
    accepted boot, epoch, session, and connection identity.
  - Red proof failed as expected: `createControlSessionFenceRegistry` was not a
    function.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 16 tests.
  - S2/S3 targeted integration set passed: 3 files, 66 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 370 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 reconnect hello/resync receipt:
  - Added a red/green integration test proving a real Socket.IO reconnect sends
    `control:hello` again before a fresh application message is accepted.
  - Added reconnect hello handling in the controller control-session client and
    made application emits await the current hello promise before sending.
  - Red proof failed as expected: the second control hello after reconnect timed
    out.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 17 tests.
  - `pnpm test:taxonomy` passed after removing a local wall-clock timeout helper
    from the integration test.
  - S2/S3 targeted integration set passed: 3 files, 67 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 371 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S3 controller-ceiling forbidden-bulk receipt:
  - Added a red/green integration test proving `forbidden_bulk` envelopes are
    rejected by the control-channel boundary before they enter Socket.IO.
  - Moved the explicit envelope parse plus size/bulk boundary check before
    derived operation delivery-policy validation in `emitApplicationMessage`.
  - Red proof failed as expected: the message was rejected with delivery-policy
    mismatch instead of the explicit forbidden-bulk boundary error.
  - Green proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 18 tests.
  - S2/S3 targeted integration set passed: 3 files, 68 tests.
  - `pnpm --filter @agent-vm/agent-vm typecheck` passed.
  - `pnpm --filter @agent-vm/control-protocol-contracts typecheck` passed.
  - `pnpm test:integration` passed: 27 files, 372 tests.
  - `pnpm check` passed: 8 passed, 0 failed.
- S2+S3 real OpenClaw ingress/flap e2e receipt:
  - Fixed the local OpenClaw e2e overlay so generated gateway image
    Dockerfiles include the unpublished workspace package
    `@agent-vm/control-protocol-contracts` instead of falling back to npm.
  - Added host e2e assertions proving both local OpenClaw gateway image helper
    paths copy/install the control protocol contracts tarball.
  - Fixed OpenClaw plugin manifest schema drift by adding `controlSession` to
    `packages/openclaw-agent-vm-plugin/openclaw.plugin.json` and a manifest
    assertion in `openclaw-plugin-registration.unit.test.ts`.
  - Fixed process-flap reconnect auth by refreshing private readiness material
    before manual reconnect instead of reusing a one-use nonce.
  - Lower-layer proof passed:
    `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/integration-tests/e2e-harness.host.e2e.test.ts`
    passed: 1 file, 28 tests.
  - Lower-layer proof passed:
    `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts`
    passed: 1 file, 16 tests.
  - Lower-layer proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts`
    passed: 1 file, 19 tests.
  - Lower-layer proof passed:
    `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
    passed: 3 files, 69 tests.
  - Typecheck proof passed:
    `pnpm --filter @agent-vm/openclaw-agent-vm-plugin build` and
    `pnpm --filter @agent-vm/agent-vm typecheck`.
  - Real OpenClaw proof passed:
    `mise exec -- env AGENT_VM_OPENCLAW_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
    passed: 1 file, 1 test, duration 41.84s.

## Workflow State

- `goal_id`: `2026-07-02-socketio-control-plane`
- `Current workflow`: `shravan-dev-workflow:implementation-execute-plan`
- `Next workflow`: `shravan-dev-workflow:implementation-execute-plan`
- `Terminal condition`: PR created or updated and proven ready, implementation
  review findings addressed or explicitly rejected, required proof gates
  captured, current PR checks/review-thread/mergeability state reported, and
  merge not performed unless the user explicitly authorizes it.
- Host goal note: the active Codex goal object still exists and may contain
  older starting-checkpoint prose from before merge/GATE-0a/S1/SWa/S2/S3
  foundation. Do not treat that stale prose as the current checkpoint. Per the
  orchestrator precedence rule, this details file plus the latest valid
  orchestrator-written `events.jsonl` entry are the current resume source.

## Historical Resume Checkpoint - Pre-S6a

- The active Codex host goal still exists and cannot be replaced without
  falsely marking the long-horizon goal complete or blocked.
- Treat this file and the latest valid orchestrator-written event in
  `events.jsonl` as the remade current goal state.
- S2/S3 real OpenClaw ingress/flap e2e is green.
- Historical implementation slice at this checkpoint was `S6a` health eventKind
  remap. This section is retained as evidence only; it is superseded by the S6a
  and S6c receipts below plus the latest valid `events.jsonl` entry.
- Current implementation slice at that time was `S6a` health eventKind remap.
- S6a intent:
  - replace controller-side current health/recovery vocabulary from
    `gateway-control-link` to `gateway-control-session`;
  - keep old plugin monitor deletion for `S5a`;
  - do not reintroduce raw `controller.vm.host:18800` callback semantics.
- S6a targeted unit proof is green:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-interface/src/health/agent-vm-health.unit.test.ts packages/gateway-interface/src/health/controller-request-policy.unit.test.ts packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/health/health-event-store.unit.test.ts packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/observability/health-event-telemetry.unit.test.ts packages/agent-vm/src/observability/controller-telemetry.unit.test.ts packages/agent-vm/src/controller/zone-runtimes/gateway-zone-state-machine.unit.test.ts packages/agent-vm/src/operations/controller-status.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts`
  passed 11 files / 114 tests.
- `pnpm --filter @agent-vm/gateway-interface typecheck` is green after fixing
  the stale `gatewayControlLinkHealthPins` barrel export and restoring missing
  `/health` paths in gateway-service fixtures.
- Resume by fixing current S6a typecheck blockers:
  - `@agent-vm/openclaw-agent-vm-plugin` still imports shared
    `ControllerRequestPolicyOperation` for legacy plugin-local operations
    removed from `@agent-vm/gateway-interface`. Keep the shared package clean
    and define plugin-local legacy request-policy typing until later slices
    remove those callers.
  - `@agent-vm/agent-vm` has accidental config property renames from
    `gatewayControlLinkIntervalMs` / `gatewayControlLinkBackoffCeilingMs` to
    `gatewayControlSessionIntervalMs` /
    `gatewayControlSessionBackoffCeilingMs`. For S6a, keep the existing config
    property names and remap only health/recovery vocabulary.
  - Recheck gateway-service health fixtures for missing `path: "/health"`.
  - Treat broader pre-existing dirty-branch errors as out of scope unless a
    S6a edit caused them.
- After fixing S6a blockers, run:
  - `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`;
  - `pnpm --filter @agent-vm/agent-vm typecheck`;
  - the S6a targeted unit command above;
  - the residue scan for old controller-side health/recovery vocabulary;
  - targeted format/lint on touched S6a files;
  - `pnpm check` if the slice diff is stable.
- Already green before S6a, and not to be re-litigated unless later edits touch
  the surface: S3 local control-session behavior through:
  - bounded payloads;
  - no reconnect buffering;
  - pending queue cap and stale close semantics;
  - priority heartbeat lane and stale close semantics;
  - latest-wins coalescing;
  - stale-generation fencing;
  - command dedupe and out-of-window replay rejection;
  - death-grace helper;
  - recreate fence;
  - reconnect hello/resync;
  - forbidden_bulk/controller-ceiling local boundary.
- A new OpenClaw e2e file has been added:
  `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`.
- That e2e is intended to prove proof-matrix rows `HANDSHAKE-5`,
  `INGRESS-1`, `INGRESS-2`, and `FLAP-1B` by asserting:
  - bad raw upgrade rejects before `101`;
  - query-string credential material rejects before `101`;
  - the controller session is websocket-only on
    `/__agent-vm/gateway-control`;
  - OpenClaw gateway process flap triggers reconnect and a second hello;
  - Tool VM SSH still works before and after the flap.
- The previous OpenClaw e2e Docker overlay blocker is fixed.
- The targeted S2/S3 real OpenClaw ingress/flap e2e is green.
- Do not resume by redoing the solved S2/S3 overlay blocker.

## Historical Remade Resume Contract - Pre-S6a

- Resume workflow: `shravan-dev-workflow:implementation-execute-plan`.
- Historical first checkpoint on resume: finish S6a health eventKind remap typecheck
  blockers without deleting old plugin monitor files or weakening hard-cutover
  vocabulary.
- Recommended next checkpoint: record S6a green proof in this file,
  `events.jsonl`, and the implementation-execute-plan brief, then continue with
  the next DAG-ready slice from `slices/README.md`.
- Keep running proof after each slice:
  - targeted `control-session-client.integration.test.ts`;
  - S2/S3 targeted integration trio;
  - `pnpm --filter @agent-vm/agent-vm typecheck`;
  - `pnpm check`;
  - `pnpm test:integration`.
- Keep recording receipts in this file, `events.jsonl`, and
  `tmp/plan-workflows/2026-07-02-agent-vm-mcp-portal-better-interface-mcp-portal-better-interface-socketio-control-plane/implementation-execute-plan-brief.md`.

## S6a Health EventKind Remap Receipt

Status: S6a is locally complete and green.

Behavior / maintenance landed:

- Kept `@agent-vm/gateway-interface` clean of legacy
  `controller-health`, `health-event-publish`, and `openclaw-runtime-status`
  request-policy operations.
- Added a plugin-local legacy `controller-request-policy.ts` wrapper so
  current OpenClaw plugin callers continue to typecheck until S5a/S4/S6 remove
  those files/routes. This does not reintroduce old operations into the shared
  package.
- Restored existing config property names
  `gatewayControlLinkIntervalMs` and
  `gatewayControlLinkBackoffCeilingMs` while keeping current health/recovery
  event vocabulary on `gateway-control-session`.
- Restored `path: "/health"` in gateway-service health fixtures and route
  expectations.
- Added required `controllerPort` to touched controller test fixtures.

Proof:

- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-interface typecheck`: exit 0.
- S6a targeted unit set plus plugin local policy unit:
  `pnpm vitest run --config vitest.config.ts --project unit ...`
  passed 12 files / 135 tests.
- Plugin local policy integration:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/controller-request-policy.integration.test.ts`
  passed 1 file / 3 tests.
- Failed full unit once on the service-health route fixture because
  `path: "/health"` had been removed; fixed the fixture.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
  passed 1 file / 87 tests.
- `pnpm test:unit` passed 228 files / 2052 tests.
- `pnpm check` passed 8 checks / 0 failed.
- Residue scan found no current `gateway-control-link` event kind in the
  controller/gateway-interface health/recovery surfaces. Remaining hits are
  expected S6a exceptions:
  - `gatewayControlLink*` config property names retained for this slice;
  - `openclaw-runtime-status` HTTP route/tests owned by later route
    disposition slices;
  - historical/unit `controller.vm.host:18800` URLs in tests;
  - `controller-health` as part of file/path names, not current event kind.

phase_result: complete
evidence: S6a typechecks, targeted unit/integration, full unit, residue scan,
pnpm check
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution with the next
DAG-ready slice from `slices/README.md`; S6a local proof is green.

## Remade Goal Contract - 2026-07-02T21:29:35Z

Status: active, not complete.

Host goal caveat:

- The active Codex host goal object still cannot be replaced while unfinished.
  Do not complete or block it just to rewrite older prose.
- Treat this file and the latest valid orchestrator-written event in
  `events.jsonl` as the remade current goal state.

Current workflow:

- `shravan-dev-workflow:implementation-execute-plan`

Next workflow:

- `shravan-dev-workflow:implementation-execute-plan`

Current checkpoint:

- `S6a` is locally complete and green.
- `S6c` correlation/operator evidence is now the active slice.
- S6c red-test setup has started but has not yet been run or proven.

S6c active evidence:

- Slice source:
  `docs/specs/2026-07-02-socketio-control-plane/slices/07-s6c-correlation-evidence.md`
- Required behavior:
  - allowlisted correlation fields survive to operator evidence:
    `traceId`, `runId`, `sessionKeyDigest`, `toolCallId`, plus request/message
    ids where applicable;
  - raw `sessionKey` and non-allowlisted correlation fields are rejected or
    stripped.
- Current red-test setup:
  - `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
    now sends an active-use correlation payload containing allowlisted fields
    plus raw `sessionKey` and `toolName`, while expecting only the allowlisted
    fields to reach `startActiveUse`.
  - `packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts` now
    sends the same mixed active-use correlation and expects stored active-use
    state to contain only the allowlisted fields.
- Expected next proof command:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts`
- Expected current failure before implementation:
  current schemas/normalizers/stores still accept or propagate non-allowlisted
  active-use correlation such as raw `sessionKey` and `toolName`, or strict
  schemas may reject the mixed payload before strip behavior is implemented.

Implementation note for S6c:

- Follow the S6c slice and proof row `CORR-1`: route/session identity belongs in
  the shared control envelope or controller-owned state, not in domain
  correlation.
- If preserving current strict HTTP schema style, prove raw `sessionKey`
  rejection with a separate bad-request test and prove allowlisted propagation
  with a valid request that contains only allowlisted fields.
- Do not invent raw `sessionKey` propagation from OpenClaw plugin call sites.
  If a call path has no allowlisted ID available yet, omit correlation there
  until a proper source exists.

Version/runtime note:

- The durable implementation evidence currently proves the delivered OpenClaw
  runtime used by this branch as `2026.6.8`; earlier planning treated
  `2026.6.5` as the minimum acceptable runtime.
- Do not retarget runtime metadata during S6c. If the product decision changes
  back to exact `2026.6.5`, stop implementation and route back to spec/plan
  reconciliation because the existing GATE-0a and OpenClaw e2e receipts are
  against `2026.6.8`.

phase_result: complete
evidence: active host goal cannot be rewritten; S6a is green; S6c red-test
setup is present in controller HTTP route and lease-manager unit tests; focused
S6c red proof has not yet run
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution by running the
focused S6c red tests, then implement the correlation allowlist/reject boundary
and climb the S6c proof gates.

## S6c Correlation And Operator Evidence Receipt - 2026-07-02T21:37:08Z

Status: S6c active-use correlation boundary is locally complete and green.

Behavior landed:

- `ToolVmActiveUseCorrelation` now carries only allowlisted operator-evidence
  fields: `traceId`, `runId`, `sessionKeyDigest`, `toolCallId`, plus
  `requestId` and `messageId` for request/message evidence paths.
- Added `normalizeToolVmActiveUseCorrelation` in `@agent-vm/gateway-interface`
  and exported it from the package barrel.
- Controller active-use HTTP schema remains strict and now rejects raw
  `sessionKey`, `toolName`, `agentId`, `sessionId`, or any other
  non-allowlisted correlation field at the network boundary.
- Lease-manager active-use storage defensively normalizes direct/internal
  correlation inputs before persisting snapshots, so non-allowlisted fields are
  stripped even if an internal caller bypasses the HTTP schema.
- OpenClaw plugin active-use callers no longer send raw `sessionKey` or
  tool-name strings as correlation when no allowlisted identifier exists.
  Active-use lifecycle and heartbeats still run; only unsafe correlation
  metadata was removed.

TDD evidence:

- Red proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts`
  failed as expected before implementation:
  - HTTP rejected the mixed raw-correlation payload with status `400` while the
    test expected `200`;
  - lease-manager snapshots still contained raw `sessionKey` and `toolName`.
- Green focused proof after implementation:
  same command passed 2 files / 124 tests.
- Focused boundary proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-interface/src/tool-vm-active-use.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts`
  passed 3 files / 133 tests after the helper cleanup.

Type/proof gates:

- `pnpm --filter @agent-vm/gateway-interface typecheck`: exit 0.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- Focused unit set:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-interface/src/tool-vm-active-use.unit.test.ts packages/openclaw-agent-vm-plugin/src/controller-lease-client.unit.test.ts packages/agent-vm/src/controller/http/controller-request-schemas.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts`
  passed 5 files / 174 tests.
- `pnpm test:unit`: passed 228 files / 2052 tests.
- `pnpm test:integration`: passed 27 files / 373 tests.
- `pnpm check`: passed 8 checks / 0 failed.

Residue scan:

- Searched the active-use/controller/plugin surfaces for forbidden active-use
  correlation residue:
  `sessionKey`, `toolName`, `agentId`, and `sessionId`.
- Remaining hits were expected and not S6c residue:
  - lease-create payload identity fields;
  - control-session envelope `sessionId`;
  - planted bad-correlation fixtures in S6c tests.

phase_result: complete
evidence: S6c red proof observed; allowlisted active-use correlation
implemented; focused unit/typecheck proof green; full unit, integration, and
pnpm check green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution with the next
DAG-ready slice from `slices/README.md`; S6c local proof is green.

## Remade Goal Contract - 2026-07-02T21:41:44Z

Status: active, not complete.

Host goal caveat:

- The active Codex host goal object still cannot be replaced while unfinished.
  Do not complete or block it just to rewrite older prose.
- Treat this file and the latest valid orchestrator-written event in
  `events.jsonl` as the remade current goal state.
- If the host goal objective disagrees with this section, use this section plus
  the latest valid orchestrator event as the current resume edge.

Current workflow:

- `shravan-dev-workflow:implementation-execute-plan`

Next workflow:

- `shravan-dev-workflow:implementation-execute-plan`

Current checkpoint:

- `GATE-0a`, `S1`, `SWa`, `S2`, local `S3`, real OpenClaw ingress/flap e2e,
  `S6a`, and `S6c` are locally complete and green.
- Latest completed slice: `S6c` active-use correlation/operator evidence.
- Next implementation candidate: `S7` Tool Portal backend taxonomy, from
  `docs/specs/2026-07-02-socketio-control-plane/slices/08-s7-tool-portal-backend-taxonomy.md`.

S7 active target:

- Align Tool Portal backend taxonomy to:
  - `mcp_provider`
  - `tool_vm_runner`
  - `controller_host_action`
- Remove old shippable backend taxonomy:
  - `mcp`
  - `credentialed_runner`
- Ensure managed model-visible OpenClaw tools are only `tool_portal_*`.
- Demote `zone_git_push` from direct model-visible OpenClaw plugin tool surface
  to a Tool Portal capability backed by `controller_host_action`.

S7 proof anchors:

- Proof matrix row `RESIDUE-4`.
- `DOMAIN-SEP-1` tool action portion.
- `GIT-2` gateway domain policy portion.

First checkpoint on resume:

- Re-read the S7 slice, `RESIDUE-4`, and current code paths before editing.
- Write red tests first for backend taxonomy rejection/acceptance and
  model-visible `zone_git_push` demotion.
- Split S7 if taxonomy rename and zone-git handler movement touch too many
  consumers at once.

Expected S7 code anchors to inspect:

- `packages/config-contracts/src/tool-portal-config.ts`
- `packages/config-contracts/src/tool-portal-config.unit.test.ts`
- `packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.ts`
- `packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
- `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts`
- `packages/openclaw-agent-vm-plugin/openclaw.plugin.json`
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts`
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.unit.test.ts`
- `scripts/audit-portal-architecture.ts`
- `scripts/audit-portal-architecture.unit.test.ts`

S7 caution:

- Do not blanket-delete every `zone_git_push` mention. Some docs, fixtures,
  historical specs, and later-slice tests may remain legitimate until their
  owning slice.
- `S5a` owns final hard-removal of old plugin monitor/control residue. S7 owns
  taxonomy alignment and direct model-visible tool demotion.
- Continue to preserve the hard-cutover non-goals: no raw
  `controller.vm.host:18800` fallback, no Socket.IO polling, no OpenClaw
  sidecar, no bulk control socket, and no Worker task submit/state/close move in
  this cutover.

Recommended proof for S7:

- Targeted unit tests around config contracts, Tool Portal in-process projection,
  plugin registration/manifest, and architecture audit.
- `pnpm test:unit`
- `pnpm check`
- Add package typechecks if S7 touches package exports or cross-package
  contracts.

phase_result: complete
evidence: active host goal cannot be rewritten; S6c is green; S7 is the next
DAG-ready candidate from the slice index; S7 source and proof anchors are named
for implementation resume
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution with S7 Tool
Portal backend taxonomy unless a fresh DAG/hot-file pass finds a narrower
ready slice.

## S7 Tool Portal Backend Taxonomy Receipt - 2026-07-02T21:49:40Z

Status: S7 Tool Portal backend taxonomy and direct `zone_git_push` demotion are
locally complete and green.

Behavior landed:

- `toolPortalBackendBindingSchema` now accepts only the hard-cutover backend
  taxonomy:
  - `mcp_provider`
  - `tool_vm_runner`
  - `controller_host_action`
- Legacy Tool Portal backend kinds are rejected:
  - `mcp`
  - `credentialed_runner`
- `createToolPortalMcpProjection` now includes only capabilities backed by
  `mcp_provider`.
- Tool Portal in-process tests, MCP-backed integration fixture, and testing
  fixture now use `mcp_provider`.
- Managed OpenClaw no longer exposes the old direct model-visible
  `zone_git_push` plugin tool:
  - `openclaw.plugin.json` contracts list no direct tools.
  - `openclaw-plugin-registration.ts` no longer imports or calls
    `registerZoneGitTool`.
  - full and tool-discovery registration tests assert the direct tool is not
    registered.
- `scripts/audit-portal-architecture.ts` now scans `openclaw.plugin.json` and
  rejects direct `zone_git_push` plugin contracts or registration in the managed
  OpenClaw registration entrypoint.

Split / residue note:

- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` and its unit test are
  intentionally still present. The slice plan says S5a owns final deletion of
  old plugin monitor/control residue, including the old zone-git direct tool
  file. S7 only removes the managed model-visible registration/manifest surface.
- `zone_git_push` still appears in later-owned generated manuals/e2e/docs and
  the dormant old tool test. Those are not S7 registration/manifest residue.
- `kind: "mcp"` still appears in MCP provider config. That is a different
  domain from Tool Portal capability backend taxonomy and remains valid.

TDD evidence:

- Red proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/config-contracts/src/tool-portal-config.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts scripts/audit-portal-architecture.unit.test.ts`
  failed as expected before implementation:
  - old backend schema rejected new `mcp_provider` / accepted old taxonomy;
  - OpenClaw manifest still exposed `zone_git_push`;
  - OpenClaw registration still called `registerZoneGitTool`;
  - architecture audit did not yet flag direct `zone_git_push` surfaces.
- Focused green proof after implementation:
  same command passed 4 files / 29 tests.

Type/proof gates:

- `pnpm --filter @agent-vm/config-contracts typecheck`: exit 0.
- `pnpm --filter @agent-vm/tool-portal typecheck`: exit 0.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- Package-local unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/config-contracts/src packages/tool-portal/src packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts scripts/audit-portal-architecture.unit.test.ts`
  passed 11 files / 62 tests.
- Tool Portal MCP-backed integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/tool-portal/src/in-process-entrypoint/tool-portal-mcp-backed-capabilities.integration.test.ts`
  passed 1 file / 1 test.
- `pnpm test:integration`: passed 27 files / 373 tests.
- `pnpm check`: passed 8 checks / 0 failed.
- Final `pnpm test:unit`: passed 228 files / 2054 tests.

Residue scans:

- Tool Portal backend taxonomy scan found no old Tool Portal backend literals in
  the config/tool-portal/agent-vm gateway or validation surfaces. The remaining
  `kind: "mcp"` hit is `packages/config-contracts/src/mcp-config.ts`, the MCP
  provider config schema, not Tool Portal backend taxonomy.
- Direct `zone_git_push` scan found no manifest or registration residue. Remaining
  hits are the dormant old direct tool file/test, audit planted positives, and
  later-owned manual/e2e/doc surfaces.

phase_result: complete
evidence: S7 red proof observed; backend taxonomy aligned; direct
`zone_git_push` manifest/registration removed; focused unit/typecheck,
integration, full unit, and pnpm check green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution with a fresh
DAG/hot-file pass over the remaining ready slices from `slices/README.md`.

## S4b Zone-Git Route-Family Resume Edge - 2026-07-02T21:54:38Z

Status: S4b is the active narrow route-disposition slice after S7.

Current narrowed scope:

- Dispose only the old VM-facing zone-git mutation route family enabled by S7.
- Keep diagnostic `GET /zones/:zoneId/zone-git/status`.
- Delete `POST /zones/:zoneId/zone-git/push` rather than adding an
  operator-auth gate.
- Do not delete `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` or its
  unit test in this slice; S5a owns final plugin-side hard removal.
- Do not blanket-delete later-owned manual, e2e, or docs `zone_git_push`
  mentions in this narrow route-family slice.

Unverified test-only edits currently exist in:

- `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`

The test edits expect:

- zone-git status diagnostic still returns `200` when operations are present;
- old VM-facing push route returns `404`;
- `pushZoneGit` is not called;
- when zone-git status operations are unavailable, status returns `405` and the
  old push route still returns `404`;
- old push auth/conflict/token-scrubbing tests are removed because the route is
  deleted.

Next exact checkpoint:

1. Run the focused red proof:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
2. Expected failure before production edit: production still registers
   `POST /zones/:zoneId/zone-git/push`, so the new tests should fail expecting
   `404`.
3. Remove only the old push route from
   `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`.
4. Clean now-unused route-only imports in that file after checking actual use:
   likely `ZONE_GIT_CAPABILITY_HEADER`, `ZoneGitConflictError`,
   `controllerZoneGitPushRequestSchema`, and any push-only scrub helpers.
5. Run focused green, then affected typecheck, `pnpm test:unit`,
   `pnpm test:integration`, and `pnpm check` before recording S4b complete.

phase_result: complete
evidence: active host goal cannot be rewritten; S7 is green; S4b test-only red
setup is present in controller HTTP route tests; production route deletion has
not yet happened
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution by proving the
S4b red test, then deleting only the old VM-facing zone-git push route.

## S4b Zone-Git Route-Family Receipt - 2026-07-02T21:58:59Z

Status: the S4b zone-git route family is complete and green locally.

Behavior landed:

- Deleted old VM-facing `POST /zones/:zoneId/zone-git/push` from
  `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts`.
- Kept diagnostic `GET /zones/:zoneId/zone-git/status`.
- Removed push-route-only imports from the route module:
  `ZONE_GIT_CAPABILITY_HEADER`, `ZoneGitConflictError`, and
  `controllerZoneGitPushRequestSchema`.
- Updated controller route unit coverage so status remains available while the
  old push route returns `404` and never calls `pushZoneGit`.
- Removed old push-route auth/conflict/token-scrubbing unit tests because the
  route no longer exists.

Scope boundary:

- This is a route-family receipt, not full S4b completion. `/lease*`,
  health-events, and runtime-status route families still belong to their
  dependency-owned later passes.
- `packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts` remains intentionally
  present for S5a final hard removal.

TDD evidence:

- Red proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
  failed before production edit with 2 expected failures:
  - push route returned `200` instead of expected `404` when operations were
    present;
  - push route returned `405` instead of expected `404` when push operations
    were unavailable.
- Focused green proof after route deletion:
  same command passed 1 file / 83 tests.
- After formatting, same focused unit command passed again: 1 file / 83 tests.

Proof gates:

- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- Residue scan over touched route/test surfaces found no
  `app.post('/zones/:zoneId/zone-git/push'`, `zone-git-push`,
  `ZONE_GIT_CAPABILITY_HEADER`, `controllerZoneGitPushRequestSchema`, or
  `ZoneGitConflictError`.
- `pnpm test:unit`: exit 0, 228 files / 2050 tests.
- `pnpm test:integration`: exit 0, 27 files / 373 tests.
- `pnpm check`: exit 0, 8 passed / 0 failed.

phase_result: complete
evidence: S4b zone-git route-family TDD red/green, affected typecheck, residue
scan, full unit, integration, and pnpm check all passed
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue implementation execution with the next
DAG-ready slice or remaining S4b route family whose caller-side dependency is
complete.

## S4a Gateway Contract-Union Foundation Receipt - 2026-07-02T22:05:06Z

Status: the S4a gateway-control contract-union foundation is complete and green
locally. Full S4a lease/use RPC runtime parity remains open.

Behavior landed:

- Replaced the gateway-control placeholder package with the generic
  `gateway_control` domain contract.
- Added exact `GatewayControlRpcOperationSchema` for:
  `control_ping`, lease create/get/peek/renew/release, lease use
  start/heartbeat/end, `health_event`, `runtime_status`,
  `tool_portal_controller_host_action`, `operation_cancel`, and
  `recovery_command`.
- Added strict payload schemas for gateway lease intent, lease/use refs,
  health/runtime events, Tool Portal controller host action, operation cancel,
  recovery command, lease snapshots, active-use snapshots, rejection reasons,
  response payloads, and domain message unions.
- Added `gatewayControlDeliveryPolicyByOperation` covering every gateway
  operation.
- Added contract tests for:
  - generic `gateway_control` domain reservation;
  - exact operation union and worker/gateway domain separation;
  - lease-create intent allowing only caller-context intent and rejecting
    controller authority fields such as `agentId`, `profileId`, `sessionKey`,
    `workMountDir`, `hostWorkMountDir`, `sshIdentityPem`, and raw credential
    refs;
  - event-only `health_event` / `runtime_status` rejection as
    `command_result`;
  - derived delivery-policy mismatch rejection.

Scope boundary:

- This receipt does not move runtime lease/use traffic yet.
- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts` remains
  live until the S4a lease/use handler implementation sub-slice rewires callers.
- S4b `/lease*` route disposition remains blocked until S4a lease/use runtime
  parity lands.

Proof:

- Focused contract unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts`
  passed 1 file / 5 tests.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts build`: exit 0.
- `pnpm test:unit`: exit 0, 228 files / 2054 tests.
- `pnpm check`: exit 0, 8 passed / 0 failed.
- `pnpm test:integration`: exit 0, 27 files / 373 tests.

TDD caveat:

- This contract foundation landed without a separate pre-implementation red
  transcript because the package was still a placeholder and tests/code were
  added together. Runtime S4a sub-slices must return to normal red/green proof.

phase_result: complete
evidence: gateway-control contract union populated; focused contract
unit/typecheck/build, full unit, pnpm check, and integration all passed
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a with lease/use RPC handler parity
and caller rewire, using red/green runtime tests before production edits.

## Remade Goal Contract - Current Resume Edge

Status: active, not complete.

The host goal object still contains older starting-checkpoint prose and cannot
be replaced while the long-horizon goal is unfinished. The current goal state is
therefore this durable contract plus the latest valid
`shravan-dev-workflow:orchestrator-goal` event in `events.jsonl`.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Current checkpoint:

- `GATE-0a`, `S1`, `SWa`, `S2`, local `S3`, real OpenClaw ingress/flap e2e,
  `S6a`, `S6c`, `S7`, the `S4b` zone-git push route-family deletion, `S4a`
  gateway-control lease/use RPC parity and plugin lease-client rewire, `S4a`
  neutral lease-client cleanup, `S4a` runtime-status publisher split, and `S4b`
  `/lease*` route disposition are locally complete and green.
- Latest official transition: Event 55, written `2026-07-02T20:11:00-04:00`.
- Old VM-facing `/lease*` route handlers are removed. `GET /leases` remains as
  the operator diagnostic route.
- Do not treat health-events, runtime-status route disposition, S5 raw-control
  removal, worker Q2 corroboration, terminal e2e, beta proof, implementation
  review, or PR-ready wrapup as complete.

First checkpoint on resume:

- Re-read `docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md`
  plus the current recovery and health-event files before editing.
- Treat the next likely implementation slice as gateway-side `S6b` recovery
  corroboration and budget.
- Split gateway and worker corroboration if Q2 worker probe-source remains
  unresolved. Worker S6b is not implicitly unblocked by gateway S6b.
- Add red/green tests before production recovery edits:
  control-session observation alone must not drive recreate, controller-owned
  corroboration and source-budget keys are required, reconnect/OK within
  control-session-death grace cancels pending recovery, and old boot/epoch
  evidence is fenced after recreate.
- Use the existing
  `packages/agent-vm/src/controller/control-session/control-session-death-grace.ts`
  helper for `RESILIENT-GRACE`; do not invent wall-clock sleeps.
- Do not delete `POST /zones/:zoneId/health-events`, runtime-status routes, or
  S5 raw-control residue in this narrow gateway-side S6b pass unless the owning
  slice is explicitly being executed.

Required reading remains:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/05-s4b-controller-route-disposition.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/12-s5a-raw-control-removal.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`

Version rule: OpenClaw `2026.6.5` is the minimum acceptable runtime. Current
proven branch runtime is `2026.6.8`; do not downgrade. Only move newer if
concrete runtime evidence requires it.

Scope: this repo plus explicit proof use of `../shravan-claw-beta` for actual
Discord/OpenClaw validation. Do not print secrets or `op://` refs. Do not revert
unrelated dirty files.

Non-goals: no OpenClaw sidecar control service; no Socket.IO polling fallback;
no raw `controller.vm.host:18800` control fallback; no moving Worker task
submit/state/close off ingress HTTP in this cutover; no control-socket bulk data
path; no PR merge unless explicitly authorized.

Terminal condition: PR created or updated and proven ready, implementation
review findings addressed or explicitly rejected, required proof gates captured,
current PR checks/review-thread/mergeability state reported, and PR merge not
performed unless explicitly authorized.

Stop conditions: stop before editing unrelated infrastructure or unrelated dirty
files; stop and reconverge if code evidence contradicts the accepted
control-plane model; do not mark S6b complete until gateway recovery
corroboration is proven and Q2 worker corroboration is either completed or
explicitly split as still blocked.

phase_result: complete
evidence: host goal cannot be rewritten while active; latest proven checkpoint
is Event 55 S4b `/lease*` route disposition; focused controller typecheck,
route unit, targeted integration, plugin typecheck, full integration, and
`pnpm check` are green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume with gateway-side S6b recovery
corroboration and budget, splitting worker S6b if Q2 remains unresolved.

## S4a Runtime Partial Receipt - 2026-07-02T22:18:10Z

Status: partial progress, not complete.

Landed:

- Controller control-session client now accepts an optional dispatcher and
  handles peer-originated `control:message` frames from the VM/plugin side.
- Inbound messages are parsed with the shared `ControlEnvelopeSchema`, checked
  against the control-channel size/bulk boundary, and dispatched through the
  existing per-domain `ControlSessionDispatcher`.
- OpenClaw gateway control service now tracks the accepted Socket.IO connection
  and exposes `emitApplicationMessage(envelope, domainMessage, payload)` so the
  VM-side service can send RPC messages to the controller and await an ack/result.
- `@agent-vm/openclaw-agent-vm-plugin` now depends on
  `@agent-vm/gateway-control-contracts` for the gateway delivery policy table.

Red/green proof:

- Controller red proof failed as expected before implementation:
  peer-originated server `control:message` timed out because the controller
  client had no inbound listener.
- Plugin service red proof failed as expected before implementation:
  `emitApplicationMessage` was missing.
- Focused green proof after implementation and formatting:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  passed 2 files / 23 tests.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm install --lockfile-only`: exit 0 after adding the workspace dependency.

Design gap before continuing lease caller rewire:

- `GatewayControlLeaseCreateIntentPayloadSchema` requires an opaque
  controller-issued `callerContextId`.
- The current OpenClaw lease caller only has the old raw authority fields at
  lease-call time: `agentId`, `profileId`, `sessionKey`,
  `agentWorkspaceDir`, and `workMountDir`.
- The spec forbids those trusted fields on model-visible/gateway payloads and
  says `GatewayControlTrustedLeaseContextSchema` is controller-private state.
- Current code has no issuance/provisioning path for per-call
  `callerContextId` beyond the contract schema itself.

Do not remove `controller-lease-client.ts` or rewire lease creation until the
caller-context issuance model is explicit. Candidate decisions to resolve:

- Controller pre-provisions caller contexts into the VM/plugin runtime config.
- Gateway asks for a caller context through a separate approved control
  operation before `lease_create`.
- The adapter/call surface derives a trusted caller context locally, but then
  the spec must define why that is still controller-private and not a forged
  gateway authority claim.

## Scope

Allowed write scope is this repo unless a proof lane explicitly uses an
external deployment. The external full-system proof target is
`../shravan-claw-beta` with actual Discord and actual OpenClaw.

## Non-Goals

- No sidecar control service for managed OpenClaw.
- No Socket.IO polling fallback.
- No raw `controller.vm.host:18800` control fallback.
- No moving Worker task submit/state/close off existing ingress HTTP in this
  cutover.
- No control-socket bulk data path.
- No merge without explicit user authorization.

## Requirements/Proof Matrix

The canonical requirements/proof matrix is:

`docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`

Important rows and gates:

- `GATE-0a`: exact OpenClaw `2026.6.8` runtime `handleUpgrade` plus pre-101 auth.
  evidence source: implementation-execute-plan runtime spike.
  freshness guard: assert actual runtime version and good/bad Socket.IO upgrade
  on the delivered artifact.
- `INGRESS-1` / `FLAP-1B`: real OpenClaw ingress Socket.IO e2e.
  evidence source: `mise exec -- pnpm run test:e2e:openclaw`.
  freshness guard: nonzero tests, zero skipped, zero todo.
- `worker control e2e`: worker Socket.IO handshake and git RPC path.
  evidence source: `mise exec -- pnpm run test:e2e:worker`.
  freshness guard: nonzero tests, zero skipped, zero todo.
- `GIT-1`: SG (SSH Git) host-boundary receive-pack denial.
  evidence source: `mise exec -- pnpm run test:e2e:vm`.
  freshness guard: proves Gondolin host boundary, not mocked policy.
- Full-system beta proof with actual Discord and OpenClaw.
  evidence source: `../shravan-claw-beta` deployment run/logs.
  freshness guard: actual Discord and actual OpenClaw path, not mocks.
- Full repo gate.
  evidence source: `pnpm check` plus required targeted unit/integration/e2e
  commands.
  freshness guard: run after implementation diff is final.

## Stop Conditions

- Stop and route back to spec if OpenClaw `2026.6.8` cannot provide plugin
  `handleUpgrade` with pre-101 private auth.
- Stop before claiming full S3 complete until the remaining runtime wiring,
  backpressure, replay/dedupe, fencing, recovery, and S2+S3 e2e proof rows are
  implemented or split with explicit evidence.
- Stop before claiming done if OPEN-4 proof-gating, Q1 route default, OPEN-2
  collector disposition, or Q2 worker probe source blocks the relevant slice.
- Stop before changing unrelated dirty files or unrelated infrastructure
  failures.

## Checkpoint Rhythm

- Use `slices/README.md` as the execution index.
- After each slice, run its local proof rows and record `phase_result`,
  evidence, recommended next workflow, and transition reason.
- Checkpoint commit at verified lifecycle checkpoints when scoped files changed
  and repo policy permits. Do not stage unrelated files.
- The orchestrator writes official transitions to
  `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`.

## Remade Goal Contract - 2026-07-02T22:21:14Z

Status: active, not complete.

The active Codex host goal object still cannot be replaced while unfinished.
Do not mark the long-horizon goal complete or blocked just to rewrite older
host-goal prose. Treat this section plus the latest valid
`shravan-dev-workflow:orchestrator-goal` event in `events.jsonl` as the current
resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`, with a
design/spec reconvergence checkpoint before more S4a lease caller code changes.

Current checkpoint:

- `GATE-0a`, `S1`, `SWa`, `S2`, local `S3`, real OpenClaw ingress/flap e2e,
  `S6a`, `S6c`, `S7`, `S4b` zone-git push route-family deletion, and the `S4a`
  gateway-control contract-union foundation are locally complete and green.
- S4a runtime made partial progress: the controller can now receive
  peer-originated `control:message` frames and dispatch them through
  `ControlSessionDispatcher`, and the OpenClaw plugin gateway-control service
  can emit `control:message` over the accepted Socket.IO session and await an
  ack/result.
- S4a lease/use caller rewire is intentionally paused. The spec requires an
  opaque controller-issued `callerContextId`, but the current OpenClaw lease
  caller only has legacy raw authority fields at lease-call time:
  `agentId`, `profileId`, `sessionKey`, `agentWorkspaceDir`, and
  `workMountDir`.
- Do not delete `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`,
  remove `/lease*` routes, or smuggle raw trusted fields through
  `gateway_control` RPC until caller-context issuance is specified and
  implemented.

First checkpoint on resume:

1. Re-read the trusted caller context sections in:
   - `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
   - `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`
   - `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
2. Re-read the current lease/control call sites:
   - `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
   - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
   - `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts`
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts`
   - `packages/agent-vm/src/controller/control-session/control-session-client.ts`
   - `packages/agent-vm/src/controller/control-session/control-session-dispatcher.ts`
   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
3. Choose and record the caller-context issuance model before continuing
   implementation. The known candidate models are:
   - controller pre-provisions caller contexts into VM/plugin runtime config;
   - gateway asks controller for a caller context through a separate approved
     control operation before `lease_create`;
   - adapter/call surface derives trusted caller context locally, but then the
     spec must explain why that remains controller-private and cannot be forged
     by gateway/model-visible payloads.
4. If the accepted model changes S4a requirements, update the spec and slice
   plan first, then return to normal TDD implementation.

Proof already recorded for the S4a runtime partial:

- focused integration passed 2 files / 23 tests for controller inbound dispatch
  and plugin `emitApplicationMessage`;
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0;
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0;
- `pnpm install --lockfile-only`: exit 0.

phase_result: needs_revision
evidence: S4a transport seam is green, but lease caller rewire needs
caller-context issuance design/spec reconciliation before more implementation
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the goal, but start the next pass by
resolving and documenting the `callerContextId` issuance model before S4a
lease/use RPC rewiring or `/lease*` route disposition.

## S4a Caller Context Issuance Checkpoint - 2026-07-02T22:29:38Z

Status: caller-context issuance model is specified and the controller-side
issuance helper is locally green. Full S4a lease/use RPC parity remains open.

Decision landed:

- Use a separate `caller_context_register` gateway-control operation before
  `lease_create`.
- `caller_context_register` carries OpenClaw adapter-derived evidence as
  untrusted input. The controller validates it against the accepted control
  session and zone before creating/reusing controller-private caller context
  state.
- `lease_create` still carries only `callerContextId`, correlation, and
  untrusted request hints. It does not carry raw authority fields.
- `GatewayControlRpcResponsePayloadSchema.callerContext` is the response path
  for the opaque issued id.

Behavior landed:

- Added `caller_context_register` to the generic gateway-control operation
  union and delivery-policy map.
- Added `GatewayControlCallerContextRegisterPayloadSchema`.
- Added `callerContext` to gateway-control command-result response payloads.
- Added `createGatewayControlCallerContextRegistry`, which dedupes the same
  accepted-session evidence, stores `sessionKeyDigest`, and does not retain raw
  `sessionKey` in the trusted context object.
- Added `createGatewayControlDomainHandler`, registered through the existing S3
  dispatcher seam, to process `caller_context_register` and return only the
  opaque `callerContextId`.
- Updated the hard-cutover spec, root implementation plan, and S4a slice plan
  with the register-then-create issuance model.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts`
  passed 3 files / 11 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched S4a contract/control-session files:
  exit 0.

Still open:

- Wire the domain handler into the production gateway control session
  dispatcher at gateway start.
- Implement lease/create/get/peek/renew/release and active-use
  start/heartbeat/end handler parity.
- Add the plugin-side gateway-control lease client and rewire
  `sandbox-backend-handle-factory.ts`.
- Delete the old HTTP `controller-lease-client.ts` and dispose `/lease*`
  routes only after parity is proven.

phase_result: complete
evidence: caller_context_register contract/spec/plan model plus controller
registry and dispatcher handler tests are green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a by wiring the handler into
production control-session startup, then implement lease/use RPC parity and
plugin lease-client rewire with red/green integration proof.

## S4a Production Caller Context Handler Wiring - 2026-07-02T22:32:14Z

Status: production gateway control-session startup now wires the
`caller_context_register` handler. Full S4a lease/use RPC parity remains open.

Behavior landed:

- `connectGatewayControlSession` accepts an optional S3 dispatcher and passes it
  into `createControlSessionClient`.
- `GatewayControlSessionConnector` options include the dispatcher.
- OpenClaw gateway startup creates a `ControlSessionDispatcher`, registers the
  `gateway_control` domain with `createGatewayControlDomainHandler`, and passes
  that dispatcher to the gateway control-session connector.
- The caller-context registry is created per gateway control session startup.

Proof:

- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  passed 1 file / 48 tests.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts`
  passed 3 files / 11 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched S4a contract/control-session/gateway
  files: exit 0.

Still open:

- Lease/create/get/peek/renew/release and active-use start/heartbeat/end
  handler parity.
- Plugin-side `LeaseClient` over gateway-control Socket.IO.
- Removal of old HTTP lease client and `/lease*` route disposition after parity.

phase_result: complete
evidence: production startup passes a dispatcher with caller_context_register
handler; focused integration/unit/typecheck/format proof is green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a with lease/use RPC parity and
plugin lease-client rewire before deleting old HTTP lease surfaces.

## Remade Goal Contract - 2026-07-02T22:36:47Z

Status: active, not complete.

The active Codex host goal object still cannot be replaced while unfinished.
Do not mark the long-horizon goal complete or blocked just to rewrite older
host-goal prose. Treat this section plus the latest valid
`shravan-dev-workflow:orchestrator-goal` event in `events.jsonl` as the current
resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Current checkpoint:

- `GATE-0a`, `S1`, `SWa`, `S2`, local `S3`, real OpenClaw ingress/flap e2e,
  `S6a`, `S6c`, `S7`, `S4b` zone-git push route-family deletion, the `S4a`
  gateway-control contract-union foundation, the S4a bidirectional Socket.IO
  transport seam, and the S4a caller-context issuance/production dispatcher
  seam are locally complete and green.
- The current active work remains `S4a`: implement gateway-control lease/use
  RPC parity and the plugin-side lease client rewire.
- OpenClaw `2026.6.5` remains the minimum acceptable runtime. The current
  proven delivered runtime in this branch is OpenClaw `2026.6.8` from
  `origin/master` integration and `GATE-0a`; do not downgrade runtime metadata
  inside S4a. Re-evaluate only if runtime evidence fails.
- `caller_context_register` is the accepted issuance model. It carries
  untrusted adapter evidence, the controller validates and binds it to the
  accepted session/zone, and `lease_create` receives only opaque
  `callerContextId` plus allowed request hints.
- Do not remove
  `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`, delete
  `/lease*` routes, or remove old HTTP lease surfaces until lease/use RPC
  parity and plugin caller rewire are proven.
- Do not smuggle legacy raw authority fields such as `agentId`, `profileId`,
  raw `sessionKey`, `agentWorkspaceDir`, or `workMountDir` through
  `lease_create`.

First checkpoint on resume:

1. Re-read the active slice and current route/caller code:
   - `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`
   - `packages/agent-vm/src/controller/http/controller-http-routes.ts`
   - `packages/agent-vm/src/controller/http/controller-http-route-support.ts`
   - `packages/agent-vm/src/controller/http/controller-lease-response-types.ts`
   - `packages/agent-vm/src/controller/leases/lease-manager.ts`
   - `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
   - `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
   - `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
   - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
2. Extract or reuse the HTTP lease authority helpers rather than duplicating
   hidden policy:
   - OpenClaw Gondolin lease contract validation
   - runtime readiness and zone/profile selection
   - work-mount translation
   - idle TTL policy
   - lease-manager create/renew/active-use behavior
   - HTTP-equivalent error/result serialization where the RPC needs parity
3. Add red tests before implementation for:
   - `caller_context_register` followed by `lease_create` returns a sanitized
     gateway-control lease snapshot;
   - raw authority fields in `lease_create` stay rejected;
   - `lease_get`, `lease_peek`, `lease_renew`, and `lease_release` map through
     the lease manager correctly;
   - active-use start/heartbeat/end map through the lease manager and preserve
     only allowlisted correlation.
4. Implement controller-side lease/use RPC handler parity first.
5. Then implement the plugin-side gateway-control lease client and rewire
   `sandbox-backend-handle-factory.ts`.
6. Only after parity and rewire proof is green, continue S4b `/lease*` route
   disposition and old HTTP caller deletion.

Proof already recorded for the immediate prior checkpoint:

- focused gateway-zone-orchestrator integration passed 1 file / 48 tests;
- focused caller-context/domain-contract unit proof passed 3 files / 11 tests;
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0;
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0;
- `pnpm exec oxfmt --check` on touched S4a contract/control-session/gateway
  files: exit 0.

phase_result: complete
evidence: goal remade at the S4a lease/use RPC parity resume edge after
caller-context issuance and production dispatcher wiring proof
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a with controller-side lease/use RPC
parity tests and implementation before plugin caller rewire or old HTTP surface
removal.

## S4a Lease/Use RPC Handler Seam Checkpoint - 2026-07-02T22:48:36Z

Status: partial S4a controller-side progress, not full S4a completion.

Behavior landed:

- `GatewayControlRpcMessage` now exports typed lease/create/use payload and
  snapshot aliases so controller code can stay schema-derived.
- `createGatewayControlDomainHandler` now handles:
  - `control_ping`
  - `caller_context_register`
  - `lease_create`
  - `lease_get`
  - `lease_peek`
  - `lease_renew`
  - `lease_release`
  - `lease_use_start`
  - `lease_use_heartbeat`
  - `lease_use_end`
- The handler resolves `lease_create` through registered opaque
  `callerContextId`; unknown contexts return a rejected command result instead
  of smuggling raw authority fields.
- Active-use start correlation is normalized through the allowlisted
  `ToolVmActiveUseCorrelation` shape before it reaches the lease RPC adapter.
- `caller_context_register` now validates OpenClaw `sessionKey` shape and
  verifies `agentId` matches the `sessionKey` agent while the raw key is still
  available; trusted context storage still retains only `sessionKeyDigest`.
- Added `createGatewayControlLeaseRpcOperations`, a controller-side adapter
  that maps gateway-control lease/use operations onto `ControllerLeaseManager`.
  It requires a controller-owned `resolveLeaseCreateOptions` callback, so it
  cannot invent profiles, work mounts, TTLs, or authority fields.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts`
  passed 4 files / 22 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched S4a contract/control-session files:
  exit 0.

Known limitation:

- This is not full lease/use RPC parity yet. Production gateway startup does
  not yet inject `createGatewayControlLeaseRpcOperations`.
- The next pass must wire the adapter with the real controller-owned
  profile/work-mount/idle-TTL/runtime-readiness/seed resolver instead of a
  partial resolver.
- Plugin-side lease client rewire and old HTTP lease surface deletion are still
  blocked on that production wiring and proof.

phase_result: complete
evidence: S4a controller-side handler seam and lease-manager adapter are green
with focused unit/typecheck/format proof; production injection remains open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a by wiring
`createGatewayControlLeaseRpcOperations` into production gateway-control
startup with the real controller lease-create resolver, then rewire the plugin
lease client before deleting old HTTP lease surfaces.

## S4a Production Lease RPC Injection Checkpoint - 2026-07-02T22:57:07Z

Status: controller-side production lease/use RPC path is wired. Full S4a still
requires plugin-side lease-client rewire and old HTTP caller removal.

Behavior landed:

- Added `createOpenClawToolVmLeaseCreateOptionsResolver`, a controller-owned
  resolver for OpenClaw Tool VM lease create options.
- The resolver owns the same authority inputs the HTTP route uses:
  - zone lookup and OpenClaw gateway check
  - OpenClaw runtime-status freshness check
  - zone agent/default/profile selection
  - work-mount translation
  - sandbox seeding through the controller secret resolver
  - idle TTL policy
- `createGatewayControlLeaseRpcOperations` forwards the `lease_create` payload
  to the resolver, including `idleTtlHintMs`, while still requiring a
  controller-owned resolver for final lease-manager create options.
- Controller runtime now creates one `OpenClawRuntimeStatusStore` and passes it
  to both HTTP controller routes and gateway-control lease RPC resolution.
- Controller runtime now creates `gatewayControlLeaseRpc` from the real
  `leaseManager` and passes it into OpenClaw gateway starts.
- `startGatewayZone` accepts optional `gatewayControlLeaseRpc` and gives it to
  the `gateway_control` domain handler.
- Gateway startup integration now captures the production dispatcher and proves
  `caller_context_register` followed by `lease_create` reaches the injected
  lease RPC with an opaque `callerContextId`.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts`
  passed 4 files / 22 tests.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  passed 1 file / 48 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched S4a contract/control-session/runtime/
  gateway files: exit 0.

Still open:

- Plugin-side gateway-control lease client must replace the old HTTP
  `controller-lease-client.ts` caller in `sandbox-backend-handle-factory.ts`.
- Old HTTP lease client and `/lease*` route disposition remain gated until
  plugin rewire proof is green.

phase_result: complete
evidence: S4a production controller-side lease RPC injection is green with
focused unit/integration/typecheck/format proof; plugin rewire remains open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a by implementing the plugin-side
gateway-control lease client and rewiring sandbox backend handle creation off
the old HTTP controller lease client.

## Goal Remake After Compaction - 2026-07-02T23:01:05Z

Status: active goal contract remade from durable workflow state. The active
Codex host goal still cannot be replaced while unfinished, so this section and
the transition log are the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Current active slice: `S4a` gateway-control runtime lease/use RPC parity and
plugin caller rewire.

Latest green checkpoint:

- S4a production controller-side lease RPC injection is locally green.
- Controller runtime creates real gateway-control lease RPC operations and
  passes them into OpenClaw gateway starts.
- Production dispatcher integration proves `caller_context_register` followed
  by `lease_create` reaches injected lease RPC through opaque
  `callerContextId`.

Next implementation move:

1. Re-read the S4a slice and plugin lease caller files.
2. Implement the plugin-side gateway-control lease client.
3. Rewire `sandbox-backend-handle-factory.ts` off the old raw HTTP
   `controller-lease-client.ts` path.
4. Preserve hard-cutover rules: no raw controller URL fallback, no Socket.IO
   polling fallback, no deletion of `/lease*` routes until plugin rewire and
   parity proof are green.

Required proof for the next checkpoint:

- targeted plugin lease-client unit tests with red/green evidence;
- sandbox backend factory tests proving the Socket.IO lease client path is used;
- plugin and controller package typechecks;
- targeted S4a integration/unit proof;
- oxfmt check on touched files.

phase_result: complete
evidence: active goal contract remade after compaction from latest valid
orchestrator event and details.md; latest active edge is S4a plugin-side
gateway-control lease client rewire
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a with plugin-side lease client
implementation and sandbox backend rewire before any old HTTP lease surface
deletion.

## S4a Plugin Gateway-Control Lease Client Checkpoint - 2026-07-02T23:13:08Z

Status: plugin-side lease/use RPC client path is locally green. Full S4a still
requires old HTTP lease caller/file deletion and `/lease*` route disposition
in the later S4b/S5 sequence.

Behavior landed:

- Added `createGatewayControlLeaseClient`, a plugin-side `LeaseClient`
  implementation that sends lease/use commands over the accepted
  `gateway_control` Socket.IO session.
- `requestLease` now uses the accepted register-then-create model:
  `caller_context_register` carries untrusted adapter evidence, the controller
  returns opaque `callerContextId`, and `lease_create` carries only
  `callerContextId` plus allowed hints such as `idleTtlHintMs`.
- The gateway-control lease snapshot now carries the fields needed by the
  existing Tool VM lease contract: `agentId`, `idleTtlMs`, `transport`,
  `tcpSlot`, `workdir`, and SSH `user`/`knownHostsLine` parity.
- Controller-side gateway-control lease serialization now distinguishes
  private SSH snapshots for create/get/renew from public SSH snapshots for
  peek.
- Active-use RPC snapshots now include `expiresAt` and `heartbeatAfterMs` so
  the existing active-use heartbeat loop can run over gateway-control RPC.
- `openclaw-plugin-registration.ts` creates one gateway-control lease client
  per plugin control service and injects it into sandbox backend dependencies.
- `sandbox-backend-handle-factory.ts` and `sandbox-backend-manager.ts` no
  longer import or create the raw HTTP controller lease client directly; they
  require an injected lease-client provider. Registration still owns the
  temporary HTTP fallback when control-session config is absent until the
  later hard-removal slice.

Red evidence:

- Contract red: `GatewayControlLeaseSnapshotSchema` rejected the Tool VM lease
  parity fields and old SSH `user` shape.
- Plugin red: `gateway-control-lease-client.unit.test.ts` failed because
  `./gateway-control-lease-client.js` did not exist.

Proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  passed 6 files / 71 tests.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  passed 2 files / 51 tests.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched S4a contract/controller/plugin files:
  exit 0.
- `pnpm test:unit`: exit 0, taxonomy passed, 232 files / 2073 tests.
- `pnpm test:integration`: exit 0, 27 files / 375 tests.

Still open:

- Delete or retire the old raw HTTP `controller-lease-client.ts` file and its
  tests only after follow-on callers are untangled.
- `/lease*` server route disposition remains gated by S4b after caller-side
  parity is complete.
- Runtime-status and health-event HTTP publishing are later-owned by S6/S4b;
  this checkpoint intentionally did not broaden into those route families.

phase_result: complete
evidence: S4a plugin-side gateway-control lease client and sandbox backend
injection are green with red/green unit evidence, targeted integration,
package typechecks, and formatter proof
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a/S4b sequencing by removing old
HTTP lease callers when safe, then applying `/lease*` route disposition after
caller-side parity is proven.

## Goal Remake After Compaction - 2026-07-02T23:16:47Z

Status: active host `/goal` text is stale and cannot be replaced while the
Codex goal remains unfinished. This section and the transition log are the
current durable resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Next workflow: `shravan-dev-workflow:implementation-execute-plan`.

Current active sequence: continue `S4a/S4b` from the plugin-side
gateway-control lease client checkpoint.

Latest valid checkpoint:

- `S4a` plugin-side gateway-control lease client and sandbox backend injection
  are locally green.
- Full-slice proof has been strengthened with `pnpm test:unit` and
  `pnpm test:integration`.
- Old HTTP lease client and `/lease*` route disposition are not complete and
  remain gated by caller-side parity and S4b sequencing.

Immediate next implementation move:

1. Inspect live `pnpm lint:types` output and fix scoped S4a errors before
   claiming the current checkpoint clean at `pnpm check`.
2. Expected scoped fixes from the handoff:
   - make `OpenClawRuntimeStatusStore` a type-only import in
     `packages/agent-vm/src/controller/leases/openclaw-tool-vm-lease-create-options.ts`;
   - satisfy `consistent-return` in
     `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`;
   - remove `unbound-method` expectations from
     `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`.
3. Re-run focused S4a unit/integration proof, package typechecks,
   `pnpm lint:types`, and `pnpm check`.
4. Continue old HTTP lease caller cleanup only after the scoped lint/check gate
   is green.
5. Do not delete `/lease*` routes until S4b route disposition is active and
   caller-side parity remains proven.

Hard boundaries still active:

- no raw `controller.vm.host:18800` control fallback;
- no Socket.IO polling fallback;
- no OpenClaw sidecar control service;
- runtime-status and health-event HTTP route families remain later-owned by
  their slices;
- Worker task submit/state/close remain ingress HTTP in this cutover;
- OpenClaw `2026.6.5` is the minimum acceptable runtime, and the current proven
  branch runtime remains `2026.6.8`; do not downgrade.

phase_result: complete
evidence: active host goal cannot be rewritten; latest durable checkpoint is
S4a plugin-side gateway-control lease client with full unit/integration proof;
handoff reports current `pnpm check` blocker is scoped `lint:types` cleanup
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by fixing scoped S4a lint/type-aware
lint issues, rerun focused and full gates, then continue S4a/S4b old HTTP
lease caller cleanup and `/lease*` route disposition sequencing.

## S4a Lint Recovery And Lease Fallback Removal Checkpoint - 2026-07-02T23:24:43Z

Status: the scoped `lint:types` blocker is fixed, and full OpenClaw plugin
registration no longer falls back to the raw HTTP lease client when
`controlSession` is absent.

Behavior landed:

- Converted the OpenClaw runtime status store import in
  `openclaw-tool-vm-lease-create-options.ts` to a type-only import.
- Made `gateway-control-domain-handler.ts` explicitly fail closed after its
  operation switch so type-aware lint no longer sees an async handler path
  without a return/throw.
- Removed unbound-method expectations from
  `gateway-control-domain-handler.unit.test.ts` by asserting against local
  `vi.fn` references.
- Made full `openclaw-plugin-registration.ts` require `controlSession` and
  `registerHttpRoute`.
- Removed the plugin registration fallback from the gateway-control lease
  client to `createLeaseClient({ controllerUrl })`; sandbox backends now
  receive the gateway-control lease client in full managed registration.
- Added a fail-closed registration unit test proving missing `controlSession`
  does not silently fall back to raw lease HTTP.

Proof:

- `pnpm lint:types`: exit 0, 393 warnings / 0 errors before fallback removal.
- Focused S4a unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  passed 6 files / 72 tests.
- Focused S4a integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  passed 2 files / 51 tests.
- Package typechecks passed for `@agent-vm/openclaw-agent-vm-plugin`,
  `@agent-vm/agent-vm`, and `@agent-vm/gateway-control-contracts`.
- Post-format focused smoke:
  `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  passed 2 files / 26 tests.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- `pnpm exec oxfmt --check` on touched registration/S4a files: exit 0.
- `pnpm check`: exit 0, 8 passed / 0 failed; type-aware lint reported 392
  warnings / 0 errors.
- Residue scan found no remaining `gatewayControlLeaseClient ??` fallback and
  no `createLeaseClient({ controllerUrl: pluginConfig.controllerUrl })`
  registration fallback.

Still open:

- `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts` remains
  because runtime-status HTTP publishing and the shared `LeaseClient` contract
  are still entangled with it. Runtime-status HTTP publishing is later-owned by
  S6/S4b, and the lease-client contract should move before deleting the legacy
  HTTP implementation file outright.
- `/lease*` route disposition remains gated by S4b after caller-side parity and
  legacy file cleanup are complete.

phase_result: complete
evidence: S4a scoped lint/type-aware lint blockers fixed; full managed plugin
registration now requires controlSession and no longer falls back from
gateway-control lease client to raw HTTP lease client; focused unit/integration,
package typechecks, formatter check, and pnpm check are green
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a by separating the generic
LeaseClient contract from the legacy HTTP implementation and retiring the old
lease HTTP implementation when runtime-status ownership is resolved, then move
to S4b `/lease*` route disposition.

## Remade Goal Contract - 2026-07-02T23:27:26Z

The active Codex host goal cannot be replaced while unfinished, so this section
is the compact remade goal contract. Per `orchestrator-goal` precedence, the
latest valid event in `events.jsonl` and this details file supersede stale host
goal wording about first starting from upstream integration or GATE-0a.

Goal id: `2026-07-02-socketio-control-plane`

Required workflow skill: `shravan-dev-workflow:orchestrator-goal`

Current workflow: `shravan-dev-workflow:implementation-execute-plan`

Next workflow: `shravan-dev-workflow:implementation-execute-plan`

Objective: finish the Socket.IO-over-Gondolin control-plane hard cutover
through implementation, proof, implementation review, and PR-ready non-merge
wrapup.

Current checkpoint: `S4a` lint recovery and managed plugin lease fallback
removal are locally complete and green. Latest valid orchestrator event count is
49 before this remake event.

Immediate next implementation move:

1. Separate the generic `LeaseClient`, lease request error, JSON value, lease
   request/response, and runtime-status shared types from the legacy HTTP
   implementation in `packages/openclaw-agent-vm-plugin`.
2. Update gateway-control lease client, sandbox backend, and the legacy HTTP
   client to import those neutral contracts.
3. Retire old lease HTTP implementation surfaces only when runtime-status
   ownership and `S4b` route disposition permit it.
4. Do not delete `/lease*` routes until `S4b` route disposition is active and
   caller-side parity remains proven.

Required reading remains:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`

Version rule: OpenClaw `2026.6.5` is the minimum acceptable runtime. Current
proven branch runtime is `2026.6.8`; do not downgrade. Only move newer if
concrete runtime evidence requires it.

Scope: this repo plus explicit proof use of `../shravan-claw-beta` for actual
Discord/OpenClaw validation. Do not print secrets or `op://` refs. Do not revert
unrelated dirty files.

Non-goals: no OpenClaw sidecar control service; no Socket.IO polling fallback;
no raw `controller.vm.host:18800` control fallback; no moving Worker task
submit/state/close off ingress HTTP in this cutover; no control-socket bulk data
path; no PR merge unless explicitly authorized.

Terminal condition: PR created or updated and proven ready, implementation
review findings addressed or explicitly rejected, required proof gates captured,
current PR checks/review-thread/mergeability state reported, and PR merge not
performed unless explicitly authorized.

Stop conditions: stop before deleting `/lease*` until `S4b` route disposition is
active and caller-side parity remains proven; stop before unrelated
infrastructure edits; reconverge if code evidence contradicts the accepted
control-plane model.

## S4a Neutral Lease Client Contract Split Checkpoint - 2026-07-02T23:33:12Z

Status: neutral lease-client contract cleanup is complete and green.

Behavior landed:

- Added `packages/openclaw-agent-vm-plugin/src/lease-client-contract.ts` as the
  neutral owner for `LeaseClient`, `ControllerLeaseRequestError`, JSON value,
  lease request/snapshot types, and the runtime-status report type export.
- Reduced `controller-lease-client.ts` to the legacy HTTP implementation plus
  compatibility re-exports.
- Rewired gateway-control lease client, sandbox backend contracts, sandbox
  backend manager, sandbox backend handle factory, and related tests to import
  shared lease contracts from `lease-client-contract.ts`.
- Left runtime-status HTTP publishing and `/lease*` route disposition untouched
  because they are later-owned by S6/S4b sequencing.

Proof:

- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- Focused plugin unit proof passed 5 files / 92 tests.
- Focused plugin integration proof passed 2 files / 6 tests.
- Broader S4a unit proof passed 8 files / 110 tests.
- Broader S4a integration proof passed 3 files / 54 tests.
- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- `pnpm --filter @agent-vm/gateway-control-contracts typecheck`: exit 0.
- `pnpm lint:types`: exit 0, warnings only.
- `pnpm exec oxfmt --check` on touched files: exit 0.
- `pnpm check`: exit 0, 8 passed / 0 failed.

Residue:

- `controller-lease-client.ts` is now imported only for `createLeaseClient` in
  the legacy HTTP implementation test, plugin controller integration test, root
  package export, and `openclaw-plugin-registration.ts` runtime-status publisher.
- Full `controller-lease-client.ts` deletion remains gated by runtime-status
  ownership and S4b route disposition.
- `/lease*` routes are not deleted yet; S4b still owns route disposition after
  caller-side parity remains proven.

phase_result: complete
evidence: neutral lease-client contract module added; production/shared users
rewired off legacy HTTP type ownership; focused and broader S4a
unit/integration, affected package typechecks, lint:types, formatter, and
pnpm check exited 0
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue S4a/S4b by resolving the remaining
runtime-status HTTP publisher dependency on the legacy lease client, then delete
old lease HTTP implementation and proceed to `/lease*` route disposition only
after parity proof remains green.

## Remade Goal Contract - 2026-07-02T23:39:32Z

The active Codex host goal still cannot be replaced while unfinished. This
section is the compact remade contract after compaction, based on live durable
state plus the current worktree. Per `orchestrator-goal` precedence, this
details section and event 52 supersede stale host goal wording.

Goal id: `2026-07-02-socketio-control-plane`

Required workflow skill: `shravan-dev-workflow:orchestrator-goal`

Current workflow: `shravan-dev-workflow:implementation-execute-plan`

Next workflow: `shravan-dev-workflow:implementation-execute-plan`

Objective: finish the Socket.IO-over-Gondolin control-plane hard cutover
through implementation, proof, implementation review, and PR-ready non-merge
wrapup.

Current proven checkpoint: `S4a` neutral lease-client contract split is
complete and green. Latest valid proven event before this remake is event 51.

Current unproven in-progress edge:

- Runtime-status HTTP publishing is being split out of the legacy
  `controller-lease-client.ts` so the legacy lease client can become lease-only
  before route disposition.
- `openclaw-runtime-status-client.ts` exists but its moved unit coverage is not
  proven yet.
- `LeaseClient.publishOpenClawRuntimeStatus` has been removed from the neutral
  `LeaseClient` contract in the worktree.
- Sandbox backend dependencies now carry optional
  `publishOpenClawRuntimeStatus`.
- `openclaw-plugin-registration.ts` calls the dedicated runtime-status
  publisher and injects it into backend dependencies.

Immediate next implementation move:

1. Finish migrating runtime-status tests out of
   `controller-lease-client.unit.test.ts` into
   `openclaw-runtime-status-client.unit.test.ts`.
2. Remove stale runtime-status expectations from
   `controller-lease-client.unit.test.ts`.
3. Run the S4a focused proof:
   `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`,
   focused plugin unit tests, focused plugin/controller integration tests,
   `pnpm lint:types`, and `pnpm check`.
4. Only if green, record the runtime-status publisher split as a completed
   checkpoint and continue toward old lease HTTP implementation cleanup.
5. Do not delete `/lease*` routes yet. `S4b` owns route disposition after
   caller-side parity remains proven.

Required reading remains:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/05-s4b-controller-route-disposition.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`

Version rule: OpenClaw `2026.6.5` is the minimum acceptable runtime. Current
proven branch runtime is `2026.6.8`; do not downgrade. Only move newer if
concrete runtime evidence requires it.

Scope: this repo plus explicit proof use of `../shravan-claw-beta` for actual
Discord/OpenClaw validation. Do not print secrets or `op://` refs. Do not revert
unrelated dirty files.

Non-goals: no OpenClaw sidecar control service; no Socket.IO polling fallback;
no raw `controller.vm.host:18800` control fallback; no moving Worker task
submit/state/close off ingress HTTP in this cutover; no control-socket bulk data
path; no PR merge unless explicitly authorized.

Terminal condition: PR created or updated and proven ready, implementation
review findings addressed or explicitly rejected, required proof gates captured,
current PR checks/review-thread/mergeability state reported, and PR merge not
performed unless explicitly authorized.

Stop conditions: stop before deleting `/lease*` until `S4b` route disposition is
active and caller-side parity remains proven; stop before unrelated
infrastructure edits; reconverge if code evidence contradicts the accepted
control-plane model; do not treat the runtime-status split as complete until
the focused proof is green and event 53 records it.

phase_result: complete
evidence: host goal cannot be rewritten while active; latest proven checkpoint
is S4a neutral lease-client contract split at event 51; live worktree shows
unproven runtime-status publisher split edits after event 51
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by completing runtime-status unit-test
migration and proof, then continue old lease HTTP cleanup and S4b route
disposition sequencing only after parity remains green.

## S4a Runtime-Status Publisher Split Checkpoint - 2026-07-02T23:45:12Z

Status: runtime-status publishing is split out of the legacy HTTP lease client
and locally green.

Behavior landed:

- Added `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.ts`
  as the dedicated HTTP publisher for
  `/zones/:zoneId/openclaw-runtime-status`.
- Removed `publishOpenClawRuntimeStatus` from the neutral `LeaseClient`
  contract.
- Removed runtime-status implementation and unit coverage from
  `controller-lease-client.ts` / `controller-lease-client.unit.test.ts`, so the
  legacy lease client is now lease/use focused.
- Added `openclaw-runtime-status-client.unit.test.ts` covering POST route shape,
  success-body drain, retryable `429` / `503` / `504` responses, timeout and
  transport error operation labels, and structured controller errors.
- Moved sandbox backend runtime-status publishing to the optional
  `CreateBackendDependencies.publishOpenClawRuntimeStatus` dependency.
- Updated `openclaw-plugin-registration.ts` to call the dedicated
  runtime-status publisher and inject it into sandbox backend dependencies.
- Exported `publishOpenClawRuntimeStatus` from the plugin package root.

Proof:

- Focused runtime-status/lease unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/controller-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.unit.test.ts`
  passed 2 files / 40 tests.
- Focused plugin unit proof:
  `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/controller-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts`
  passed 6 files / 96 tests.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- Focused plugin integration proof:
  `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/controller-integration.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  passed 2 files / 6 tests.
- `pnpm exec oxfmt --check` on the touched runtime-status/lease split files:
  exit 0.
- `pnpm lint:types`: exit 0, warnings only.
- `pnpm check`: exit 0, 8 passed / 0 failed.

Residue:

- `rg` found no remaining `LeaseClient.publishOpenClawRuntimeStatus` or
  `.publishOpenClawRuntimeStatus` method calls.
- Remaining `publishOpenClawRuntimeStatus` hits are the new backend dependency,
  dedicated publisher, package export, and tests.
- `controller-lease-client.ts` still exists for legacy lease/use HTTP
  implementation and compatibility export. Full deletion remains gated by old
  lease HTTP caller cleanup plus `S4b` `/lease*` route disposition.
- `/lease*` routes are not deleted yet.

phase_result: complete
evidence: runtime-status publisher extracted from legacy lease client; focused
unit and integration proof, package typecheck, formatter check, lint:types, and
pnpm check exited 0; residue scan found no old LeaseClient runtime-status method
usage
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue old lease HTTP implementation cleanup
and S4b `/lease*` route disposition sequencing, but delete routes only after
caller-side parity remains proven.

## Remade Goal Contract - 2026-07-02 S4b Lease Route Disposition Edge

The active Codex host goal still cannot be replaced while unfinished. This
section is the compact remade contract after compaction, based on the latest
valid transition log entry plus live worktree evidence. Per
`orchestrator-goal` precedence, event 54 and this section supersede stale host
goal wording for the current resume edge.

Goal id: `2026-07-02-socketio-control-plane`

Required workflow skill: `shravan-dev-workflow:orchestrator-goal`

Current workflow: `shravan-dev-workflow:implementation-execute-plan`

Next workflow: `shravan-dev-workflow:implementation-execute-plan`

Objective: finish the Socket.IO-over-Gondolin control-plane hard cutover
through implementation, proof, implementation review, and PR-ready non-merge
wrapup.

Current proven checkpoint: `S4a` runtime-status publisher split is complete and
green. Latest valid proven event before this remake is event 53 at
`2026-07-02T23:45:12Z`.

Current unproven in-progress edge:

- `S4b` `/lease*` route disposition has started.
- Old VM-facing `/lease*` handlers have been removed from
  `packages/agent-vm/src/controller/http/controller-http-routes.ts`.
- `GET /leases` remains as the operator diagnostic route.
- `leaseIdleTtlPolicy` has been removed from the HTTP route construction path
  because old HTTP lease creation no longer owns lease TTL selection.
- `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
  has a new route-disposition test expecting old `/lease*` mutation/snapshot
  routes to return `404`.
- Obsolete old `/lease*` behavior tests remain in
  `controller-http-routes.unit.test.ts`; they must be pruned or rewritten before
  S4b proof can pass.
- This S4b work is not yet proven and must not be recorded as complete until
  focused route unit, relevant integration, and `pnpm check` proof are green.

Immediate next implementation move:

1. Inspect the live diff for:
   `packages/agent-vm/src/controller/http/controller-http-routes.ts` and
   `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`.
2. Finish pruning tests whose only purpose was old HTTP `/lease*` behavior.
   Keep coverage for still-live surfaces: `GET /leases`, runtime-status routes,
   health-event routes, and zone operation routes.
3. Do not restore old `/lease*` handlers to satisfy tests. Hard cutover means
   the old VM-facing lease HTTP surface is gone after parity proof.
4. Run:
   `pnpm --filter @agent-vm/agent-vm typecheck`
5. Run:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
6. Run:
   `pnpm test:integration`
7. Run:
   `pnpm check`
8. If green, record S4b `/lease*` route disposition as event 55 and continue
   with the next DAG-ready route family or cleanup slice.

Required reading remains:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/05-s4b-controller-route-disposition.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`

Version rule: OpenClaw `2026.6.5` is the minimum acceptable runtime. Current
proven branch runtime is `2026.6.8`; do not downgrade. Only move newer if
concrete runtime evidence requires it.

Scope: this repo plus explicit proof use of `../shravan-claw-beta` for actual
Discord/OpenClaw validation. Do not print secrets or `op://` refs. Do not revert
unrelated dirty files.

Non-goals: no OpenClaw sidecar control service; no Socket.IO polling fallback;
no raw `controller.vm.host:18800` control fallback; no moving Worker task
submit/state/close off ingress HTTP in this cutover; no control-socket bulk data
path; no PR merge unless explicitly authorized.

Terminal condition: PR created or updated and proven ready, implementation
review findings addressed or explicitly rejected, required proof gates captured,
current PR checks/review-thread/mergeability state reported, and PR merge not
performed unless explicitly authorized.

Stop conditions: stop before editing unrelated infrastructure or unrelated dirty
files; stop and reconverge if code evidence contradicts the accepted
control-plane model; do not treat S4b `/lease*` route disposition as complete
until the old-route behavior tests are pruned/replaced and the proof commands
above are green.

phase_result: complete
evidence: host goal cannot be rewritten while active; latest proven checkpoint
is S4a runtime-status publisher split at event 53; live worktree shows unproven
S4b `/lease*` route disposition edits and old HTTP lease behavior tests still
need pruning
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by pruning obsolete `/lease*`
controller-route tests without restoring old handlers, then climb focused
route, integration, and `pnpm check` proof gates.

## S4b `/lease*` Route Disposition Checkpoint - 2026-07-02

Status: old VM-facing `/lease*` HTTP routes are deleted and locally green.

Behavior landed:

- Removed old `/lease*` handlers from
  `packages/agent-vm/src/controller/http/controller-http-routes.ts`.
- Kept `GET /leases` as the operator diagnostic route.
- Removed stale HTTP-route lease creation/renew/peek/release/active-use
  behavior tests from
  `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`.
- Kept an explicit route-disposition table proving the old VM-facing lease
  routes now return `404`:
  - `POST /lease`
  - `GET /lease/:leaseId`
  - `GET /lease/:leaseId/peek`
  - `POST /lease/:leaseId/renew`
  - `DELETE /lease/:leaseId`
  - `POST /lease/:leaseId/uses`
  - `POST /lease/:leaseId/uses/:useId/heartbeat`
  - `DELETE /lease/:leaseId/uses/:useId`
- Removed stale integration assertions that still depended on POST `/lease`:
  the gateway API HTTP integration now covers live gateway HTTP plus
  controller `GET /leases`, and the plugin controller integration no longer
  exercises the deleted controller-app lease route.

Proof:

- `pnpm --filter @agent-vm/agent-vm typecheck`: exit 0.
- Focused controller HTTP route unit:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
  passed 1 file / 50 tests.
- Targeted formerly failing integration files:
  `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts packages/openclaw-agent-vm-plugin/src/controller-integration.integration.test.ts`
  passed 2 files / 4 tests.
- `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`: exit 0.
- `pnpm test:integration`: exit 0, 27 files / 374 tests.
- `pnpm check`: exit 0, 8 passed / 0 failed.

Residue:

- `rg` over `packages/agent-vm/src/controller/http`,
  `gateway-api-http.integration.test.ts`, and
  `controller-integration.integration.test.ts` found no old `/lease*` route
  registration or old integration caller. Remaining hits are:
  - `app.get('/leases', ...)` in `controller-http-routes.ts`.
  - the route-disposition unit table.
  - the `GET /leases` unit and integration diagnostics.
- This completes the `/lease*` family of `S4b`, not the entire hard cutover.
  Health-events/runtime-status route disposition and later S5 hard-removal
  slices remain owned by their later gates.

phase_result: complete
evidence: old `/lease*` route handlers deleted; stale HTTP route/integration
tests pruned; focused typecheck, route unit, targeted integration, plugin
typecheck, full integration, and `pnpm check` exited 0
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue with the next DAG-ready route family or
removal slice from `slices/README.md`, preserving later ownership for
health-events/runtime-status disposition and S5 hard-removal work.

## Remade Goal Contract - 2026-07-03 S6b Gateway Recovery Resume Edge

The active Codex host goal still cannot be replaced while unfinished. This
section is the compact remade contract after compaction, based on the latest
valid orchestrator transition and current worktree evidence. Per
`orchestrator-goal` precedence, the latest valid transition log entry and this
section supersede stale host goal wording for the current resume edge.

Goal id: `2026-07-02-socketio-control-plane`

Required workflow skill: `shravan-dev-workflow:orchestrator-goal`

Current workflow: `shravan-dev-workflow:implementation-execute-plan`

Next workflow: `shravan-dev-workflow:implementation-execute-plan`

Objective: finish the Socket.IO-over-Gondolin control-plane hard cutover
through implementation, proof, implementation review, and PR-ready non-merge
wrapup.

Latest valid checkpoint: event 55, `S4b` `/lease*` route disposition complete
and green. Old VM-facing `/lease*` route handlers are removed. `GET /leases`
remains the operator diagnostic route.

Current resume edge: gateway-side `S6b` recovery corroboration and budget.

Current interrupted worktree edge:

- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`
  and its unit tests have in-progress S6b corroboration/source-key changes.
- `packages/agent-vm/src/controller/health/gateway-service-health-monitor.ts`
  and its unit tests have in-progress death-grace/source-key monitor changes.
- Gateway runtime source-key plumbing is in progress through:
  `packages/agent-vm/src/gateway/gateway-zone-support.ts`,
  `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`, and
  `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`.
- `controller-runtime.ts` still needs production source-key resolver wiring into
  `createGatewayServiceHealthMonitor`.
- The handoff reports the focused pure policy unit is green, but
  `gateway-service-health-monitor.unit.test.ts` still has failing S6b-adjacent
  monitor cases. Treat that as unproven until rerun in this session.

S6b target model:

- Recovery is an AND-gate, not a single failing observation.
- Gateway service probe failures alone must not restart.
- Gateway control-session observations alone must not restart.
- Recovery requires a controller-owned source key and controller probe
  corroboration.
- Recovery only fires after the control-session-death grace elapses with no
  reconnect.
- Reconnect or OK within grace cancels pending recovery.
- Budget key is controller-owned:
  `{ domain, zoneId, gatewayVmId, bootId, generationId }`.
- Do not trust spoofable health payload fields for recovery source identity.

Immediate next implementation move:

1. Re-read:
   `docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md`.
2. Inspect the live diff for the S6b files listed above.
3. Fix the focused monitor test failures without weakening the S6b invariant
   that service-only and control-session-only observations cannot restart or
   spend budget.
4. Wire production recovery source-key resolution in `controller-runtime.ts`
   from the current OpenClaw runtime lifecycle state.
5. Run focused proof:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts`
6. Run likely S6b type/integration proof:
   `pnpm --filter @agent-vm/agent-vm typecheck`
   and the relevant gateway runtime integration/unit files touched by source-key
   wiring.
7. Run slice gates:
   `pnpm test:unit`, `pnpm test:integration`, and `pnpm check`.
8. If green, record S6b gateway-side completion as a new orchestrator event.

Required reading remains:

- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md`
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md`
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/README.md`
- `docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/details.md`
- `tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl`

Version rule: OpenClaw `2026.6.5` is the minimum acceptable runtime. Current
proven branch runtime is `2026.6.8`; do not downgrade. Only move newer if
concrete runtime evidence requires it.

Scope: this repo plus explicit proof use of `../shravan-claw-beta` for actual
Discord/OpenClaw validation. Do not print secrets or `op://` refs. Do not revert
unrelated dirty files.

Non-goals for this S6b pass:

- Do not delete health-events routes.
- Do not delete runtime-status routes.
- Do not do S5 hard-removal residue cleanup.
- Do not work the Worker S6b path until Q2 worker probe-source ownership is
  resolved or split explicitly.
- Do not restore raw `controller.vm.host:18800` control fallback.

Terminal condition: PR created or updated and proven ready, implementation
review findings addressed or explicitly rejected, required proof gates captured,
current PR checks/review-thread/mergeability state reported, and PR merge not
performed unless explicitly authorized.

Stop conditions: stop before editing unrelated infrastructure or unrelated dirty
files; stop and reconverge if code evidence contradicts the accepted
control-plane model; do not mark S6b complete until source-key production
wiring and required proof gates are green.

phase_result: complete
evidence: host goal cannot be rewritten while active; latest valid checkpoint is
event 55 S4b `/lease*` route disposition complete and green; current worktree
contains unproven gateway-side S6b recovery corroboration edits; details.md was
remade to route resume to S6b instead of stale S4b sections
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume gateway-side S6b recovery corroboration,
fix focused monitor failures, wire controller-owned source-key resolution, then
climb focused unit, typecheck, unit, integration, and `pnpm check` proof gates.

## Current Resume Edge - Event 58

Gateway-side `S6b` recovery corroboration and budget is complete and locally
green.

Latest valid proven checkpoint:

- Event 58: gateway-side `S6b` recovery corroboration and budget.

Behavior landed:

- Recovery for running gateway restart is an AND-gate.
- Gateway service probe failures alone do not restart a running gateway.
- Gateway control-session observations alone do not restart a running gateway.
- Running gateway restart requires:
  - controller-owned recovery source key from accepted control-session
    material/runtime handle,
  - stale/degraded control-session observation past death grace,
  - failed controller-owned service probe corroboration.
- Reconnect or OK within grace cancels pending recovery.
- Failed-runtime/cold-start recovery remains allowed without source-key
  corroboration because that is controller-owned missing/failed runtime state,
  not a running-VM restart from gateway observations.

Controller-owned source key:

```text
{
  domain: "gateway_control",
  zoneId,
  gatewayVmId,
  bootId,
  generationId,
}
```

The controller resolves the key from
`registry.getOpenClawRuntime(zoneId).getLifecycleState().gateway.controlSessionRecoverySourceKey`.
It must not trust spoofable health-event payload fields for recovery identity.

Proof:

1. Focused unit:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
   - passed 3 files / 66 tests.
2. Focused integration:
   `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
   - passed 1 file / 48 tests.
3. Agent VM typecheck:
   `pnpm --filter @agent-vm/agent-vm typecheck`
   - passed.
4. Full unit:
   `pnpm test:unit`
   - passed taxonomy plus 233 files / 2044 tests.
5. Targeted gateway API integration:
   `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts`
   - passed 1 file / 2 tests.
6. Full integration:
   `pnpm test:integration`
   - passed 27 files / 374 tests.
7. Full check:
   `pnpm check`
   - passed 8 / 0 with type-aware lint warnings only.

Files changed for this checkpoint:

- `packages/agent-vm/src/controller/control-session/control-session-death-grace.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
- `packages/agent-vm/src/controller/health/gateway-recovery-actions.ts`
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.unit.test.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
- `packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts`

Current resume edge:

- Continue `shravan-dev-workflow:implementation-execute-plan`.
- Choose the next DAG-ready slice from the implementation plan.
- Worker `S6b` remains split/blockable on the `Q2` worker probe-source
  decision.
- Health-events/runtime-status route disposition remains later-owned.
- `S5` hard-removal work remains later-owned.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not delete health-events/runtime-status routes as part of gateway-side
  `S6b`.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.

phase_result: complete
evidence: gateway-side `S6b` recovery corroboration and budget completed with
focused unit, focused integration, package typecheck, full unit, full
integration, and `pnpm check` proof
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue from the next DAG-ready slice while
preserving Worker `S6b` as Q2-blocked/split and keeping route-disposition plus
hard-removal work on their owning slices.

## Remade Goal Contract - 2026-07-03 Health/Runtime Event Migration Edge

The active Codex host goal cannot be replaced while unfinished. Under
`orchestrator-goal` precedence, the latest valid transition log entry plus this
section supersede stale host-goal prose and earlier resume sections.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid proven checkpoint:

- Event 58: gateway-side `S6b` recovery corroboration and budget is complete
  and locally green.

Current active narrow slice:

- Migrate OpenClaw health-events/runtime-status publishing from old VM-facing
  HTTP mutation routes onto gateway-control event messages.
- Then perform `S4b` route disposition for the old HTTP mutation routes:
  - `POST /zones/:zoneId/health-events`
  - `POST /zones/:zoneId/openclaw-runtime-status`

Current unproven worktree edge:

- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.ts`
  and its unit test were added to publish:
  - `health_event` with `deliveryPolicy: append_only_observation`
  - `runtime_status` with `deliveryPolicy: latest_wins`
- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
  now accepts event messages and reconstructs controller-owned
  `AgentVmHealthEvent` and `OpenClawRuntimeStatusReport` before calling
  injected recorders.
- `packages/gateway-control-contracts/src/index.ts` exports
  `GatewayControlHealthEventPayload` and
  `GatewayControlRuntimeStatusPayload`.
- Production wiring has started through
  `packages/agent-vm/src/gateway/gateway-zone-support.ts`,
  `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`, and
  `packages/agent-vm/src/controller/controller-runtime.ts`.
- Plugin registration now creates a gateway-control event publisher and routes
  sandbox backend health/runtime publishing through injected gateway-control
  publisher dependencies instead of direct raw controller HTTP callers.
- Sandbox backend dependencies now optionally accept `publishHealthEvent`, and
  sandbox backend code no longer imports `fetchControllerWithPolicy` for health
  publishing.

Proof already observed for the in-progress edge:

- Focused unit command passed 4 files / 66 tests:
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts`
- Earlier package typechecks passed for:
  - `@agent-vm/openclaw-agent-vm-plugin`
  - `@agent-vm/agent-vm`
  - `@agent-vm/gateway-control-contracts`

Immediate next execution:

1. Re-run the focused unit command and package typechecks from the current
   worktree state.
2. Verify all production start/restart paths pass `healthEventStore` and
   `openClawRuntimeStatusStore` into gateway control domain wiring.
3. Remove or split only the old mutation HTTP route families when caller-side
   gateway-control parity remains proven:
   - preserve intended diagnostics such as `GET /zones/:zoneId/health-snapshot`;
   - do not restore old VM-facing mutation routes.
4. Remove old HTTP runtime-status/health-event caller residue only when it is no
   longer imported by live code.
5. Run focused route/domain/plugin proof, package typechecks, `pnpm test:unit`,
   `pnpm test:integration`, and `pnpm check` before recording this route-family
   disposition complete.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.
- Do not treat health-events/runtime-status route deletion as complete until
  gateway-control publisher parity and route proof are green.

phase_result: complete
evidence: active goal contract remade after Event 58; current in-progress edge
is health-events/runtime-status caller migration to gateway-control events plus
later S4b route disposition; focused units have passed but route deletion and
full proof remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by proving the gateway-control
health/runtime event publisher path, wiring all production start paths, then
delete the old HTTP mutation routes only after caller-side parity stays green.

## Current Resume Edge - Event 60

The active Codex host goal object still cannot be replaced while unfinished.
Under `orchestrator-goal` precedence, Event 60 in `events.jsonl` plus this
section supersede Event 59 and earlier resume sections.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 60: the old VM-facing health-event and OpenClaw runtime-status HTTP
  mutation routes are deleted from controller routing and focused route/runtime
  proof is green.
- This is a route-family checkpoint, not full implementation completion.

Completed in the Event 60 edge:

- `registerControllerHealthEventRoutes` now keeps
  `GET /zones/:zoneId/health-snapshot` and no longer registers
  `POST /zones/:zoneId/health-events`.
- `registerControllerHttpRoutes` no longer registers
  `POST /zones/:zoneId/openclaw-runtime-status`.
- Route unit tests now assert old mutation routes return `404`.
- Controller runtime tests no longer use deleted POST routes as fixtures; they
  inject controller-owned health/runtime store state directly.

Fresh proof from the current tree:

1. Agent-vm typecheck:
   `pnpm --filter @agent-vm/agent-vm typecheck`
   - exited 0.
2. Focused route/runtime unit:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
   - passed 3 files / 80 tests.

Immediate next execution:

1. Re-run the gateway-control publisher/domain/plugin focused unit command from
   the current tree:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts`
2. Remove or retire stale old HTTP runtime-status/health-event caller residue
   only where no live import still needs it:
   - `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.ts`
   - `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.unit.test.ts`
   - `packages/openclaw-agent-vm-plugin/src/index.ts`
   - `packages/openclaw-agent-vm-plugin/src/controller-request-policy.ts`
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.ts`
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.unit.test.ts`
3. Do not restore either deleted HTTP mutation route. If stale callers fail,
   migrate/remove callers; the route deletion is the hard-cutover direction.
4. Run package typechecks for `@agent-vm/openclaw-agent-vm-plugin`,
   `@agent-vm/agent-vm`, and `@agent-vm/gateway-control-contracts`.
5. Run targeted integration for gateway/controller route fallout, then
   `pnpm test:unit`, `pnpm test:integration`, and `pnpm check` before recording
   the health/runtime route-family disposition complete.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.

phase_result: complete
evidence: old health-events and OpenClaw runtime-status mutation routes deleted;
agent-vm typecheck passed; focused route/runtime unit proof passed 3 files / 80
tests
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by removing stale old HTTP
health/runtime caller residue, re-proving gateway-control publisher parity, and
then climbing the focused route/domain/plugin plus unit/integration/check gates.

## Current Resume Edge - Event 61

The active Codex host goal object still cannot be replaced while unfinished.
Under `orchestrator-goal` precedence, Event 61 in `events.jsonl` plus this
section supersede Event 60 and earlier resume sections.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 61: old OpenClaw plugin HTTP health/runtime caller residue is removed
  from the package/runtime path and local proof is green.
- This is not full cutover completion and not PR-ready.

Completed in the Event 61 edge:

- Deleted old HTTP runtime-status publisher:
  - `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.ts`
  - `packages/openclaw-agent-vm-plugin/src/openclaw-runtime-status-client.unit.test.ts`
- Deleted old `gateway-control-link` monitor:
  - `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.ts`
  - `packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.unit.test.ts`
- Removed stale exports from `packages/openclaw-agent-vm-plugin/src/index.ts`.
- Removed old `gatewayControlLinkMonitor` plugin config parsing and generated
  OpenClaw runtime plugin config.
- Removed old `controller-health`, `health-event-publish`, and
  `openclaw-runtime-status` operations from the OpenClaw plugin controller
  request policy wrapper. The wrapper remains because lease and zone-git
  callers still exist until their later owner slices complete.
- Rewrote request-policy tests to use the still-live `lease-list` read policy
  instead of old controller-health vocabulary.

Fresh proof from the current tree:

1. Focused gateway-control route/domain/plugin unit:
   `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts packages/openclaw-agent-vm-plugin/src/controller-request-policy.unit.test.ts packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.unit.test.ts packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
   - passed 9 files / 170 tests.
2. Package typechecks:
   `pnpm --filter @agent-vm/openclaw-agent-vm-plugin typecheck`
   `pnpm --filter @agent-vm/agent-vm typecheck`
   `pnpm --filter @agent-vm/gateway-control-contracts typecheck`
   `pnpm --filter @agent-vm/openclaw-gateway typecheck`
   - all exited 0.
3. Focused integration:
   `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/controller-request-policy.integration.test.ts packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts`
   - passed 2 files / 5 tests.
4. Full unit:
   `pnpm test:unit`
   - passed taxonomy plus 232 files / 2028 tests.
5. Full integration:
   `pnpm test:integration`
   - passed 27 files / 374 tests.
6. Full check:
   `pnpm check`
   - passed 8 / 0 with type-aware lint warnings only.

Residue scan status:

- The package/runtime path no longer has old
  `controller-health`, `health-event-publish`, `openclaw-runtime-status`,
  `gatewayControlLinkMonitor`, `gateway-control-link-monitor`,
  `openclaw-runtime-status-client`, or `createGatewayControlLinkMonitor`
  references.
- Expected remaining runtime-status references are new gateway-control payload
  and controller store types.
- Remaining stale e2e helper residue still posts to the deleted
  `/zones/:zoneId/openclaw-runtime-status` route in:
  - `packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
- Those e2e helpers are not shippable runtime callers, but they must be
  migrated or removed before OpenClaw e2e proof can be considered clean.

Immediate next execution:

1. Rework the listed OpenClaw e2e runtime-status helper paths so they no longer
   call deleted HTTP mutation routes.
2. Prefer proving the production gateway-control runtime-status path instead
   of adding a test-only replacement for the deleted route.
3. Preserve hard cutover: do not restore
   `POST /zones/:zoneId/openclaw-runtime-status`.
4. Re-run the affected OpenClaw e2e inventory/targeted gate where feasible, then
   keep moving toward `S5a` raw-control removal and later terminal e2e proof.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.

phase_result: complete
evidence: old OpenClaw plugin HTTP health/runtime caller residue removed;
focused unit, focused integration, four package typechecks, full unit, full
integration, and pnpm check are green; e2e helper runtime-status route residue
remains explicitly identified for the next execution edge
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by migrating the stale OpenClaw e2e
runtime-status helper paths off the deleted HTTP route and proving the
production gateway-control runtime-status path under e2e.

## Current Resume Edge - Event 62

The active Codex host goal object still cannot be replaced while unfinished.
Under `orchestrator-goal` precedence, Event 62 in `events.jsonl` plus this
section supersede Event 61 and earlier resume sections.

This event is a post-compaction re-anchor, not new implementation progress.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 61 remains the latest implementation checkpoint: old OpenClaw plugin
  HTTP health/runtime caller residue is removed from the package/runtime path
  and local proof is green.
- Event 62 remakes the goal contract at that same resume edge so the next
  agent does not follow older host-goal text back to `GATE-0a`, S3, S4a, or
  S4b.

Immediate next execution:

1. Re-read the affected OpenClaw e2e files:
   - `packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
2. Map each stale helper to the production behavior it should prove.
3. Migrate or remove old helper usage:
   - deleted `POST /zones/:zoneId/openclaw-runtime-status`;
   - old direct `/lease` controller helper calls;
   - `createLeaseClient(...)`, `requestControllerLease`, and
     `requestZoneGitLease` where they bypass the production OpenClaw/plugin
     gateway-control path.
4. Prefer proving the production gateway-control runtime-status and lease path
   rather than adding any test-only replacement route.
5. Run affected OpenClaw e2e inventory/targeted proof where feasible, then
   continue toward `S5a` raw-control removal only after the e2e helper residue
   is reconciled.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not add test-only replacement routes for deleted control surfaces.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.

phase_result: complete
evidence: post-compaction goal contract remade; latest implementation proof
remains Event 61; next edge is stale OpenClaw e2e helper migration off deleted
runtime-status and old direct lease helper paths
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by reconciling stale OpenClaw e2e helper
usage with the production gateway-control path, then continue toward S5a.

## Current Resume Edge - Event 63

The active Codex host goal object still cannot be replaced while unfinished.
Under `orchestrator-goal` precedence, Event 63 in `events.jsonl` plus this
section supersede Event 62 and earlier resume sections.

This event is another compaction/session re-anchor, not new implementation
progress.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Event 61 remains the latest implementation checkpoint: old OpenClaw plugin
  HTTP health/runtime caller residue is removed from the package/runtime path
  and local proof is green.
- Event 63 remakes the goal contract for this compacted session so the active
  host-goal text does not accidentally steer execution back to already-proven
  starting checkpoints such as upstream integration, `GATE-0a`, S3, S4a, or
  S4b.

Immediate next execution:

1. Re-run `git status --short --branch` before edits and preserve unrelated
   dirty files.
2. Re-read the affected OpenClaw e2e files before patching:
   - `packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
   - `packages/agent-vm/src/integration-tests/live-controller-restart-persistence.host.e2e.test.ts`
3. Map each stale helper to the production behavior it should prove.
4. Migrate or remove old helper usage:
   - deleted `POST /zones/:zoneId/openclaw-runtime-status`;
   - deleted `/lease*` mutation/read helper paths other than `GET /leases`;
   - `createLeaseClient(...)`, `requestControllerLease`, and
     `requestZoneGitLease` where they bypass the production OpenClaw/plugin
     gateway-control path.
5. Prefer proving the production gateway-control runtime-status and lease path
   rather than adding any test-only replacement route.
6. Run affected OpenClaw e2e inventory/targeted proof where feasible, then
   continue toward `S5a` raw-control removal only after the e2e helper residue
   is reconciled.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not add test-only replacement routes for deleted control surfaces.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.

phase_result: complete
evidence: post-compaction goal contract remade again for this active session;
latest implementation proof remains Event 61; next edge remains stale OpenClaw
e2e helper migration off deleted runtime-status and old direct lease helper
paths
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume by reconciling stale OpenClaw e2e helper
usage with the production gateway-control path, then continue toward S5a after
targeted proof is green.

## Current Resume Edge - Event 64

Event 64 supersedes Event 63 as the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- Stale OpenClaw e2e helper residue is locally reconciled without restoring
  deleted HTTP mutation routes or adding test-only replacement routes.
- This is not full cutover completion and not PR-ready.
- Live OpenClaw e2e did not run in this local pass because
  `AGENT_VM_OPENCLAW_E2E` was not enabled; the targeted command imported the
  files and reported skipped tests only.

Completed in this checkpoint:

- Removed stale runtime-status helper calls from:
  - `packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts`
  - `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
- Removed old direct `/lease` setup from the OpenClaw subagent e2e so the test
  relies on the actual OpenClaw subagent path to request leases.
- Converted the host restart persistence test's stale old route success checks
  into explicit `404` assertions for deleted
  `POST /zones/:zoneId/openclaw-runtime-status` and `POST /lease`.
- Removed the old VM-side `createGatewayControlLinkMonitor` /
  `fetchControllerWithPolicy` probe from the OpenClaw control-session smoke.
- Rewrote the zone-git OpenClaw e2e away from old `/lease` and
  `/lease/:id/peek` helpers. It now guards that the legacy model-visible
  `zone_git_push` tool is not exposed; the future Tool Portal /
  `controller_host_action` path remains owned by S7.

Fresh proof:

1. `pnpm --filter @agent-vm/agent-vm typecheck`
   - exited 0.
2. Targeted OpenClaw e2e command:
   `pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-gateway-stability.openclaw.e2e.test.ts packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
   - exited 0 with 5 files / 7 tests skipped because
     `AGENT_VM_OPENCLAW_E2E` was not enabled.
   - This is import/inventory evidence only, not live OpenClaw proof.
3. Targeted host e2e:
   `pnpm vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/integration-tests/live-controller-restart-persistence.host.e2e.test.ts`
   - exited 0 with 1 file / 1 test passed.
4. Targeted format:
   `pnpm exec oxfmt --check` over the six changed e2e files
   - exited 0.
5. `pnpm test:unit`
   - exited 0 with taxonomy plus 232 files / 2028 tests.
6. `pnpm test:integration`
   - exited 0 with 27 files / 374 tests.
7. `pnpm check`
   - exited 0 with 8 passed / 0 failed and type-aware lint warnings only.

Residue scan:

- Scoped OpenClaw/host e2e files no longer contain:
  - `createLeaseClient`
  - `requestControllerLease`
  - `requestZoneGitLease`
  - `buildOpenClawRuntimeStatusReport`
  - old runtime-status publish helper usage
  - `createGatewayControlLinkMonitor`
  - `fetchControllerWithPolicy`
  - `CONTROLLER_BASE_URL`
- Remaining old route strings in the scoped e2e files are:
  - expected `GET /leases` operator diagnostic usage, or
  - deliberate `404` assertions for deleted routes.

Immediate next execution:

1. Continue toward `S5a` raw-control removal.
2. Do not claim live OpenClaw proof from the skipped targeted e2e command.
3. Preserve the terminal requirement to run or record a blocked attempt for:
   - `mise exec -- pnpm run test:e2e:openclaw`
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - external `../shravan-claw-beta` proof with actual Discord/OpenClaw.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted VM-facing `/lease*` routes.
- Do not restore deleted health-event/runtime-status HTTP mutation routes.
- Do not add test-only replacement routes for deleted control surfaces.
- Do not move Worker task submit/state/close off ingress HTTP in this cutover.
- Do not work Worker `S6b` until Q2 worker probe-source ownership is resolved.

phase_result: complete
evidence: stale OpenClaw e2e helper residue migrated/removed; agent-vm
typecheck, targeted host e2e, targeted formatting, full unit, full integration,
and pnpm check are green; targeted OpenClaw e2e imported but skipped because the
live env gate was closed
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Resume with S5a raw-control removal while
preserving live OpenClaw/worker/vm/beta proof gates for later PR-ready status.

## Current Resume Edge - Event 113

Event 113 supersedes Event 112 as the current resume edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Latest valid checkpoint:

- `implementation-review-swarm` completed over the full Socket.IO control-plane
  implementation packet.
- Review verdict is `not_ready`.
- Reducer report:
  `tmp/implementation-review-swarms/2026-07-03-socketio-control-plane-review/reducer-report.md`
- Shared review packet:
  `tmp/implementation-review-swarms/2026-07-03-socketio-control-plane-review/review-packet.md`
- Six reviewer lanes completed and were closed:
  - `019f278f-9064-7541-be06-3ae54c5490d3`
  - `019f278f-b79e-77f3-b375-0aadda3703f8`
  - `019f278f-de50-7d41-a231-d3c3fd92f3f7`
  - `019f2790-0064-7811-bdb9-e3a673e71397`
  - `019f2790-2100-7783-8d33-e36f25ed859d`
  - `019f2790-41ec-7822-9ee4-a09348568dba`

Accepted blocker/important findings:

1. Worker VM still allowlists `controller.vm.host`.
2. Reconnect/resync is shape-only; hello/resync fields are not semantically
   evaluated.
3. Control ready endpoints mint credentials before a controller-owned guard.
4. SG SSH Git lifecycle wiring omits trusted repo allowlisting; current e2e
   proves the helper, not delivered lifecycle VM specs.
5. `agent-vm controller lease release` can report success against deleted
   `/lease*` routes.
6. Worker e2e does not prove live `git_push` / `git_pull_default`
   `worker_control_rpc` behavior.
7. OpenClaw e2e does not prove the positive Tool Portal
   `tool_portal_controller_host_action` replacement path.
8. `ControlSessionCloseReasonSchema` drifted from the accepted spec vocabulary.
9. Canonical docs/config still teach removed surfaces such as
   `gateway-control-link`, `CONTROLLER_BASE_URL`, `controller.vm.host:18800`,
   managed native `mcp_portal_*`, and plugin `controllerUrl`.
10. Terminal proof needs a fresh full unit/integration rerun after the last
    product changes and after the accepted fixes land.

Immediate next execution:

1. Route back to `shravan-dev-workflow:implementation-execute-plan`.
2. Start with narrow hard-cutover defects:
   - remove `controller.vm.host` from Worker `allowedHosts`;
   - fix or remove stale CLI `lease peek/release` false-success behavior;
   - align close-reason contract/runtime vocabulary.
3. Then address reconnect/resync semantics and ready-route pre-auth.
4. Then repair SG lifecycle repo scoping or route to spec if the repo-scope
   requirement is intentionally changed.
5. Then add missing positive e2e proofs for Worker git RPC and OpenClaw
   controller-host-action replacement.
6. Rerun fresh full unit/integration and terminal proof ladder before returning
   to `implementation-review-swarm`.

Non-goals at this edge:

- Do not mark the full goal complete.
- Do not proceed to PR-ready wrapup.
- Do not restore raw `controller.vm.host:18800` control fallback.
- Do not restore deleted unauthenticated VM-facing `/lease*` control routes.
- Do not move Worker task submit/state/close off ingress HTTP.

phase_result: needs_revision
evidence: implementation-review reducer accepted blocker and important findings;
see reducer report path above
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation findings must be fixed
and re-proven before PR-ready wrapup.

## Current Resume Edge - Event 114

Event 114 supersedes Event 113 for the immediate execution edge.

Current workflow: `shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Accepted review finding "Worker VM still allowlists `controller.vm.host`" is
  fixed in the narrow Worker delivered VM-spec policy surface.
- `packages/gateway-interface/src/audience.ts` now filters
  `controller.vm.host` out of `workerVmAllowedHosts()` the same way the gateway
  helper filters it.
- `packages/gateway-interface/src/audience.unit.test.ts` now asserts Worker VM
  allowed hosts do not include the internal controller host.
- `packages/worker-gateway/src/worker-lifecycle.unit.test.ts` now asserts the
  delivered Worker VM spec omits `controller.vm.host` from `allowedHosts` and
  still omits the old `controller.vm.host:18800` tcpHost.

Fresh focused proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/gateway-interface/src/audience.unit.test.ts packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
  exited 0 with 2 files / 11 tests passed.
- `pnpm --filter @agent-vm/gateway-interface typecheck` exited 0.
- `pnpm --filter @agent-vm/worker-gateway typecheck` exited 0.
- `pnpm exec oxfmt --check packages/gateway-interface/src/audience.ts packages/gateway-interface/src/audience.unit.test.ts packages/worker-gateway/src/worker-lifecycle.unit.test.ts`
  exited 0.
- `git diff --check` over the touched review/state/Worker-allowlist files exited
  0.

Remaining accepted blocker/important findings:

1. Reconnect/resync is shape-only.
2. Control ready endpoints mint credentials before a controller-owned guard.
3. SG SSH Git lifecycle wiring omits trusted repo allowlisting, or the spec must
   be revised if repo scoping is intentionally out of scope.
4. `agent-vm controller lease release` can report success against deleted
   `/lease*` routes.
5. Worker e2e does not prove live `git_push` / `git_pull_default`
   `worker_control_rpc` behavior.
6. OpenClaw e2e does not prove the positive Tool Portal
   `tool_portal_controller_host_action` replacement path.
7. `ControlSessionCloseReasonSchema` drifted from accepted spec vocabulary.
8. Canonical docs/config still teach removed surfaces.
9. Terminal proof needs fresh full unit/integration and terminal e2e after all
   accepted fixes land.

Immediate next execution:

- Continue with the next narrow validated blocker: stale controller lease
  `peek/release` CLI/client behavior or close-reason vocabulary alignment.

phase_result: needs_revision
evidence: first accepted implementation-review blocker fixed with focused proof;
remaining accepted findings still block PR-ready wrapup
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue executing accepted review fixes before
rerunning implementation-review-swarm.

## Current Resume Edge - Event 186

Event 186 addresses accepted Event 185 blocker and important findings. Official
workflow advances back to `shravan-dev-workflow:implementation-review-swarm`.

Completed in this checkpoint:

- Caller contexts bind to accepted gateway boot/session through `bootId`, and
  stale contexts are evicted/released across session and lease lifecycle.
- Managed OpenClaw strips stale authored `mcp-portal` plugin config and rejects
  runtime `mcp-portal` plugin config.
- Tool Portal production runtime no longer imports `@agent-vm/mcp-portal/core`;
  MCP core construction is behind
  `@agent-vm/mcp-portal/mcp-provider-backend`.
- Unauthenticated `GET /leases` and `agent-vm controller lease list` are
  removed.
- Tool Portal controller-host-action stale caller-context recovery retries once
  inside the same user call, and `zone_git_push` arguments are strict
  Zod-validated before RPC dispatch.
- Gateway and Worker accepted upgrade failures now set `terminalAtMs` so failed
  credential records can be evicted.
- Managed SSH Git read allowlisting now derives generic trusted repo hosts,
  allows `git-upload-pack`, denies `git-receive-pack`, and omits SSH egress
  when no trusted repo allowlist exists.
- Managed docs no longer imply OpenClaw `hmacKey` approval-token behavior.

Fresh proof:

- Focused unit proof for Event 185 code paths: 9 files / 63 tests passed.
- Focused route/client/CLI unit proof: 3 files / 4 selected tests passed.
- Focused credential terminal-stamp integration proof: 2 files / 2 selected
  tests passed.
- Focused OpenClaw lifecycle host-e2e proof: 1 file / 3 selected tests passed.
- Focused Tool Portal/MCP backend integration proof: 2 files / 2 tests passed.
- `pnpm lint` exited 0 with 0 warnings / 0 errors.
- `pnpm lint:types` exited 0 with 0 warnings / 0 errors.
- `pnpm typecheck` passed all workspace projects.
- `git diff --check && git diff --cached --check` passed.
- `pnpm check` exited 0 with 9 passed / 0 failed.

Review packet refreshed:

- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-186.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt

Known residual risk:

- A full `agent-vm-entrypoint.unit.test.ts` run still has an unrelated existing
  init-config fixture failure about `zones[].agents`; the Event 185 lease CLI
  test is green in focused form.
- Worker git RPC e2e, terminal OpenClaw/Worker/VM/default e2e, and
  `../shravan-claw-beta` actual Discord/OpenClaw proof remain required after the
  next implementation-review pass.

phase_result: complete
evidence: Event 185 accepted fixes staged; focused proof and `pnpm check` green;
review packet and Fable prompt refreshed
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Event 185 accepted findings are fixed with
focused proof, so the next gate is implementation review / Fable.

## Current Resume Edge - Event 185

Event 185 routes from `shravan-dev-workflow:implementation-review-swarm` back to
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Five read-only implementation-review lanes completed and were closed.
- Reducer report written:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-185.md`
- Parent verification accepted blocker/important findings against current staged
  code.

Accepted blocker/important findings:

1. Caller-context ids are not bound to accepted control session or boot.
2. Managed OpenClaw still preserves deprecated `mcp-portal` plugin runtime
   config.
3. Tool Portal directly imports `@agent-vm/mcp-portal/core`, violating the MCP
   provider adapter boundary.
4. `GET /leases` remains unauthenticated.
5. Tool Portal host-action stale caller-context recovery fails the first user
   call instead of retrying once.
6. Authenticated gateway/worker upgrade failure records can leak because failed
   accepted credentials are not stamped terminal.
7. Managed SSH read allowlisting is GitHub-shaped despite generic trusted repo
   URLs.
8. Caller-context registry has only a hard cap and no lifecycle eviction.

Accepted proof gaps and follow-ups:

- Worker git RPC e2e still uses a local synthetic controller socket for the git
  RPC result path.
- Terminal e2e and beta Discord/OpenClaw proof remain mandatory after accepted
  fixes.
- Runtime should reject unknown `zone_git_push` Tool Portal arguments.
- `tool_vm_runner` accepted config vs runtime handling needs either scoped
  validation or real runtime support.
- Managed docs still imply `hmacKey` approval-token behavior for managed
  OpenClaw.

Immediate next execution:

- Fix the accepted blocker/important findings, rerun focused proof, refresh the
  review packet, then rerun implementation-review-swarm before terminal e2e and
  beta proof.

phase_result: needs_revision
evidence: Five reviewer lanes completed and closed; reducer report Event 185
written with accepted blocker/important findings verified against current staged
code.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted implementation findings block review
readiness and must be fixed before another review swarm.

## Checkpoint: PR Scope Cleanup And Beta Proof Attempt (2026-07-03T19:03Z)

This section records the final local PR-scope cleanup and the current external
beta proof boundary.

PR-scope cleanup:

- The origin/master base diff no longer contains unrelated
  `docs/superpowers` or stale credentialed-runner residue.
- `docs/superpowers/plans/README.md` was narrowed back to the upstream text.
- `git diff --name-status origin/master | rg '^([AMDR]\\s+)?docs/superpowers|credentialed-runner-boundary|CredentialedRunner|credentialed-runner' || true`
  returned no matches.
- `git diff --check -- docs/superpowers/plans/README.md` exited 0.
- `pnpm exec oxfmt --check docs/superpowers/plans/README.md` exited 2
  because markdown targets are ignored by repo Oxfmt config; this is not a code
  or formatter regression for the cleanup.

Beta proof attempt:

- Controller health at `http://127.0.0.1:18900/health` returned
  `{"ok":true,"port":18900,"state":"ready"}`.
- Zone health at `http://127.0.0.1:18900/zones/beta/health` returned ready
  OpenClaw ingress evidence for zone `beta`.
- Latest OpenClaw log:
  `/Users/shravansunder/.agent-vm/runtime/zones/beta/logs/openclaw-2026-07-03.log`.
- Latest session trajectory inspected:
  `/Users/shravansunder/.agent-vm/state/beta/agents/beta/sessions/23ddc963-df79-4efc-80b3-3227765a4bf1.trajectory.jsonl`.
- Fresh beta evidence proves actual OpenClaw 2026.6.8, actual Discord channel
  wiring, heartbeat-triggered Discord session execution, OpenRouter fallback
  model success, tool execution, and `HEARTBEAT_OK`.
- Fresh beta evidence does not prove a human inbound Discord event round trip:
  the inspected session metadata is `provider: "heartbeat"`,
  `trigger: "heartbeat"`, and `sessionKey: "agent:beta:main:heartbeat"`.
- A 30-second log watch after asking the user for a fresh Discord message
  produced no new non-heartbeat beta log lines.

Current beta claim:

- Narrowed to live beta startup/connectivity plus actual Discord/OpenClaw
  heartbeat execution.
- Human inbound Discord event round-trip proof remains open until a fresh
  Discord message is sent and captured.

phase_result: needs_revision
evidence: PR-scope cleanup is fixed; beta live prerequisite attempt is recorded
honestly as narrowed, not a completed human inbound event proof
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Capture a fresh human Discord inbound event if
available; otherwise run implementation-review-swarm with the beta proof gap
explicitly narrowed and unresolved for PR-ready wrapup.

## Current Resume Edge - Event 122

Event 122 continues Event 121. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Accepted review finding for canonical docs/config residue is addressed in the
  managed control-plane surfaces.
- Canonical docs now describe controller-initiated Gondolin ingress control
  sessions for Gateway and Worker control instead of VM-originated raw
  `controller.vm.host:18800` control callbacks.
- Canonical docs now describe Tool Portal as the managed OpenClaw model-visible
  portal surface, with MCP Portal as an MCP provider/backend or standalone MCP
  proxy surface.
- The public OpenClaw plugin manifest no longer advertises `controllerUrl`.
- `resolveGondolinPluginConfig()` now rejects stale `controllerUrl` config
  instead of silently ignoring it.
- New scaffolds no longer write `controllerUrl` into the Gondolin plugin config.
- OpenClaw lifecycle effective-config generation no longer strips
  `controllerUrl` as a compatibility shim; stale config must fail at the
  plugin/schema boundary.

Fresh focused proof:

- Residue scan over canonical docs and public config surfaces found no stale
  `gateway-control-link`, `CONTROLLER_BASE_URL`,
  `controller.vm.host:18800`, `openclaw-mcp-portal-plugin`, `controllerUrl`, or
  deleted `/lease*` route teaching. Remaining `GET /leases` references are the
  intentional operator diagnostic route.
- `pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.unit.test.ts packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.unit.test.ts packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts`
  exited 0 with 3 files / 45 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/init-command.integration.test.ts`
  exited 0 with 1 file / 39 tests passed.
- `pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
  exited 0 with 1 file / 52 tests passed.
- Typechecks exited 0 for `@agent-vm/openclaw-agent-vm-plugin`,
  `@agent-vm/agent-vm`, and `@agent-vm/openclaw-gateway`.
- `pnpm exec oxfmt --check` over touched TypeScript/config files exited 0.
- `git diff --check` over touched workflow/docs/config files exited 0.

Remaining accepted blocker/important findings:

1. Terminal proof needs fresh full unit/integration and terminal e2e after all
   accepted fixes.
2. Another implementation-review-swarm must run after accepted fixes and fresh
   proof.
3. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof remain out ahead.

Immediate next execution:

- Continue with the fresh terminal proof ladder, starting with full unit and
  integration proof, then terminal e2e gates before another
  implementation-review-swarm.

phase_result: needs_revision
evidence: canonical docs/config residue fixed with focused unit, integration,
host-e2e, typecheck, format, diff-check, and residue-scan proof; terminal proof
and implementation review still block PR-ready wrapup
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue into the fresh terminal proof ladder
before rerunning implementation-review-swarm.

## Current Resume Edge - Event 129

Event 129 continues Event 128. Official workflow advances to
`shravan-dev-workflow:implementation-review-swarm`.

Completed in this checkpoint:

- Repo-owned terminal proof ladder is green after accepted review fixes:
  - Full unit.
  - Full integration.
  - Broad OpenClaw e2e.
  - Worker e2e.
  - VM e2e.
  - Default e2e.
  - Final `pnpm check`.

Fresh quality proof:

- `pnpm check` exited 0.
- Check gate summary: 8 passed / 0 failed in 19.05s.
- Passed checks:
  - package version sync: 17 `@agent-vm/*` packages synced at 0.0.108.
  - Zod version guard.
  - test taxonomy audit.
  - portal architecture audit.
  - portal package export audit.
  - format check.
  - type-aware lint.
  - typecheck.
- Type-aware lint reported 411 warnings and 0 errors.

Remaining gates:

1. Another implementation-review-swarm over the current implementation diff and
   proof chain.
2. Address or explicitly reject review findings with evidence.
3. PR-ready non-merge wrapup.
4. `../shravan-claw-beta` actual Discord/OpenClaw proof.

Immediate next execution:

- Run `shravan-dev-workflow:implementation-review-swarm`.

phase_result: complete
evidence: repo-owned terminal proof ladder is green through `pnpm check`;
implementation review, PR wrapup, and beta actual Discord/OpenClaw proof remain
open
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Implementation proof is fresh enough to hand to
the required implementation review gate.

## Current Resume Edge - Event 128

Event 128 continues Event 127. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Default e2e terminal gate is green.
- The wrapper ran the repo-owned build-once / test-many proof lanes:
  - Host Docker observability e2e.
  - Host e2e.
  - Gondolin VM e2e.
  - HTTP mediation e2e.

Fresh broad proof:

- `mise exec -- pnpm test:e2e` exited 0 with 4 lanes passed / 0 failed.
- Lane results:
  - `e2e-host-docker`: 1 file / 2 tests passed, 0 skipped, 0 todo.
    `tmp/vitest-results/e2e-host-docker-94581-on1Dnc/results.json`
  - `e2e-host`: 22 files / 174 tests passed, 0 skipped, 0 todo.
    `tmp/vitest-results/e2e-host-94615-1KkwEO/results.json`
  - `e2e-vm`: 5 files / 9 tests passed, 0 skipped, 0 todo.
    `tmp/vitest-results/e2e-vm-94592-3V192K/results.json`
  - `e2e-vm-mediation`: 2 files / 3 tests passed, 0 skipped, 0 todo.
    `tmp/vitest-results/e2e-vm-mediation-94593-xoz2N0/results.json`

Remaining terminal gates:

1. `pnpm check`.
2. Another implementation-review-swarm.
3. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Run `pnpm check`.

phase_result: needs_revision
evidence: default e2e is green with 4 lanes passed / 0 failed; remaining
quality/review/PR/beta gates remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with
`pnpm check`.

## Current Resume Edge - Event 127

Event 127 continues Event 126. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- VM e2e terminal gate is green.
- The VM gate covered:
  - OCI-backed Gondolin build pipeline.
  - Basic VM boot and exec.
  - VFS mounts.
  - writable RealFS `/workspace` persistence across disposable VM lifetimes.
  - Gondolin ingress exposing a guest HTTP server.
  - host-to-guest SSH.
  - Tool VM HTTP-mediated placeholder scoping.
  - cross-VM SSH through allowed `tcp.hosts` for Tool VM SSH.
  - SG / SSH Git host-boundary policy: allow `git-upload-pack`, deny
    `git-receive-pack`.

Fresh broad proof:

- `mise exec -- pnpm run test:e2e:vm` exited 0 with 5 files / 9 tests passed,
  0 skipped, 0 todo.
- Result JSON:
  `tmp/vitest-results/e2e-vm-75665-wFSYOR/results.json`.

Remaining terminal gates:

1. Default e2e.
2. `pnpm check`.
3. Another implementation-review-swarm.
4. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Run `mise exec -- pnpm test:e2e`.

phase_result: needs_revision
evidence: VM e2e is green with 5 files / 9 tests, 0 skipped, 0 todo; remaining
terminal gates remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with default
e2e.

## Current Resume Edge - Event 126

Event 126 continues Event 125. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- The first Worker e2e terminal-gate attempt failed the evidence wrapper with
  2 passed tests and 2 skipped tests.
- Root cause was environment setup, not a product failure: the two live Worker
  tests require `AGENT_VM_TEST_OPENAI_API_KEY`, and the plain package script
  only sets `AGENT_VM_WORKER_E2E=1`.
- Prior Worker debug notes already established the repo-local convention:
  source `.env.local` and map the local test key variable into
  `AGENT_VM_TEST_OPENAI_API_KEY` for this gate.
- Rerunning with that mapping executed all Worker e2e files with no skips.

Fresh broad proof:

- Unmapped attempt:
  `mise exec -- pnpm run test:e2e:worker` exited 1 because the evidence runner
  found 2 skipped tests.
- Corrected attempt:
  `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker`
  exited 0 with 3 files / 4 tests passed, 0 skipped, 0 todo.
- Result JSON:
  `tmp/vitest-results/e2e-worker-34657-5db0cY/results.json`.

Remaining terminal gates:

1. VM e2e.
2. Default e2e.
3. `pnpm check`.
4. Another implementation-review-swarm.
5. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Run `mise exec -- pnpm run test:e2e:vm`.

phase_result: needs_revision
evidence: Worker e2e is green with 3 files / 4 tests, 0 skipped, 0 todo after
the required local test-key mapping; remaining terminal gates remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with VM e2e.

## Current Resume Edge - Event 125

Event 125 continues Event 124. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Broad OpenClaw e2e terminal gate is green after the accepted review fixes and
  focused reruns.
- The broad gate covered:
  - OpenClaw gateway stability, 60/60 iterations passed.
  - Gateway control-session pre-101 rejection, websocket-only connect, and
    fail-closed `resync_required` after gateway flap.
  - MCP/Tool Portal OpenClaw behavior.
  - Live OpenClaw control-link health and recovery.
  - OpenClaw subagent lease path.
  - Tool Portal `controller_host_action.zone_git_push` replacement for the old
    direct `zone_git_push` model tool.
  - Default managed OpenClaw runtime import/inventory.

Fresh broad proof:

- `mise exec -- pnpm run test:e2e:openclaw` exited 0 with 7 files / 12 tests
  passed, 0 skipped, 0 todo.
- Result JSON:
  `tmp/vitest-results/e2e-openclaw-19602-rYR2gV/results.json`.

Remaining terminal gates:

1. Worker e2e.
2. VM e2e.
3. Default e2e.
4. `pnpm check`.
5. Another implementation-review-swarm.
6. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Run `mise exec -- pnpm run test:e2e:worker`.

phase_result: needs_revision
evidence: broad OpenClaw e2e is green with 7 files / 12 tests, 0 skipped,
0 todo; remaining terminal gates remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with Worker
e2e.

## Current Resume Edge - Event 124

Event 124 continues Event 123. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- The broad OpenClaw e2e failure in
  `packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
  was confirmed as a stale test expectation, not a product regression.
- Killing the OpenClaw gateway process loses the plugin's in-memory previous
  session fence, so fail-closed `resync_required` after reconnect is the
  expected hard-cutover behavior.
- The focused control-session e2e now asserts `connected: false`,
  websocket transport, a new hello attempt, and
  `lastHelloResponse.outcome === "resync_required"` after plugin process
  restart.
- The focused OpenClaw subagent lease e2e rerun completed successfully after
  the prior broad-gate timeout.

Fresh focused proof:

- `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-control-session.openclaw.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.
- `AGENT_VM_OPENCLAW_E2E=1 AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.

Remaining terminal gates:

1. Broad OpenClaw e2e.
2. Worker e2e.
3. VM e2e.
4. Default e2e.
5. `pnpm check`.
6. Another implementation-review-swarm.
7. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Rerun `mise exec -- pnpm run test:e2e:openclaw`.

phase_result: needs_revision
evidence: focused OpenClaw control-session and subagent lease e2e reruns are
green after the reconnect/resync expectation fix; broad OpenClaw and remaining
terminal gates remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with broad
OpenClaw e2e.

## Current Resume Edge - Event 123

Event 123 continues Event 122. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Fresh full unit and integration proof passed after accepted
  implementation-review fixes and canonical docs/config cleanup.

Fresh proof:

- `pnpm test:unit` exited 0.
  - `pnpm test:taxonomy`: Test taxonomy audit passed.
  - Unit Vitest: 232 files / 2007 tests passed.
- `pnpm test:integration` exited 0.
  - Integration Vitest: 27 files / 388 tests passed.

Remaining terminal gates:

1. `mise exec -- pnpm run test:e2e:openclaw`
2. `mise exec -- pnpm run test:e2e:worker`
3. `mise exec -- pnpm run test:e2e:vm`
4. `mise exec -- pnpm test:e2e`
5. `pnpm check`
6. Another implementation-review-swarm
7. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof.

Immediate next execution:

- Run fresh broad OpenClaw e2e, because the docs/config cleanup touched the
  public OpenClaw plugin config shape and lifecycle effective-config generation.

phase_result: needs_revision
evidence: full unit and integration gates passed after accepted review fixes;
terminal e2e/check/review/PR/beta proof remain open
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue the terminal proof ladder with broad
OpenClaw e2e.

## Current Resume Edge - Event 121

Event 121 continues Event 120. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Accepted review proof gap for the positive OpenClaw
  `tool_portal_controller_host_action` replacement path is fixed.
- `packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
  now proves the replacement path by:
  - rejecting the old direct `zone_git_push` model-visible tool,
  - listing `controller_host_action.zone_git_push` through Tool Portal,
  - calling the capability via `tool_portal_call`,
  - reaching the OpenClaw plugin `controller_host_action` backend over the
    gateway control session.

Fresh focused proof:

- `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
  exited 0 with 1 file / 1 test passed.

Remaining accepted blocker/important findings:

1. Canonical docs/config still teach removed surfaces.
2. Terminal proof needs fresh full unit/integration and terminal e2e after all
   accepted fixes land.
3. Another implementation-review-swarm must run after accepted fixes and fresh
   proof.
4. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof remain out ahead.

Immediate next execution:

- Continue with canonical docs/config residue cleanup, then fresh terminal proof
  ladder and another implementation-review-swarm.

phase_result: needs_revision
evidence: OpenClaw positive Tool Portal controller_host_action e2e proof gap
fixed with focused live OpenClaw e2e evidence; remaining accepted findings still
block PR-ready wrapup
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue executing accepted review fixes before
rerunning implementation-review-swarm.

## Current Resume Edge - Event 120

Event 120 continues Event 119. Official workflow remains
`shravan-dev-workflow:implementation-execute-plan`.

Completed in this checkpoint:

- Accepted review proof gap `WORKER-GIT-RPC-E2E` is fixed.
- `packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  now signs `/__agent-vm/worker-ready` requests with the controller ready-proof
  headers before minting an upgrade credential.
- The same e2e file now includes a positive git RPC proof that:
  - creates a real temporary git repository and branch,
  - connects a real Socket.IO websocket-only controller peer to a real
    WorkerControlService,
  - runs the actual `git-push` and `git-pull-default` Worker tool definitions,
  - asserts the controller peer receives `git_push` and `git_pull_default` over
    `control:message`,
  - validates the payloads are intent-only and contain no git pack data.

Fresh focused proof:

- First targeted worker e2e attempt failed because the new test left its
  Socket.IO client open before `server.close()`, causing teardown to hang.
  Cleanup order was fixed by closing the controller socket before closing the
  HTTP server.
- `AGENT_VM_WORKER_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  exited 0 with 1 file / 2 tests passed.
- `pnpm --filter @agent-vm/agent-vm-worker typecheck` exited 0.
- `pnpm exec oxfmt --check packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  exited 0.
- `git diff --check -- packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts`
  exited 0.

Remaining accepted blocker/important findings:

1. OpenClaw e2e does not prove the positive Tool Portal
   `tool_portal_controller_host_action` replacement path.
2. Canonical docs/config still teach removed surfaces.
3. Terminal proof needs fresh full unit/integration and terminal e2e after all
   accepted fixes land.
4. Another implementation-review-swarm must run after accepted fixes and fresh
   proof.
5. PR-ready non-merge wrapup and `../shravan-claw-beta` actual Discord/OpenClaw
   proof remain out ahead.

Immediate next execution:

- Continue with the missing OpenClaw positive
  `tool_portal_controller_host_action` e2e proof, then canonical docs/config
  residue cleanup.

phase_result: needs_revision
evidence: Worker git RPC e2e proof gap fixed with focused e2e/typecheck/format
proof; remaining accepted findings still block PR-ready wrapup
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Continue executing accepted review fixes before
rerunning implementation-review-swarm.

## Event 195 Workflow State Refresh

Latest official transition:
- Event 195 routes from `shravan-dev-workflow:implementation-execute-plan` to
  `shravan-dev-workflow:implementation-review-swarm`.

Event 194 accepted findings fixed:
- Worker control `operation_cancel` is hard-rejected; Worker task
  submit/state/close remain ingress HTTP-only in this PR.
- Gateway and Worker peer services coalesce latest-wins advisory messages and
  use volatile emits for latest-wins/droppable traffic.
- MCP-backed Tool Portal sessions thread session provenance into the MCP
  provider backend.
- Review packet and staged inventory were refreshed.

Current next gate:
- Run/adjudicate implementation review over the Event 195 packet.

Still not PR-ready:
- Terminal OpenClaw, Worker, VM, default e2e, `pnpm check` refresh, and live
  `../shravan-claw-beta` actual Discord/OpenClaw proof remain required after a
  clean implementation review.

## Event 198 Workflow State Refresh

Latest local continuation:
- Post-Event-197 runtime fixes are ready to stage after local source inspection.

Fixed after Event 197:
- Tool Portal no longer passes internal entrypoint cache keys with NUL/control
  separators as MCP Portal session keys. Unsafe keys now derive a stable
  `tool-portal-entrypoint-<sha256-base64url>` key and retire the same derived
  session.
- OpenClaw runtime-status publication now waits for controller receipt before
  dependent lease commands can proceed. `GatewayControlService` supports
  `{ waitForReceipt: true }` for `latest_wins` messages by bypassing the
  lossy coalescing queue, waiting for `control:message` ack, and recording the
  peer sequence only after accepted receipt.

Fresh proof already captured before this event:
- `managed-tool-portal-runtime.unit.test.ts`: 1 file / 4 tests passed.
- `openclaw-mcp-portal.openclaw.e2e.test.ts`: 1 file / 4 tests passed.
- `openclaw-zone-git.openclaw.e2e.test.ts`: 1 file / 1 test passed.
- `gateway-control-event-publisher.unit.test.ts`: 1 file / 5 tests passed.
- `gateway-control-service.integration.test.ts`: 1 file / 24 tests passed.
- `openclaw-subagent-lease.openclaw.e2e.test.ts`: passed with one flap and with
  default flaps.
- `mise exec -- pnpm run test:e2e:openclaw`: 7 files / 12 tests passed,
  0 skipped, 0 todo, JSON at
  `tmp/vitest-results/e2e-openclaw-73391-Wkl8jG/results.json`.

Current next gate:
- Stage the latest six-file runtime fix plus this workflow-state update, then
  continue terminal proof with Worker e2e, VM e2e, default e2e, `pnpm check`,
  implementation review refresh, and beta Discord/OpenClaw proof.

Still not PR-ready:
- No checkpoint commit has been made yet.
- Worker e2e, VM e2e, default e2e, `pnpm check`, implementation review refresh,
  beta Discord/OpenClaw proof, and PR-ready non-merge wrapup remain required.

## Event 199 Worker E2E Refresh

Bug found during terminal Worker proof:
- `mise exec -- pnpm run test:e2e:worker` initially failed in
  `worker-control-session.worker.e2e.test.ts`.
- Symptom:
  `sequence_gap: control sequence gap: expected=1 received=14 kind=command_result operation=git_push`.
- Root cause:
  the e2e synthetic controller replied to Worker advisory events with
  `command_result` frames. Those synthetic replies copied the advisory
  `latest_wins` delivery policy, so the Worker correctly did not advance its
  hard controller sequence while the harness-local sequence counter advanced.
  The first real `git_push` result was therefore sent as sequence `14` when the
  Worker expected sequence `1`.
- Debug artifact:
  `tmp/debug-workflows/2026-07-04-agent-vm-mcp-portal-better-interface-worker-e2e-sequence-gap/debug-investigation.md`.

Fix:
- The e2e synthetic controller now acknowledges non-command Worker advisory
  messages and does not emit command results for them.

Fresh proof:
- Focused Worker control-session e2e:
  `AGENT_VM_WORKER_E2E=1 pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm-worker/src/worker-control-session.worker.e2e.test.ts --reporter=verbose`
  passed 1 file / 2 tests.
- First full Worker gate after the patch passed executed tests but failed
  evidence validation because `AGENT_VM_TEST_OPENAI_API_KEY` was absent and two
  gated Worker files skipped.
- Full Worker gate rerun with repo-local `OPEN_AI_TEST_KEY` mapped to
  `AGENT_VM_TEST_OPENAI_API_KEY` in a redacted subshell:
  `mise exec -- pnpm run test:e2e:worker`
  passed 3 files / 5 tests / 0 skipped / 0 todo in 264.09s.
- JSON result:
  `tmp/vitest-results/e2e-worker-15797-r73Hf0/results.json`.

Still not PR-ready:
- VM e2e, default e2e, `pnpm check`, implementation review refresh, beta
  Discord/OpenClaw proof, and PR-ready non-merge wrapup remain required.

## Event 200 Terminal Proof Refresh

Completed in this checkpoint:
- Fixed host e2e fixture regressions exposed by the first default
  `pnpm test:e2e` rerun after Event 199.
- Production init generation now emits a default trusted OpenClaw agent when no
  `--agent` is provided.
- OpenClaw lifecycle host fixture declares its trusted agent.
- No-git-allowlist SSH egress proof expects absent `sshEgress`, matching
  production fail-closed behavior.
- Zone-git success fixtures use a non-protected proof branch instead of
  protected `main`.
- Observability build CLI smoke config declares its trusted agent.
- Review packet, copy-paste prompt, staged inventory, and Event 200 execution
  report were refreshed.

Fresh proof:
- `pnpm exec oxfmt packages/agent-vm/src/backup/backup-create-operation.host.e2e.test.ts`
  passed.
- `mise exec -- pnpm run test:e2e:vm` passed 5 files / 9 tests / 0 skipped /
  0 todo. JSON:
  `tmp/vitest-results/e2e-vm-42352-fO1Xkl/results.json`.
- `pnpm build` passed.
- Focused host-e2e repair command over six previously failing files passed
  6 files / 94 tests.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/init-command.integration.test.ts`
  passed 1 file / 39 tests.
- `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm test:e2e`
  passed all default e2e proof lanes, 4 passed / 0 failed in 80.56s:
  - e2e-host-docker: 1 file / 2 tests / 0 skipped / 0 todo,
    `tmp/vitest-results/e2e-host-docker-87413-h5OKus/results.json`
  - e2e-host: 22 files / 180 tests / 0 skipped / 0 todo,
    `tmp/vitest-results/e2e-host-87411-3gpboG/results.json`
  - e2e-vm: 5 files / 9 tests / 0 skipped / 0 todo,
    `tmp/vitest-results/e2e-vm-87412-p1EXEn/results.json`
  - e2e-vm-mediation: passed in 11.59s
- `pnpm check` passed 10 passed / 0 failed in 27.04s.
- `git diff --cached --check` passed.
- `git diff --check` passed.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw proof remains required.
- PR-ready non-merge wrapup remains required.

## Event 214 Beta Build/Restart Checkpoint And Secret-Auth Blocker

Completed in this checkpoint:
- Recovered the beta build that was mid-flight across context compaction.
- Confirmed `../shravan-claw-beta` build completed successfully:
  - `mise exec -- pnpm build`
  - Docker gateway/OpenClaw image build completed.
  - Docker default Tool VM image build completed.
  - Gondolin gateway/OpenClaw artifact build completed.
  - Gondolin default Tool VM artifact build completed.
  - Cache auto-prune was skipped because beta runtime records still existed.
  - Host observability preparation was skipped because no OpenClaw zone opted in.
- Verified pre-restart beta health:
  - `curl -fsS http://127.0.0.1:18900/health`
    returned `{"ok":true,"port":18900,"state":"ready"}`.
  - `curl -fsS http://127.0.0.1:18900/zones/beta/health`
    returned `ok:true`, `/readyz`, HTTP 200, zone `beta`.
  - `curl -fsS http://127.0.0.1:18891/readyz`
    returned `{"ready":true}`.
- Ran the deployment restart path:
  - `mise exec -- pnpm restart`
  - The first stop returned `{"ok":true}`.
  - The restart script's nested stop then returned `fetch failed`, force-stop
    cleaned no processes, and start reported an `EADDRINUSE` listener on
    `127.0.0.1:18900`.
- Investigated the restart anomaly without broad process killing:
  - `lsof -nP -iTCP:18900 -sTCP:LISTEN` showed the listener was the beta
    `agent-vm controller start --config config/system.jsonc --zone beta`
    process.
  - The controller process had a live `qemu-system-aarch64` child for the beta
    OpenClaw gateway VM.
  - Fresh health checks after the anomaly still returned controller ok, zone
    ok, and direct ingress ready.
  - `pnpm exec agent-vm controller status --config config/system.jsonc`
    reported zone `beta` running, readiness `running`, gateway infrastructure
    `running`, active leases `0`, ingress port `18891`, booted at
    `2026-07-05T04:37:47.527Z`, VM id
    `c23e498b-2b08-4859-a703-c54307201efb`.
- Confirmed OpenClaw logs after the fresh boot show:
  - Discord channels resolved for the configured beta guild/channel.
  - Discord client initialized and awaited gateway readiness.
  - Discord gateway WebSocket opened.
  - The agent-vm OpenClaw plugin loaded from the freshly synced local package
    tarball path.

Blocked proof attempt:
- Attempted to send the required fresh external Discord REST message from the
  test sender bot after the `04:37:47Z` beta boot.
- The message was not sent. The secret read failed before the Discord API call:
  1Password authorization timed out.
- No Discord token value was printed or captured.
- There was no exported fallback test-token environment variable in the shell.

Current status:
- Beta build and post-restart runtime health are freshly captured.
- Live beta is running and ready for the final allowed-user Discord/OpenClaw
  inbound proof.
- Remaining blocker for PR readiness: authorize/unlock 1Password access to the
  redacted test sender bot secret, or manually send an allowed-user Discord
  message into the beta channel, then capture fresh log/trajectory/Discord
  readback evidence.

## Event 215 Rechecked Secret-Auth Blocker

Completed in this checkpoint:
- Re-verified the source branch state after the Event 214 checkpoint:
  - `HEAD: 59c6f03`
  - `git rev-list --left-right --count HEAD...origin/mcp-portal-better-interface`
    returned `0 0`.
- Re-verified beta runtime health before retrying Discord proof:
  - controller `/health`: `ok:true`
  - controller `/zones/beta/health`: `ok:true`, `/readyz`, HTTP 200
  - direct ingress `/readyz`: `ready:true`
- Retried the fresh external Discord REST send path with redacted secret
  handling.
- The message was not sent. The attempt failed at secret-read before the Discord
  API call because 1Password authorization failed or timed out.
- Tried a bounded `op signin --account ...` session refresh path.
- The session refresh also timed out.
- No Discord token value, raw secret value, or secret-bearing command output was
  printed or recorded.

Current status:
- This is still an external 1Password authorization blocker, not a beta,
  Discord API, OpenClaw, or control-plane failure.
- Live beta remains the proof target, but the final allowed-user inbound proof
  needs either:
  - an authorized 1Password session for the redacted test sender bot secret, or
  - a manual allowed-user Discord message in the configured beta channel.

## Event 216 Third Secret-Auth Blocker Confirmation

Completed in this checkpoint:
- Re-loaded the goal orchestration rules and rechecked live state.
- Source branch remained clean and pushed at `b8ec29d`.
- Beta runtime health remained green:
  - controller `/health`: `ok:true`
  - controller `/zones/beta/health`: `ok:true`, `/readyz`, HTTP 200
  - direct ingress `/readyz`: `ready:true`
- Checked current OpenClaw logs and recent beta trajectories for a fresh manual
  Discord proof after the `2026-07-05T04:37:47.527Z` beta boot.
- Found only the older `02:56Z` Discord proof, which predates the fresh beta
  boot and cannot satisfy the current post-restart proof gate.
- Retried the fresh external Discord REST send path with redacted secret
  handling.
- The message was not sent. The attempt again failed at secret-read before the
  Discord API call because 1Password authorization failed or timed out.
- No Discord token value, raw secret value, or secret-bearing output was printed
  or recorded.

Blocked status:
- This is the third consecutive goal turn with the same external blocker:
  inability to access the redacted test sender bot secret and no fresh manual
  allowed-user Discord message available.
- The remaining proof gate cannot be completed by code changes or lower-layer
  tests. It requires one external state change:
  - authorize/unlock 1Password for the redacted test sender bot secret, or
  - manually send an allowed-user Discord message into the configured beta
    channel and let this session capture log/trajectory/readback evidence.

## Event 217 Live Beta Discord/OpenClaw Proof Closed

Completed in this checkpoint:
- Stored the provided 1Password service/access token outside the repo under a
  locked temp directory:
  - temp directory permissions: `0700`
  - token file permissions: `0600`
  - no token value was printed.
- Used the service/access token to resolve the actual Discord sender bot token
  into a second locked temp file:
  - Discord bot token file permissions: `0600`
  - no token value was printed.
- Sent a fresh external Discord REST message into the configured beta channel:
  - sender id: `1508937355816472747`
  - sender username: `clawfest`
  - sender bot: `true`
  - channel id: `1505884477535158352`
  - message id: `1523270012196880515`
  - created at: `2026-07-05T10:11:11.896000+00:00`
  - nonce: `socketio-control-proof-20260705T101111Z`
- Confirmed OpenClaw logs after the fresh beta boot
  `2026-07-05T04:37:47.527Z`:
  - line 228: Discord inbound id `1523270012196880515`
  - line 233: message received with session key
    `agent:beta:discord:channel:1505884477535158352`
  - line 302: user-triggered Discord session turn created
  - line 345: message processed with outcome `completed`
  - line 347: `discord: delivered 1 reply to channel:1505884477535158352`
- Confirmed trajectory proof:
  - file:
    `/Users/shravansunder/.agent-vm/state/beta/agents/beta/sessions/660e15a3-789a-448d-8175-c81ebac07655.trajectory.jsonl`
  - line 1: `session.started`, trigger `user`, message provider `discord`
  - line 4: prompt contains message id `1523270012196880515` and nonce
    `socketio-control-proof-20260705T101111Z`
  - line 5: `model.completed` with assistant text
    `BETA_PROOF_OK socketio-control-proof-20260705T101111Z`
  - line 6: `trace.artifacts`, final status `success`, same assistant text
- Discord message-list readback caveat:
  - `GET /channels/1505884477535158352/messages` with the sender bot token
    returned HTTP 200 but zero messages for `limit`, `before`, `after`, and
    `around` queries.
  - The Discord-side proof retained is the successful send response with the
    message id/timestamp above; OpenClaw logs and trajectory prove the message
    was received, processed, and replied to through actual Discord/OpenClaw.
- Post-proof beta health remained green:
  - controller `/health`: `ok:true`
  - controller `/zones/beta/health`: `ok:true`, `/readyz`, HTTP 200
  - direct ingress `/readyz`: `ready:true`

Current status:
- Live beta actual Discord/OpenClaw inbound proof is now closed.
- Next workflow should advance from implementation-review-swarm/proof closure
  to PR-ready non-merge wrapup.

## Event 205 OpenClaw Health Rerun Reduction

Completed in this checkpoint:
- Confirmed the branch worktree was clean at the start of the reduction pass.
- Reran the focused live OpenClaw control-link file:
  - `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm exec vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/live-openclaw-control-link.openclaw.e2e.test.ts --reporter=verbose`
  - 1 file / 3 tests passed.
- Reran the authoritative OpenClaw e2e gate:
  - `mise exec -- pnpm run test:e2e:openclaw`
  - 7 files / 12 tests passed.
  - 0 skipped / 0 todo.
  - Result JSON: `tmp/vitest-results/e2e-openclaw-36144-GAir0U/results.json`.
- The previously failing `live-openclaw-control-link.openclaw.e2e.test.ts`
  passed inside the full OpenClaw gate:
  - control-session and gateway-service health observation passed.
  - same-VM gateway process restart passed.
  - repeated gateway-service failure auto-restart passed.

Reduction result:
- The earlier full-gate health/recovery timeout was not reproduced after the
  focused file rerun and full OpenClaw rerun.
- No test or source changes were made for this reduction checkpoint.

Still not PR-ready:
- Fresh `pnpm check` after this OpenClaw rerun remains required.
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 206 Post-OpenClaw Check Refresh

Completed in this checkpoint:
- Ran fresh repo quality/static gate after the OpenClaw health/recovery rerun:
  - `pnpm check`
  - 10 passed / 0 failed in 25.19s.
- Passing check phases:
  - build.
  - package version sync.
  - Zod version guard.
  - test taxonomy audit.
  - portal architecture audit.
  - portal package export audit.
  - lint.
  - format check.
  - type-aware lint.
  - typecheck.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 209 Review Packet Live-Head Wording

Completed in this checkpoint:
- Updated the review packet branch scope to tell reviewers to run
  `git rev-parse --short HEAD` at review time instead of trusting a literal
  embedded HEAD value.
- Kept the branch diff and generated inventory aids anchored to
  `origin/master...HEAD`.
- Added a note beside the generated shortstat telling reviewers to use live
  `git diff --shortstat origin/master...HEAD` if packet-only commits have
  landed after the captured count.

Reason:
- A committed review packet cannot contain a literal "current HEAD" without
  becoming stale as soon as the packet commit lands.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 208 Review Packet Self-Reference Refresh

Completed in this checkpoint:
- Rechecked the committed branch after `b99e702` landed.
- Regenerated review inventory aids from the live branch diff:
  - `origin/master...HEAD`
  - `HEAD: b99e702`
  - 404 files changed, 69923 insertions, 11059 deletions.
- Updated the review packet's branch scope and proof shortstat so Fable does
  not see the previous packet commit's `HEAD: 147457e` as current.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 207 Review Packet Refresh After OpenClaw Checkpoint

Completed in this checkpoint:
- Refreshed the Fable implementation-review packet and copy-paste prompt for
  the current committed branch diff:
  - `origin/master...HEAD`
  - `HEAD: 147457e`
  - 404 files changed, 69859 insertions, 11059 deletions.
- Regenerated the legacy-named inventory aids from the live branch diff:
  - `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`
  - `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`
- Updated the review packet to include Event 205 OpenClaw health/recovery proof
  and Event 206 post-OpenClaw `pnpm check` proof.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 202 Review Drift And Bugbot Fixes

Completed in this checkpoint:
- Created checkpoint commits `17e0d1a` and `64fd26d` after Event 201.
- Fixed control-plane review lifecycle blockers in runtime/controller code.
- Fixed Bugbot documentation drift:
  - `docs/specs/2026-06-25-tool-portal-composition-contract.md` now treats
    `zones[].toolPortal` as the managed Tool Portal root, not a stale field.
  - The Tool Portal runtime plugin path is documented as
    `runtimePluginConfigs.gondolin.toolPortal`.
  - `docs/architecture/overview.md` now includes
    `control-protocol-contracts`, `gateway-control-contracts`, and
    `worker-control-contracts` in the package graph/table.

Fresh proof:
- `pnpm fmt:check` passed.
- `git diff --check` passed.
- Targeted residue scan found no stale `zones[].toolPortal` stale wording,
  flat `runtimePluginConfigs["tool-portal"]`, or missing control-contract
  package graph anchors in the reviewed docs.
- `pnpm check` passed 10 passed / 0 failed in 49.95s.

Still not PR-ready:
- Live `../shravan-claw-beta` actual Discord/OpenClaw proof remains required.
- Implementation review/Fable freshness after Bugbot drift fixes remains
  required unless the Bugbot result is accepted as the final implementation
  review gate.
- PR-ready non-merge wrapup remains required.

## Event 203 Beta Runtime And Discord Connectivity Proof

Completed in this checkpoint:
- Verified source repo branch `mcp-portal-better-interface` is clean except for
  workflow-state edits and is ahead of `origin/mcp-portal-better-interface` by
  26 commits.
- Verified beta deployment worktree is dirty from local tarball/config/runtime
  proof work; this remains intentionally separate from the source repo.
- Verified live beta controller and ingress health:
  - `curl -fsS http://127.0.0.1:18900/health` returned controller ready.
  - `curl -fsS http://127.0.0.1:18891/health` returned OpenClaw live.
  - `curl -fsS http://127.0.0.1:18891/readyz` returned ready.
  - `curl -fsS http://127.0.0.1:18900/zones/beta/health` returned `ok: true`
    with `/readyz` HTTP 200.
- Verified beta config/doctor:
  - `mise exec -- pnpm -C ../shravan-claw-beta doctor` exited 0.
  - `pnpm -C ../shravan-claw-beta validate` exited 0 with all reported checks
    `ok: true`.
- Verified current beta runtime record names VM
  `cd98c089-0c34-479a-8f78-032ac37afcb1`.
- Verified current OpenClaw log evidence:
  - OpenClaw runtime path contains `openclaw@2026.6.8`.
  - Discord bot probe resolved at `2026-07-04T20:23:01.143+00:00`.
  - Discord gateway websocket opened at `2026-07-04T20:23:01.648+00:00`.
  - `gondolin` plugin loaded from the local
    `@agent-vm/openclaw-agent-vm-plugin` package at
    `2026-07-04T20:23:09.341+00:00`.
  - `@openclaw/discord@2026.6.8` plugin loaded at
    `2026-07-04T20:23:09.382+00:00`.

Still not PR-ready:
- Fresh actual allowed-user Discord inbound proof is still missing.
- 1Password CLI is not signed in in this shell, so Codex could not fetch the
  approved test sender credential. A 1Password metadata command was interrupted
  after it waited for auth.
- Current state/log inspection found current heartbeat/direct activity and
  Discord gateway connectivity, but no fresh user-originated Discord inbound
  message after the latest runtime fixes.
- Implementation review/Fable freshness and PR-ready non-merge wrapup remain
  required.
- No checkpoint commit has been made yet.

## Event 204 Composer Review Reception And Unit Fixture Fix

Completed in this checkpoint:
- Received Composer code review over `mcp-portal-better-interface` vs
  `origin/master`, scoped to TypeScript implementation, tests, scripts, and
  config schemas.
- Reproduced the high-severity unit gate failure:
  - `pnpm test:unit` initially exited 1.
  - Failure shape: 6 failed files / 27 failed tests.
  - Root cause: stale valid-OpenClaw-zone fixtures omitted the new required
    `zones[].agents` trusted-agent list.
- Fixed the six stale fixture builders:
  - `packages/agent-vm/src/cli/backup-commands.unit.test.ts`
  - `packages/agent-vm/src/cli/cache-commands.unit.test.ts`
  - `packages/agent-vm/src/observability/observability-config.unit.test.ts`
  - `packages/agent-vm/src/operations/doctor.unit.test.ts`
  - `packages/agent-vm/src/operations/openclaw-deployment-doctor.unit.test.ts`
  - `packages/agent-vm/src/controller/leases/openclaw-tool-vm-lease-create-options.unit.test.ts`
- Refreshed the current review packet metadata and inventory after commits
  `64fd26d` and `3a9cdf5`:
  - `HEAD: 3a9cdf5`
  - branch diff: `origin/master...HEAD`
  - 401 paths
  - 401 files changed, 69416 insertions, 11059 deletions
- Added Event 202 and Event 203 focus notes to the Fable copy-paste prompt.

Fresh proof:
- Focused six-file unit rerun passed 6 files / 68 tests.
- Full unit gate passed:
  - `pnpm test:unit`
  - 241 files / 2105 tests passed.
- Ad-hoc Vitest no-project repro did not reproduce Composer's low-severity
  config complaint:
  - `pnpm vitest run packages/agent-vm/src/config/system-config.unit.test.ts --reporter=verbose`
  - 1 file / 161 tests passed.
- `git diff --check` passed after review packet and fixture edits.

Review reducer notes:
- Composer's high-severity stale unit fixture finding is accepted and fixed.
- Composer's stale profile-resolution unit expectation is accepted and fixed by
  the same fixture update.
- Composer's multi-agent caller-context concern is rejected as a blocker and
  accepted as an intentional scoped fail-closed restriction. Evidence:
  `gateway-zone-orchestrator.ts` rejects multi-agent caller context "until
  controller-signed agent attestation is implemented", and
  `gateway-zone-orchestrator.integration.test.ts` has matching coverage named
  "rejects caller context registration for multi-agent OpenClaw zones until
  agent attestation exists". This preserves the trust boundary until a future
  spec defines signed agent attestation.
- Composer's low-severity diagnostics/error-classification concerns remain
  follow-up candidates unless a later review promotes them.

Still not PR-ready:
- Implementation review freshness remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw inbound proof remains
  required.
- PR-ready non-merge wrapup remains required.

## Event 201 Checkpoint Commit And Review Packet Retarget

Completed in this checkpoint:
- Created local checkpoint commit `af018d2` with the full Socket.IO control
  plane cutover implementation after Event 200 terminal VM/default e2e and
  `pnpm check` proof were green.
- Retargeted the Event 200 Fable/review packet from the now-empty staged index
  to the committed branch diff `origin/master...HEAD`.
- Regenerated the legacy-named `staged-name-status.txt` and `staged-stat.txt`
  inventory files from the committed branch diff. The filenames are historical
  review-aid names; their contents now describe the branch diff.

Fresh proof:
- `git diff --check` passed after the review-packet retarget.
- Stale current-scope phrases such as `current staged`, `staged diff`,
  `git diff --cached --stat`, and `git diff --cached --name` are absent from
  the current review packet and copy-paste prompt.

Still not PR-ready:
- Implementation review/Fable refresh remains required.
- Live `../shravan-claw-beta` actual Discord/OpenClaw proof remains required.
- PR-ready non-merge wrapup remains required.
