Implementation Execute Report - Event 186
=========================================

Verdict
-------

ready_for_review

Reason:

- Event 185 accepted blocker and important findings were fixed in the staged
  worktree.
- Focused unit, integration, host-e2e, lint, typecheck, architecture audit,
  export audit, and `pnpm check` proof passed.
- Terminal runtime e2e and beta Discord/OpenClaw proof remain intentionally
  out ahead after the next implementation-review pass.

Accepted Event 185 Findings Addressed
-------------------------------------

1. Caller-context ids now bind to accepted gateway boot/session.
   - `GatewayControlTrustedCallerContext` stores `bootId`.
   - Controller domain handling validates caller contexts against accepted
     session `bootId`, `controllerEpoch`, `peerId`, and `zoneId`.
   - Old contexts are removed when a newer boot supersedes them, and successful
     lease release evicts its caller context.

2. Managed OpenClaw no longer preserves deprecated `mcp-portal` plugin runtime
   config.
   - Runtime `mcp-portal` plugin config is rejected.
   - Stale base `plugins.allow`, `plugins.entries`, `plugins.installs`, and
     `plugins.load.paths` entries for `mcp-portal` are stripped from the
     managed effective config.

3. Tool Portal no longer imports `@agent-vm/mcp-portal/core` in production
   runtime code.
   - MCP core construction moved behind
     `@agent-vm/mcp-portal/mcp-provider-backend`.
   - Architecture audit now rejects Tool Portal production imports from
     `@agent-vm/mcp-portal/core`.

4. `GET /leases` is removed rather than left as an unauthenticated diagnostic.
   - Controller HTTP route is gone.
   - Controller client no longer exposes `listLeases`.
   - `agent-vm controller lease list` is unsupported after the hard cutover.

5. Tool Portal host-action stale caller-context recovery retries once in the
   same user call.
   - The gateway backend clears stale scoped cache, re-registers caller context,
     and replays the same controller-host-action request once.
   - `zone_git_push` arguments are strict Zod-validated before RPC dispatch.

6. Failed accepted gateway/worker upgrade credentials are terminal-stamped.
   - Gateway and Worker control services set `terminalAtMs` when an accepted
     credential fails during Engine.IO handoff.
   - Reapers can evict those failed records and free capacity.

7. Managed SSH Git read allowlisting is generic and fail-closed.
   - Trusted repo URLs derive both SSH host allowlist and normalized repo path.
   - GitHub shorthand remains supported for bare `org/repo`.
   - Worker/OpenClaw lifecycles omit SSH egress when no trusted repo allowlist
     exists, allow `git-upload-pack`, and deny `git-receive-pack`.

8. Managed docs no longer imply OpenClaw `hmacKey` approval-token behavior.
   - `system-json.md` scopes `hmacKey` to standalone/external MCP Portal
     approval-token flows and says managed OpenClaw rejects
     `calls.requiresApproval` in this cutover.

Fresh Proof
-----------

- Red proof for `GET /leases`: targeted route test failed with HTTP 200 before
  route removal.
- Red proof for CLI lease list: corrected targeted test failed because the stale
  command still created a controller client.
- Red proof for managed `mcp-portal` config: host-e2e tests failed because
  stale config remained and runtime config did not reject.
- Red proof for Tool Portal core import audit: architecture audit unit failed
  until Tool Portal direct core imports were forbidden.
- Red proof for generic Git allowlist: new helper tests failed before generic
  functions existed.

Focused proof passed:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts packages/gateway-interface/src/git-read-allowlist.unit.test.ts packages/worker-gateway/src/worker-lifecycle.unit.test.ts scripts/audit-portal-architecture.unit.test.ts`
  - 9 files / 63 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-client.unit.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts -t "does not expose active leases|does not expose deleted VM-facing lease peek or release client methods|calls the controller service routes|rejects removed controller lease subcommands"`
  - 3 files / 4 selected tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts -t "Engine.IO handoff throws"`
  - 2 files / 2 selected tests passed.
- `pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts -t "strips stale MCP Portal|rejects runtime MCP Portal|allows only trusted Git SSH reads"`
  - 1 file / 3 selected tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/tool-portal/src/in-process-entrypoint/tool-portal-mcp-backed-capabilities.integration.test.ts packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.integration.test.ts`
  - 2 files / 2 tests passed.
- `pnpm lint`
  - 0 warnings / 0 errors.
- `pnpm lint:types`
  - 0 warnings / 0 errors.
- `pnpm typecheck`
  - all workspace projects passed.
- `git diff --check && git diff --cached --check`
  - passed.
- `pnpm check`
  - 9 passed / 0 failed: build, package-version sync, Zod guard, test
    taxonomy, portal architecture, portal exports, format, type-aware lint,
    typecheck.

Known Residual Risk / Next Review Focus
---------------------------------------

- A full `agent-vm-entrypoint.unit.test.ts` run still has an unrelated existing
  init-config fixture failure about `zones[].agents`; the Event 185 lease CLI
  test is green in focused form. This should not be treated as proof of the
  Event 185 route fix, but it may need cleanup before a broader unit gate if it
  remains in the full suite.
- Worker git RPC e2e and terminal OpenClaw/Worker/VM/default e2e proof still
  need fresh terminal reruns after implementation review findings are accepted
  or rejected with evidence.
- `../shravan-claw-beta` actual Discord/OpenClaw proof remains required before
  PR-ready non-merge wrapup.
