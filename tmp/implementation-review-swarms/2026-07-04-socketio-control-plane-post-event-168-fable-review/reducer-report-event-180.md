Post-Event-179 Reducer Report
=============================

Reviewed state:

- The durable workflow details claimed Event 179 was Fable-review ready.
- Live worktree inspection showed unstaged reducer edits after that checkpoint.
- Focused RED proof confirmed three remaining failing tests before this pass:
  lazy Tool Portal caller-context registration, shippable docs/manual residue
  audit coverage, and current Tool Portal manual response shape.

Accepted findings fixed in this reducer pass:

1. Tool Portal discovery registered controller-host-action caller context.
   - `tool-portal-native-tools.ts` now only computes and caches caller-context
     scope while creating the entry point.
   - `gateway-control-controller-host-action-backend.ts` lazily registers the
     controller-host-action caller context only when `tool_portal_call` executes
     `zone_git_push`.

2. Shippable docs/manual residue audit missed `docs/reference/**` and
   `docs/subsystems/**`, and did not catch backticked `push-branches`.
   - `scripts/audit-portal-architecture.ts` now scans those roots and catches
     generic `push-branches` residue in shippable docs/manual templates.
   - Current Worker docs now describe `worker_control_rpc` git intents instead
     of old Worker HTTP callback guidance.

3. Generated MCP/Tool Portal manual still taught the old
   `{ ok, results, errors, diagnostics }` response shape.
   - `manual-templates.ts` now documents `{ ok, items, diagnostics? }` with
     per-item `status`, `value`, and `error`.

Proof after fixes:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts scripts/audit-portal-architecture.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts
  passed, 4 files / 16 tests

pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts
  passed, 3 files / 65 tests

pnpm exec tsx scripts/audit-portal-architecture.ts
  passed

rg -n "push-branches|worker-push-branches|worker-pull-default" docs/architecture docs/getting-started docs/reference docs/subsystems packages/agent-vm/src/cli/manual-templates.ts
  returned no matches

pnpm fmt:check
  passed

pnpm lint
  passed, 0 warnings / 0 errors

pnpm lint:types
  passed, 0 warnings / 0 errors

pnpm typecheck
  passed across 17 workspace projects

git diff --check && git diff --cached --check
  passed

pnpm check
  passed, 9 passed / 0 failed
```

Post-reducer status:

- Current staged branch is ready for a fresh Fable / implementation-review pass.
- This is review-readiness, not PR-readiness.
- Terminal runtime e2e gates and beta Discord/OpenClaw proof still need to be
  refreshed after accepted Fable findings are fixed or rejected with evidence.
