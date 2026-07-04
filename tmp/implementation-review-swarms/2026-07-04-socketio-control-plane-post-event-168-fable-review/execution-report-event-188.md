Event 188 Execution Report
==========================

Scope
-----

Accepted internal-review findings fixed after Event 187:

- Worker death-grace classification used raw transport connection state before
  accepted hello.
- Tool Portal controller-host-action caller contexts were not released after
  terminal use.
- Package export verifier missed runtime-consumed named exports.
- JSON Schema proof compared fresh generated output to fresh generated output.
- Stale `lease-list` vocabulary still shipped from gateway policy contracts.
- SG gateway orchestrator test asserted SSH Git egress without a `zoneGit`
  allowlist fixture.

Fixes Staged
------------

- `ControlSessionDiagnostics` now exposes accepted/ready state and Worker
  death-grace classification uses `ready`, not raw `connected`.
- Gateway controller-host-action handling releases caller contexts after
  terminal success/failure/stale rejection; plugin-side host-action caller
  context cache is forgotten after terminal use.
- `scripts/verify-portal-package-exports.ts` now checks runtime-consumed named
  exports from control contract packages and MCP provider backend surfaces.
- Control, gateway, and worker contract JSON Schema tests now compare reviewed
  static schema artifacts.
- Stale `lease-list` public vocabulary was removed from gateway control policy
  contracts and covered with negative assertions.
- Gateway orchestrator integration fixture now sets `zoneGit.remote.repoUrl`
  before asserting managed SSH Git egress policy.

Proof
-----

```text
pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/gateway-interface/src/health/controller-request-policy.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts
  exit 0, 6 files / 72 tests passed

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/agent-vm/src/controller/worker-task-runner.integration.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts
  exit 0, 3 files / 118 tests passed

pnpm exec tsx scripts/verify-portal-package-exports.ts
  exit 0, 21 required imports resolved, 79 named exports present, 2 smoke calls passed, 4 deferred imports absent

pnpm fmt:check
  exit 0

pnpm lint
  exit 0, 0 warnings / 0 errors

pnpm lint:types
  exit 0, 0 warnings / 0 errors

pnpm typecheck
  exit 0 across 17 workspace projects

git diff --check
  exit 0

pnpm check
  exit 0, 9 passed / 0 failed
```

Review Packet
-------------

- Review packet refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`
- Copy-paste Fable prompt refreshed:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md`
- Staged inventory regenerated from explicit `git diff --cached origin/master`:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt`
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt`

Current Scope
-------------

```text
branch: mcp-portal-better-interface
base: origin/master
staged diff: 365 files changed, 61456 insertions, 11021 deletions
```

Decision
--------

Event 188 fixes are staged and proof is green. The workflow can route to
implementation-review-swarm / Fable review.

This is review-readiness, not PR-readiness. Terminal OpenClaw, Worker, VM,
default e2e, and beta Discord/OpenClaw proof still need a fresh pass after
accepted Fable findings are fixed or rejected with evidence.
