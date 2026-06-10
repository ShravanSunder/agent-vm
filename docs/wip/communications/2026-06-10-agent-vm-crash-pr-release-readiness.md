# 2026-06-10 Agent VM Crash PR / Release Readiness

## Candidate

Package set:

```text
@agent-vm/* 0.0.94 candidate
openclaw 2026.6.5
@openclaw/discord 2026.6.5
@openclaw/codex 2026.6.5
```

Branch base checked:

```text
HEAD == origin/master == 7a3929afd10eca7a491e7719759d7d1153186c6d
```

Recheck this immediately before publishing.

## PR Summary

This change separates two failure lanes that collided during the Sunclaw outage:

1. OpenClaw provider/readiness flaps, especially Discord `403` / websocket
   `1006`, should not by themselves cause destructive gateway VM replacement.
2. Gateway recovery and credential refresh must resolve 1Password secrets through
   a genuinely headless service-account path, with safe diagnostics if the
   provider fails.

## Main Changes

1Password / secrets:

- Isolate `op` CLI fallback into a fresh service-account environment.
- Force `OP_BIOMETRIC_UNLOCK_ENABLED=false`, `OP_CACHE=false`, and isolated
  `OP_CONFIG_DIR`.
- Do not forward ambient `OP_CONNECT_*`, `OP_SESSION*`, `OP_ACCOUNT`, or user
  config/cache env into fallback.
- Redact fallback stdout/stderr from errors.
- Preserve the 30s subprocess timeout for secret-management `op` fallback.
- Redact `op://` refs in operator-facing secret resolution errors.
- Reject `tokenSource.type = "op-cli"` for unattended service-account
  deployments.
- Add `1password-op-cli-headless` doctor coverage.

OpenClaw / recovery:

- Split OpenClaw readiness from service liveness:
  - `/readyz` remains operator readiness.
  - `/health` drives startup and periodic gateway-service liveness.
- Add `serviceHealthCheck` to gateway process specs.
- Make channel-provider VM restart opt-in by default for recoverable and
  unrecoverable channel events.
- Preflight replacement secrets, effective config, host state, Tool VM
  requirements, image build, and runtime ownership before closing the old
  gateway VM.
- Upgrade managed OpenClaw line to `2026.6.5`.

## Current Local Validation

```text
pnpm install --frozen-lockfile
  passed

pnpm check
  passed: 6/6 gates

mise run lint
  passed: 0 warnings, 0 errors

pnpm test:unit
  passed: 197 files, 1802 tests

pnpm test:integration
  passed: 23 files, 327 tests

pnpm test:e2e:inventory
  passed inventory: 1 file, 1 test
  skipped inventory: 15 files, 26 tests

mise exec -- pnpm test:e2e
  passed: 3 lanes, 0 failed
  e2e-host:          149 tests, 19 files, 0 skipped, 0 todo
  e2e-vm:             10 tests,  6 files, 0 skipped, 0 todo
  e2e-vm-mediation:    3 tests,  2 files, 0 skipped, 0 todo

mise exec -- pnpm test:e2e:openclaw
  passed: 8 files, 8 tests, no skips
  JSON report: tmp/vitest-results/e2e-openclaw-25135-ZqNnpE/results.json

git diff --check
  passed

zsh -n docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
  passed

pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts --config vitest.config.ts --project unit
  passed: 1 file, 10 tests

pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts --config vitest.config.ts --project e2e-host
  passed: 1 file, 33 tests

pnpm vitest run packages/agent-vm/src/controller/controller-runtime.unit.test.ts --config vitest.config.ts --project unit
  passed: 1 file, 24 tests

pnpm vitest run packages/secret-management/src/onepassword-secret-resolver.unit.test.ts packages/secret-management/src/composite-secret-resolver.unit.test.ts packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts packages/agent-vm/src/operations/doctor.unit.test.ts --config vitest.config.ts --project unit
  passed: 4 files, 78 tests

pnpm vitest run packages/mcp-portal/src/cli/serve-command.integration.test.ts --config vitest.config.ts --project integration
  passed: 1 file, 12 tests

focused rerun after adding non-destructive credentials check and shared ref redaction
  secret-management redaction/resolver/composite: 3 files, 46 tests passed
  CLI credentials/manual command coverage:       3 files, 87 tests passed
  pnpm build:                                    passed

focused rerun after recovery-runner log redaction
  recovery runner credential/restart log safety: 1 file, 5 tests passed
  recovery runner + health policy nearby tests:  3 files, 39 tests passed
  pnpm check:                                    6/6 gates passed
  mise run lint:                                 0 warnings, 0 errors
  pnpm build:                                    passed
  pnpm test:unit:                                196 files, 1786 tests passed
  pnpm test:integration:                         23 files, 326 tests passed
  pnpm test:e2e:inventory:                       1 passed, 15 files skipped, 26 tests skipped

packed candidate audit
  tarballs: 11
  package.json files: 11
  stale OpenClaw 2026.5.20 strings: 0
  exact runtime op ref matches: 0
  bearer token literal matches: 0
  headless/redaction/latest-version markers present
  credentials check/resolvedSecretCount markers present
  recovery-runner log redaction marker present in packed @agent-vm/agent-vm dist
  OP_CONNECT_* appears only in safe present/absent isolation metadata
  OP_SERVICE_ACCOUNT_TOKEN assignment-like match: redaction regex only, not a token value

synthetic remote proof harness smoke with fake pnpm/op/curl
  passed: proof-check summary emitted expected pass/observed/leak-scan lines

accepted subagent review fixes after the first proof bundle
  recovery-runner log redaction covers quoted/JSON-ish credential assignments
  remote proof harness leak scan covers bare ops_ strings, broader bearer values,
  token/secret/password assignments, and JSON-ish credential assignments
  final proof bundle is regenerated with macOS metadata suppressed

post-review packed candidate audit
  tarballs: 11
  package.json versions: all 0.0.94
  bad @agent-vm sibling deps: none
  managed OpenClaw version: 2026.6.5
  credentials check/resolvedSecretCount markers present
  recovery-runner secret log redaction markers present
  secret-management isolated op fallback and <1password-ref> markers present
  macOS metadata entries in package tarballs: 0

latest-base refresh
  pulled origin/master before publish prep
  HEAD == origin/master == 7a3929afd10eca7a491e7719759d7d1153186c6d
  recovery-runner conflict resolved by keeping upstream restart-classification
  coverage plus crash-fix redaction coverage
  focused recovery-runner unit test: 1 file, 11 tests passed
  pnpm check: 6/6 gates passed
  git diff --check: passed
  proof harness syntax check: passed
  latest-base tarballs: 11
  managed OpenClaw version: 2026.6.5
  macOS metadata entries in package tarballs: 0

final local proof after latest-base reapply
  pnpm check: 6/6 gates passed
  pnpm test:unit: 197 files, 1802 tests passed
  pnpm test:integration: 23 files, 327 tests passed
  mise exec -- pnpm test:e2e: 3 lanes passed, 0 failed
    e2e-host: 149 tests, 19 files, 0 skipped, 0 todo
    e2e-vm: 10 tests, 6 files, 0 skipped, 0 todo
    e2e-vm-mediation: 3 tests, 2 files, 0 skipped, 0 todo
  git diff --check: passed
  proof bundle sha256 check: passed
  proof bundle macOS metadata scan: no AppleDouble/PaxHeader entries
```

`pnpm test:e2e:secrets` is intentionally not proven locally because
`AGENT_VM_TEST_OP_REFS` is not set. Do not use deployment secrets for that repo
test lane.

## Proof Bundle

```text
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz.sha256
sha256: fabe3cdd0804f6bfefa60770c00d41a6b1d38a9777f52c1f13f3b8cf3a88963f
```

The bundle contains:

```text
11 package tarballs
docs/wip/debugging/2026-06-09-openclaw-1password-recovery-handoff.md
docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
docs/wip/communications/2026-06-10-remote-1password-openclaw-proof-request.md
docs/wip/communications/2026-06-10-agent-vm-crash-pr-release-readiness.md
```

Use the sidecar `.sha256` as authoritative after any artifact refresh.

## Remaining Before Calling Root Cause Fixed

Remote locked-1Password proof:

- Install the candidate on the remote deployment machine.
- Keep 1Password desktop locked.
- Run the proof harness.
- Confirm `doctor-locked-desktop` and `doctor-locked-desktop-poisoned-env`
  succeed with service-account isolation metadata.

Remote OpenClaw flap proof:

- During the next Discord `403` / websocket `1006` flap, confirm `/health`
  remains live while `/readyz` can be 503.
- Confirm `vmId`, QEMU PID, and `gateway-runtime.json` stay stable when only
  readiness is red.

Heartbeat causality proof:

- The first failing lane must be `agent:*:main:heartbeat` before claiming
  heartbeat caused the outage.
- If cron/direct lanes show earlier `401 token_invalidated`, heartbeat remains
  correlated workload, not proven first cause.

## Publish Guardrails

- Do not publish before the release PR is merged and local `master` is
  fast-forwarded to `origin/master`.
- Re-run `git fetch origin master` and verify `HEAD == origin/master`
  immediately before publish.
- Publish all `@agent-vm/*` packages together at the same version.
- Verify publication with `npm view <package> version` for every package.
