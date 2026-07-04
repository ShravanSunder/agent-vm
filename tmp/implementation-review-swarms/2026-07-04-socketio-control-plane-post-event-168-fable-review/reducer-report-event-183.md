Post-Event-182 Parent Reducer Report
====================================

Verdict: needs_revision

Reviewed current issue:

- Prior handoff and source inspection identified a blocker where gateway
  control-session signer material was persisted in the guest-visible
  `gateway-runtime.json` under `zone.gateway.stateDir`.

Accepted finding fixed in this checkpoint:

1. Gateway control private signer material was guest-visible.

   Evidence before fix:

   - `packages/agent-vm/src/gateway/gateway-runtime-record.ts` accepted
     `controlSession.privateKeyPkcs8Pem`.
   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` wrote
     `serializeGatewayControlSessionMaterial(controlSessionMaterial)` into the
     gateway runtime record.
   - `packages/openclaw-gateway/src/openclaw-lifecycle.ts` mounts
     `zone.gateway.stateDir` into the OpenClaw guest at
     `/home/openclaw/.openclaw/state`.

   Resolution:

   - Removed `controlSession` from `GatewayRuntimeRecord`.
   - Added a controller-only gateway control-session material store under
     `runtimeDir/control-sessions/gateway/<zoneId>/session-material.json`.
   - Startup now writes private signer material to that host runtime store and
     keeps `gateway-runtime.json` process/ownership-only.
   - OpenClaw runtime shutdown deletes the controller-only material alongside
     the gateway runtime record.
   - Added regression coverage that the guest-visible runtime record rejects
     `privateKeyPkcs8Pem` and that the startup integration path writes no
     private key text to `stateDir/gateway-runtime.json`.

Fresh focused proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-session-material-store.unit.test.ts packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts`
  exited 0 with 3 files / 18 tests passed.
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts`
  exited 0 with 1 file / 49 tests passed.
- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts`
  exited 0 with 1 file / 27 tests passed.
- `pnpm --filter @agent-vm/agent-vm typecheck` exited 0.
- `pnpm exec oxfmt --check` over touched files exited 0.
- `git diff --check && git diff --cached --check` exited 0.

Remaining concern surfaced during this checkpoint:

- Persisting signer material is not sufficient proof of controller restart
  reattachment. Gondolin 0.12.0 exposes CLI/session IPC attach primitives
  (`listSessions`, `findSession`, `connectToSession`) and checkpoint resume, but
  the public `VM` TypeScript API exposes only `VM.create(...)` plus instance
  methods. I did not find a public API that reconstructs a full `VM` /
  `ManagedVm` wrapper from an existing session with `enableIngress(...)` and
  the current agent-vm managed wrapper methods intact.
- This needs a focused implementation/design decision before claiming
  controller-restart reconnect is truly implemented. Options are: add a
  supported adapter over Gondolin session IPC if it can satisfy the required
  `ManagedVm` surface, revise the plan/spec to route controller restart to VM
  recreate, or upgrade Gondolin if a newer public API provides full session
  adoption.

Post-revision status:

- Signer exposure blocker fixed and staged/proven locally.
- Overall implementation remains not PR-ready. Continue with the remaining
  accepted review findings and the controller-restart reconnect design gap
  before another final Fable signoff.
