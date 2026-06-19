# 2026-06-18 OpenClaw Gateway Crash Recovery Plan

## Goal

Fix the recurring OpenClaw gateway hard-stop class seen on Sunclaw/shravan-claw
without collapsing distinct symptoms into one bucket.

The implementation should:

1. Move agent-vm managed OpenClaw from stale `2026.5.20` to the current stable
   managed line selected by fresh npm evidence.
2. Keep OpenClaw companion packages on the same line unless a deployment
   explicitly overrides them.
3. Harden the OpenClaw gateway process launch so an uncaught child-process crash
   becomes a restartable gateway-service outage instead of a VM-alive,
   service-dead terminal state.
4. Prove the change through focused repo tests and a local `shravan-claw-beta`
   validation path.

## Source Coverage

Read in full:

- `shravan-claw/docs/wip/debugging/2026-06-17-sunfam-agent-stop-and-toolvm-failures.md`
- `shravan-claw/docs/wip/debugging/2026-05-27-sunfam-gateway-undici-assert-crash.md`
- `packages/agent-vm/managed-images.json`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`

Partially inspected:

- `docs/getting-started/openclaw-guide.md`
- `docs/reference/validate-and-doctor.md`
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/operations/doctor.ts`
- `packages/agent-vm/src/operations/config-validation.ts`
- `packages/agent-vm/src/operations/doctor.unit.test.ts`
- `packages/openclaw-mcp-portal-plugin/package.json`
- `pnpm-lock.yaml`
- `shravan-claw-beta/package.json`
- `shravan-claw-beta/pnpm-workspace.yaml`
- `shravan-claw-beta/vm-images/gateways/openclaw/overlay.jsonc`

## Current Evidence

The 2026-06-17 incident hard stop was an OpenClaw gateway Node process crash
inside the gateway VM:

```text
undici@8.3.0 Parser.finish
  -> AssertionError assert(!this.paused)
  -> OpenClaw Node process exit
  -> gateway service unreachable
  -> controller recovery already suspended after max failed recoveries
```

The same assertion crash was previously observed on 2026-05-27. Tool VM
failures in the 2026-06-17 window were real but adjacent: they were dominated
by controller request timeouts around lease renew and active-use start/end.

Fresh npm metadata on 2026-06-18 says:

- `openclaw` latest: `2026.6.8`
- `@openclaw/codex` latest: `2026.6.8`
- `@openclaw/discord` latest: `2026.6.8`
- `@openclaw/diagnostics-otel` latest: `2026.6.8`

OpenClaw 2026.6.8 and `@openclaw/discord` 2026.6.8 still depend on
`undici@8.3.0`, so the version bump is necessary but not sufficient as a hard
proof against this crash class.

## Design

### Layer 1: Managed Runtime Version

Update the agent-vm managed OpenClaw release manifest to the latest stable npm
line:

- `packages/agent-vm/managed-images.json`
  - `openClawVersion`: `2026.6.8`
  - `openAiCodexCliVersion`: align with `@openclaw/codex@2026.6.8`, which
    depends on `@openai/codex@0.139.0`

Then update the repo-local OpenClaw catalog/version hints from `2026.6.5` to
`2026.6.8` so doctor/docs/dev dependency surfaces agree with the managed
runtime.

### Layer 2: Gateway Process Restart Loop

Replace the one-shot `nohup openclaw gateway --port 18789 ... &` launch command
with a small shell supervisor loop in the gateway VM start command.

The loop should:

- source runtime secrets once at process launch
- write `gateway-boot: NODE_OPTIONS=...` as it does today
- `cd /home/openclaw`
- start `/usr/local/bin/openclaw gateway --port 18789`
- append child stdout/stderr to `gateway-boot-latest.log`
- when the child exits, log the exit code and attempt number
- sleep for a bounded delay before restart
- keep running in the background under one `nohup sh -c '...' &`

The loop is intentionally in-VM process supervision, not a replacement for
controller recovery. Controller recovery still owns VM restart, stale runtime
records, Tool VM lease release, and recovery suspension. The in-VM loop narrows
the failure surface where the VM is healthy but the OpenClaw child process died.

### Layer 3: Beta Validation

Use `shravan-claw-beta` as the local validation deployment, but do not assume it
already follows this checkout. Current read-only evidence says beta is dirty and
points at `../agent-vm.fix-health-lease/...` tarballs, and its overlay still
forces OpenClaw 2026.5.20.

The implementation should:

1. Build/package this checkout.
2. Run `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`.
3. Confirm beta dependency pins and overlay copy entries now point to this
   checkout's generated tarballs.
4. Update or remove beta `openClawPackageOverrides` so the beta gateway image
   tests OpenClaw 2026.6.8 rather than forcing 2026.5.20.
5. Run beta static and runtime proof.

## Requirements / Proof Matrix

Requirement / claim:
The plan preserves the root-cause distinction between gateway process crash and
Tool VM control-plane degradation.

Owning task:
Task 1.

Proof owner:
parent.

Proof gate:
Updated debug/research artifacts keep the 2026-06-17 and 2026-05-27 evidence
separate, and final report names both surfaces separately.

Proof layer:
documentation/evidence.

Stale-proof guard:
If the Sunclaw share becomes mounted, re-check raw logs; otherwise cite current
local shravan-claw runbooks as the available evidence.

Red/green required:
No, evidence artifact only.

Sized for scope:
yes.

Requirement / claim:
Managed OpenClaw runtime and repo-local docs/hints agree on the selected latest
stable release.

Owning task:
Task 2.

Proof owner:
implementation.

Proof gate:
Focused managed image release tests plus grep check for unintended stale
`2026.6.5`/`2026.5.20` references outside historical docs.

Proof layer:
unit/static.

Stale-proof guard:
Re-run npm metadata check before final report if implementation spans another
day.

Red/green required:
Yes for focused tests that assert the managed version.

Sized for scope:
yes.

Requirement / claim:
Generated managed OpenClaw gateway Dockerfiles install a same-line OpenClaw
package set and matching Codex CLI package.

Owning task:
Task 2.

Proof owner:
implementation.

Proof gate:
`pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build/managed-image-release.unit.test.ts`
and targeted build-command integration test if expectations change.

Proof layer:
unit/integration.

Stale-proof guard:
Run from the crash-fix checkout after edits.

Red/green required:
Yes.

Sized for scope:
yes.

Requirement / claim:
OpenClaw child process exit no longer leaves a gateway VM permanently service
dead without an in-VM restart attempt.

Owning task:
Task 3.

Proof owner:
implementation.

Proof gate:
Focused `openclaw-lifecycle.host.e2e.test.ts` assertion that the generated
start command contains the restart loop, logs child exit status, and still
sources secrets/redacts secret values.

Proof layer:
host e2e/unit-shaped lifecycle generation.

Stale-proof guard:
Run from the crash-fix checkout after edits.

Red/green required:
Yes.

Sized for scope:
yes.

Requirement / claim:
Beta proves the current checkout and selected OpenClaw line can validate/build
and serve locally.

Owning task:
Task 4.

Proof owner:
implementation.

Proof gate:
`pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`, beta
`pnpm validate`, beta `mise exec -- pnpm build`, beta start, controller health,
zone readiness, zone service-health, and ingress `/`, `/health`, `/healthz`,
`/readyz` probes.

Proof layer:
integration/smoke/runtime.

Stale-proof guard:
Check beta git status immediately before writes and report unrelated dirty
state separately from this task's changes.

Red/green required:
No durable automated red phase for live beta smoke; the lower-layer code tests
carry red/green, beta is runtime proof.

Sized for scope:
yes, unless Docker/QEMU/mise prerequisites are unavailable.

## Task Sequence

### Task 1: Finish Evidence Ledger

Write the final 2026.5.20 to 2026.6.8 change ledger from npm metadata, package
contents, DeepWiki synthesis, and local source evidence. Keep claims classed as
direct observation, cited source summary, inference, or unresolved.

### Task 2: Update Managed OpenClaw Version Surfaces

Change:

- `packages/agent-vm/managed-images.json`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `docs/getting-started/openclaw-guide.md`
- `docs/reference/validate-and-doctor.md`
- `packages/agent-vm/src/operations/doctor.ts`
- `packages/agent-vm/src/operations/config-validation.ts`
- `packages/agent-vm/src/operations/doctor.unit.test.ts`
- `packages/openclaw-mcp-portal-plugin/package.json`
- `pnpm-lock.yaml`
- possibly `packages/agent-vm/src/cli/manual-templates.ts`

Do not change historical debug docs just because they mention older versions.

### Task 3: Add In-VM Gateway Process Restart Loop

Change:

- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
- docs that describe the start command if needed:
  - `docs/architecture/openclaw-gateway.md`
  - `docs/subsystems/gateway-lifecycle.md`

Keep the boundary explicit: controller recovery restarts VMs; the in-VM loop
restarts the OpenClaw child process inside a still-running VM.

### Task 4: Repo Verification

Run focused gates first:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build/managed-image-release.unit.test.ts
pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/operations/doctor.unit.test.ts
pnpm fmt:check
pnpm typecheck
```

Then run broader scoped gate as time permits:

```text
pnpm check
```

If a broad gate fails outside the edited path, stop edits and report scoped
pass/fail plus the unrelated blocker.

### Task 5: Beta Sync And Runtime Proof

Before writes:

```text
git status --short --branch
```

from `shravan-claw-beta`.

Then:

```text
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
```

from this agent-vm checkout.

In beta:

```text
pnpm validate
mise exec -- pnpm build
mise exec -- pnpm start
curl http://127.0.0.1:18900/health
curl http://127.0.0.1:18900/zones/beta/health
curl http://127.0.0.1:18900/zones/beta/service-health
curl http://127.0.0.1:18891/
curl http://127.0.0.1:18891/health
curl http://127.0.0.1:18891/healthz
curl http://127.0.0.1:18891/readyz
```

Stop the beta controller after proof unless the user explicitly wants it left
running.

## Split / Replan Triggers

- If OpenClaw 2026.6.8 package contents introduce a config or plugin API
  incompatibility with agent-vm plugins, split compatibility migration from the
  process-supervisor work.
- If the restart loop prevents the controller from detecting service failure or
  creates log spam/restart storms, replan with a bounded restart limit and
  controller-visible health event instead of a simple infinite loop.
- If beta dirty state contains user-authored changes unrelated to dependency
  retargeting, stop before overwriting and report exact files.
- If Docker/QEMU/mise prerequisites block beta proof, keep repo proof scoped and
  report the runtime blocker without claiming live fix.

## Risks

- OpenClaw 2026.6.8 still uses `undici@8.3.0`, so version bump alone is not a
  proven fix for the exact assertion.
- A simple in-VM restart loop can hide repeated child crashes unless the boot log
  clearly records exits and the controller still sees unhealthy periods.
- Updating `@openai/codex` from `0.134.0` to `0.139.0` changes the managed image
  runtime and must be proven in beta, not inferred.
- Beta is already dirty and pointed at another sibling worktree; sync output
  must be inspected before any runtime claim.

## Rollback / Recovery

- Revert the managed version manifest and docs/hints if OpenClaw 2026.6.8 fails
  startup or schema validation.
- Revert the restart loop independently if it interferes with controller
  recovery.
- In beta, `mise exec -- pnpm stop` should stop the test controller. If runtime
  cleanup fails, use the repo's documented `force-stop` only after reporting the
  failure.

## Recommended Next Workflow

`shravan-dev-workflow:implementation-execute-plan` after one more parent check
of package release contents. The plan is intentionally executable unless the
OpenClaw package tarballs reveal an incompatibility that changes the design.
