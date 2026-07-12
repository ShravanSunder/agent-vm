Execution Report Event 190
==========================

Goal:

- 2026-07-02-socketio-control-plane

Source finding packet:

- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-189.md

Summary
-------

Accepted Event 189 blocker/important findings were fixed and staged. The review
packet is refreshed for a new implementation-review-swarm / Fable pass.

This is review-readiness, not PR-readiness. Terminal runtime proof remains
outstanding after Fable findings are accepted/fixed or rejected with evidence.

Fixes Folded
------------

1. Managed Tool Portal effective config guest-writable / path trust blocker:
   - Controller-authored managed Tool Portal effective config is mounted
     read-only into the OpenClaw guest.
   - Effective-config manifest paths are validated as inside the expected
     controller-owned directory before use.
   - Relevant files:
     - packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts
     - packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts
     - packages/openclaw-gateway/src/openclaw-lifecycle.ts
     - packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts

2. Post-ack handler exceptions:
   - Control dispatcher/services now split pre-ack validation from post-ack
     execution.
   - Accepted command handler failures produce explicit domain
     `command_result` messages with failed status when the domain handler can
     build one, instead of surfacing only as transport timeouts.
   - Relevant files:
     - packages/agent-vm/src/controller/control-session/control-session-dispatcher.ts
     - packages/agent-vm/src/controller/control-session/control-session-client.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts
     - packages/agent-vm/src/controller/control-session/worker-control-domain-handler.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts
     - packages/agent-vm-worker/src/control-session/worker-control-service.ts

3. Reserved handler-response receipt failures:
   - Reserved response receipt send failures now stale/close the session with a
     sequence-gap signal instead of being swallowed after sequence reservation.
   - Relevant files:
     - packages/agent-vm/src/controller/control-session/control-session-client.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts
     - packages/agent-vm-worker/src/control-session/worker-control-service.ts

4. Gateway `zone_git_push` identity across ack-before-result flaps:
   - Gateway host-action backend now retains `messageId`, `commandId`, and
     `idempotencyKey` across transport uncertainty.
   - It clears retained identity after terminal result/domain error and resets
     identity when a stale caller-context retry changes the authority context.
   - Relevant files:
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts

5. `/leases` plan contradiction:
   - The plan/slice now consistently treat public lease-list disposition as
     delete, not gate.
   - Relevant files:
     - docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md
     - docs/specs/2026-07-02-socketio-control-plane/slices/05-s4b-controller-route-disposition.md

6. Portal export verifier root runtime exports:
   - Export verifier covers runtime-consumed root named exports from
     `@agent-vm/agent-portal-sdk` and
     `@agent-vm/controller-execution-contracts`.
   - Relevant file:
     - scripts/verify-portal-package-exports.ts

7. Portal call JSON Schema proof:
   - Portal call contract tests now compare generated schemas to a reviewed
     static snapshot artifact.
   - Relevant files:
     - packages/agent-portal-sdk/src/portal-call-surface/portal-call-contracts.unit.test.ts
     - packages/agent-portal-sdk/src/portal-call-surface/portal-call-json-schema.snapshot.json

Focused Proof
-------------

Focused integration:

```text
pnpm vitest run --config vitest.config.ts --project integration \
  packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts \
  packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts \
  packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts

passed: 3 files / 70 tests
```

Focused unit:

```text
pnpm vitest run --config vitest.config.ts --project unit \
  packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts \
  packages/agent-portal-sdk/src/portal-call-surface/portal-call-contracts.unit.test.ts \
  packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts \
  packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts \
  packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts

passed: 5 files / 42 tests
```

Focused host e2e:

```text
pnpm vitest run --config vitest.config.ts --project e2e-host \
  packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts \
  -t 'mounts managed Tool Portal effective config read-only'

passed: 1 file / 1 selected test, 54 skipped
```

Portal export verifier:

```text
pnpm exec tsx scripts/verify-portal-package-exports.ts

passed: 21 required imports resolved, 96 named exports present,
2 smoke calls passed, 4 deferred imports absent
```

Static and quality proof:

```text
pnpm lint
passed: 0 warnings / 0 errors

pnpm typecheck
passed: all workspace projects

pnpm lint:types
passed: 0 warnings / 0 errors

git diff --check
passed

pnpm check
passed: 9 passed / 0 failed
```

`pnpm check` summary:

```text
PASS build
PASS package-versions
PASS zod-version
PASS test-taxonomy
PASS portal-architecture
PASS portal-exports
PASS format
PASS type-aware-lint
PASS typecheck
```

Remaining Required Terminal Proof
---------------------------------

Do not call this PR-ready yet. After Fable review findings are accepted/fixed or
rejected with evidence, refresh:

```text
mise exec -- pnpm run test:e2e:openclaw
mise exec -- pnpm run test:e2e:worker
mise exec -- pnpm run test:e2e:vm
mise exec -- pnpm test:e2e
pnpm check
live ../shravan-claw-beta proof with actual Discord and OpenClaw
```

Review Handoff
--------------

Refreshed artifacts for Fable:

- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt
