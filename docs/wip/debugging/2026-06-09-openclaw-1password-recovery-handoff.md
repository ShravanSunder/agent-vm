# 2026-06-09 OpenClaw Crash and 1Password Recovery Handoff

## Scope

This note is the remote-machine proof plan for the two failures observed on
Sunclaw:

1. OpenClaw becomes alive-but-not-ready during Discord `403` / websocket `1006`
   loops.
2. Agent-vm recovery then needs 1Password secrets; older packages could fail
   there and leave the gateway unavailable after the VM was closed.

The two lanes must stay separate. `secret-resolution-failed` explains why
replacement startup or credentials refresh cannot proceed; it is not proof that
1Password caused the original OpenClaw readiness failure.

Do not print tokens or resolved secrets. Redirect successful `op read` and
`op inject` probes to `/dev/null`.

Package target for this investigation:

```text
@agent-vm/*              0.0.94 candidate
openclaw                 2026.6.5
@openclaw/discord        2026.6.5
@openclaw/codex          2026.6.5
@1password/sdk           0.4.0
```

Local validation on this checkout:

```text
pnpm check
  passed: 6/6 gates
mise run lint
  passed: 0 warnings, 0 errors
pnpm test:unit
  passed: 196 files, 1786 tests
pnpm test:integration
  passed: 23 files, 326 tests
pnpm test:e2e:inventory
  passed inventory: 1 file, 1 test
  skipped inventory: 15 files, 26 tests
mise exec -- pnpm test:e2e:openclaw
  passed: 4 files, 8 tests, no skips, duration 732.07s
pnpm test:e2e:secrets
  blocked before auth: 1 file / 2 tests failed at test-vault env guard
  reason: AGENT_VM_TEST_OP_REFS is not set
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js manual update --target-dir tmp/manual-update-smoke-yn5fpt --agents --config config/system.jsonc --default-zone sunfam --json
  passed: generated 19 manual/agent files from the built CLI
  verified: operations manual separates readiness /readyz from service liveness /health
```

Focused audit rerun after package inspection:

```text
pnpm vitest run packages/secret-management/src/onepassword-secret-resolver.unit.test.ts packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts --config vitest.config.ts --project unit
  passed: 2 files, 51 tests

pnpm vitest run packages/agent-vm/src/controller/health/channel-provider-recovery-observation.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 60 tests

pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts --config vitest.config.ts --project integration
  passed: 1 file, 38 tests
```

Local audit rerun at 2026-06-10 03:45 EDT:

```text
1Password code audit:
  op CLI fallback uses a fresh isolated OP_CONFIG_DIR
  OP_BIOMETRIC_UNLOCK_ENABLED=false
  OP_CACHE=false
  OP_SERVICE_ACCOUNT_TOKEN is the resolved service-account token
  ambient OP_CONNECT_*, OP_SESSION*, OP_ACCOUNT, XDG config/cache/data,
  SSH_AUTH_SOCK, GitHub tokens, and unrelated host secrets are not forwarded
  child stdout/stderr from failing op commands are redacted
  redacted exec wrapper preserves the 30s child-process timeout
  doctor/probe hints redact the literal service-account token
  operator-facing error strings redact 1Password refs as <1password-ref>

OpenClaw recovery audit:
  openclaw lifecycle healthCheck is /readyz for operator readiness
  openclaw lifecycle serviceHealthCheck is /health for service liveness
  gateway startup waits on serviceHealthCheck ?? healthCheck
  /zones/<zoneId>/health calls readiness
  /zones/<zoneId>/service-health calls service liveness and records service-health
  periodic gateway-service monitor consumes service-health, so OpenClaw provider
  readiness failures do not feed the gateway-service restart counter
  channel-provider VM restart remains opt-in:
    restartGatewayOnRecoverable=false by default
    restartGatewayOnUnrecoverable=false by default

Targeted validation rerun:
  pnpm vitest run packages/secret-management/src/onepassword-secret-resolver.unit.test.ts packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts --config vitest.config.ts --project unit
    passed: 2 files, 51 tests
  pnpm vitest run packages/agent-vm/src/controller/health/channel-provider-recovery-observation.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts --config vitest.config.ts --project unit
    passed: 3 files, 60 tests
  pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts --config vitest.config.ts --project integration
    passed: 1 file, 38 tests
```

Local audit rerun at 2026-06-10 03:58 EDT after no-op-ref redaction:

```text
pnpm vitest run packages/secret-management/src/onepassword-secret-resolver.unit.test.ts packages/secret-management/src/composite-secret-resolver.unit.test.ts packages/agent-vm/src/gateway/credential-manager.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 53 tests

pnpm vitest run packages/agent-vm/src/controller/http/controller-health-event-routes.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 101 tests

pnpm typecheck
  passed

pnpm check
  passed: 6/6 gates
  package-versions, zod-version, test-taxonomy, format, type-aware-lint, typecheck

pnpm build
  passed: rebuilt all 11 workspace packages

No-op-ref check:
  fake upstream test errors still contain op:// inputs
  public thrown errors are asserted not to contain op://
  packed @agent-vm/secret-management dist contains <1password-ref> redaction
```

Local audit rerun at 2026-06-10 04:37 EDT after OpenClaw lifecycle and
credential-manager ref-redaction hardening:

```text
pnpm vitest run packages/agent-vm/src/gateway/credential-manager.unit.test.ts --config vitest.config.ts --project unit
  passed: 1 file, 10 tests

pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts --config vitest.config.ts --project e2e-host
  passed: 1 file, 33 tests

pnpm check
  passed: 6/6 gates
  package-versions, zod-version, test-taxonomy, format, type-aware-lint, typecheck

pnpm build
  passed: rebuilt all 11 workspace packages

Packed-content redaction check:
  @agent-vm/openclaw-gateway dist redacts configured 1Password refs as <1password-ref>
  @agent-vm/agent-vm credential-manager dist no longer prints generated op:// examples for missing refs
  packed production hit for op://...gateway-auth/password remains only in init-command config generation
```

Local audit rerun at 2026-06-10 05:05 EDT after non-destructive
`credentials check` and shared ref-fragment redaction:

```text
pnpm vitest run packages/secret-management/src/secret-redaction.unit.test.ts packages/secret-management/src/onepassword-secret-resolver.unit.test.ts packages/secret-management/src/composite-secret-resolver.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 46 tests

pnpm vitest run packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 87 tests

pnpm build
  passed: rebuilt all 11 workspace packages

Packed candidate audit:
  tarballs: 11
  all package versions: 0.0.94
  bad @agent-vm sibling deps: none
  managed OpenClaw version: 2026.6.5
  @agent-vm/agent-vm dist includes credentials check and resolvedSecretCount
  @agent-vm/secret-management dist includes isolated op fallback and shared ref redaction
  OP_CONNECT_* only appears in safe present/absent isolation metadata
```

Local audit rerun at 2026-06-10 05:39 EDT after recovery-runner
log-redaction hardening:

```text
pnpm vitest run packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.unit.test.ts --config vitest.config.ts --project unit
  passed: 1 file, 5 tests
  verifies credential-refresh and restart recovery logs redact op:// refs,
  service-account-token-looking strings, bearer values, password assignments,
  and token assignments

pnpm vitest run packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.unit.test.ts packages/agent-vm/src/controller/health/gateway-service-health-monitor.unit.test.ts packages/agent-vm/src/controller/health/channel-provider-recovery-observation.unit.test.ts --config vitest.config.ts --project unit
  passed: 3 files, 39 tests

pnpm check
  passed: 6/6 gates
  package-versions, zod-version, test-taxonomy, format, type-aware-lint,
  typecheck

mise run lint
  passed: 0 warnings, 0 errors

pnpm build
  passed: rebuilt all 11 workspace packages

pnpm test:unit
  passed: 196 files, 1786 tests

pnpm test:integration
  passed: 23 files, 326 tests

pnpm test:e2e:inventory
  passed inventory: 1 file, 1 test
  skipped inventory: 15 files, 26 tests
```

Local audit rerun at 2026-06-10 06:00 EDT after subagent review findings:

```text
Accepted 1Password review fixes:
  recovery-runner log redaction now covers quoted and JSON-ish credential
  assignments such as "token":"...", password="...", and 'secret':'...'
  remote proof harness leak scan now detects bare ops_ service-account-token
  looking strings, broader Bearer values, token/secret/password assignments,
  and JSON-ish credential assignments

Accepted release-proof review fix:
  final proof bundle must be created with macOS metadata suppressed and checked
  for AppleDouble/PaxHeader entries

pnpm check
  passed: 6/6 gates

focused recovery/doctor redaction tests
  passed: 2 files, 24 tests

zsh -n docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
  passed

packed candidate audit:
  tarballs: 11
  package.json versions: all 0.0.94
  bad @agent-vm sibling deps: none
  managed OpenClaw version: 2026.6.5
  @agent-vm/agent-vm dist includes credentials check and resolvedSecretCount
  @agent-vm/agent-vm dist includes recovery-runner secret log redaction
  @agent-vm/secret-management dist includes isolated op fallback and
  <1password-ref> redaction
  macOS metadata entries in candidate package tarballs: none
```

Latest-base refresh at 2026-06-10 06:11 EDT:

```text
git fetch origin master
git merge --ff-only origin/master
  passed after stashing and re-applying local crash-fix work
  resolved one test-file conflict by keeping upstream restart-classification
  coverage and the crash-fix redaction coverage

HEAD == origin/master
  7a3929afd10eca7a491e7719759d7d1153186c6d

pnpm vitest run packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.unit.test.ts --config vitest.config.ts --project unit
  passed: 1 file, 11 tests

pnpm check
  passed: 6/6 gates

git diff --check
  passed

zsh -n docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
  passed

latest-base packed candidate audit:
  tarballs: 11
  package.json versions: all 0.0.94
  bad @agent-vm sibling deps: none
  managed OpenClaw version: 2026.6.5
  credentials check/resolvedSecretCount markers present
  recovery-runner secret log redaction markers present
  secret-management isolated op fallback and <1password-ref> markers present
  macOS metadata entries in package tarballs: none
```

Final local proof after latest-base reapply:

```text
pnpm check
  passed: 6/6 gates

pnpm test:unit
  passed: 197 files, 1802 tests

pnpm test:integration
  passed: 23 files, 327 tests

mise exec -- pnpm test:e2e
  passed: 3 lanes, 0 failed
  e2e-host: 149 tests, 19 files, 0 skipped, 0 todo
  e2e-vm: 10 tests, 6 files, 0 skipped, 0 todo
  e2e-vm-mediation: 3 tests, 2 files, 0 skipped, 0 todo

mise exec -- pnpm test:e2e:openclaw
  passed: 8 files, 8 tests, 0 skipped, 0 todo

git diff --check
  passed

proof bundle
  sha256 check passed
  macOS metadata scan found no AppleDouble/PaxHeader entries
```

Broad local test rerun at 2026-06-10 04:17 EDT after proof-bundle refresh:

```text
pnpm test:unit
  passed: 195 files, 1780 tests

pnpm test:integration
  passed: 23 files, 326 tests

pnpm test:e2e:inventory
  passed inventory: 1 file, 1 test
  skipped inventory: 15 files, 26 tests
```

Local OpenClaw e2e rerun at 2026-06-10 05:16 EDT after non-destructive
`credentials check`, shared ref-fragment redaction, and current-source rebuild:

```text
mise exec -- pnpm test:e2e:openclaw
  passed: 4 files, 8 tests, no skips, duration 732.07s
  built gateway image with openclaw@2026.6.5, @openclaw/codex@2026.6.5,
  and @openclaw/discord@2026.6.5
  live-openclaw-control-link proved control-link, gateway-service, lease,
  Tool VM SSH health, and service-unhealthy auto-restart behavior
  JSON report: tmp/vitest-results/e2e-openclaw-25135-ZqNnpE/results.json
```

Remote proof harness dry run:

```text
zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
  executed against fake local pnpm/op/node/curl shims
  no real controller or 1Password state touched
  preflight checks rg, pnpm, node, op, config path, and installed package version
  fake raw doctor output included OP_SERVICE_ACCOUNT_TOKEN=SHOULD-NOT-SHARE
  fake raw doctor output included op://agent-vm/secret/credential
  share-safe summary leak matches: none
  raw doctor leak-scan files with matches: produced
  wrong installed @agent-vm/agent-vm version exits 2 before doctor/controller probes

Synthetic harness smoke after proof-check summary was added:
  fake pnpm/op/curl, no real controller or 1Password state touched
  proof-check:validate=passed exit=0
  proof-check:doctor-locked-desktop=passed exit=0
  proof-check:doctor-locked-desktop-poisoned-env=passed exit=0
  observed-exit:controller-status=0
  proof-check:leak-scan-matches=none

Focused production-path validation after the headless 1Password and
service-health audit:
  controller-runtime.unit.test.ts
    passed: 1 file, 24 tests
  onepassword-secret-resolver/composite/controller-doctor/doctor focused unit run
    passed: 4 files, 78 tests
  mcp-portal serve-command integration run
    passed: 1 file, 12 tests
```

Package inspection on this checkout:

```text
@agent-vm/agent-vm tarball version: 0.0.94
managed OpenClaw version:          2026.6.5
bad @agent-vm sibling deps:        none
managed image package pins:        none
stale OpenClaw 2026.5.20 strings: none in extracted candidate tarballs
op-cli token-source strings:       none in extracted candidate tarballs
```

Full local tarball bundle for remote proof:

```text
tmp/agent-vm-0.0.94-candidate-tarballs-20260610060805/
  11 @agent-vm/* tarballs
  all package versions: 0.0.94
  bad @agent-vm sibling deps: none
  managed OpenClaw version: 2026.6.5
  secret-management dist includes no-op-ref redaction
  agent-vm dist includes recovery-runner log redaction
  openclaw-gateway dist includes configured-ref redaction
  stale OpenClaw 2026.5.20 strings: none
  exact runtime op ref matches: none
  bearer token literal matches: none
  OP_SERVICE_ACCOUNT_TOKEN assignment-like match: redaction regex only
```

The proof harness is intentionally not part of the `@agent-vm/agent-vm` npm
package; that package contains `dist/` and `managed-images.json`. For a remote
machine that does not have this source checkout, copy the separate proof bundle
instead:

```text
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz.sha256
sha256: fabe3cdd0804f6bfefa60770c00d41a6b1d38a9777f52c1f13f3b8cf3a88963f
  agent-vm-0.0.94-candidate-tarballs-20260610060805/*.tgz
  docs/wip/debugging/2026-06-09-openclaw-1password-recovery-handoff.md
  docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh
  docs/wip/communications/2026-06-10-remote-1password-openclaw-proof-request.md
  docs/wip/communications/2026-06-10-agent-vm-crash-pr-release-readiness.md
```

Packed-content audit on this bundle:

```text
@agent-vm/secret-management dist includes:
  OP_BIOMETRIC_UNLOCK_ENABLED=false
  OP_CACHE=false
  isolated OP_CONFIG_DIR
  opEnvIsolation=enabled
  output=redacted
  <1password-ref>

@agent-vm/agent-vm dist includes:
  Waiting for service health
  processSpec.serviceHealthCheck ?? processSpec.healthCheck
  Gateway service health check failed
  recovery-runner log redaction

@agent-vm/openclaw-gateway dist includes:
  healthCheck.path=/readyz
  serviceHealthCheck.path=/health
  configured 1Password refs redacted as <1password-ref>
```

Before publishing, test this candidate by copying that directory to the remote
deployment host. From the deployment root, install every tarball together so
pnpm does not try to resolve unpublished `0.0.94` sibling packages from npm:

```sh
tar -xzf /path/to/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz
BUNDLE=tmp/agent-vm-0.0.94-candidate-tarballs-20260610060805
pnpm add --force "$BUNDLE"/*.tgz
pnpm exec agent-vm --version
```

If copying only the tarball directory instead of the proof bundle, point
`BUNDLE` at the copied directory:

```sh
BUNDLE=/path/to/agent-vm-0.0.94-candidate-tarballs-20260610060805
```

If the deployment has OpenClaw gateway or Tool VM overlay tarball helpers, run
the deployment's normal local-tarball sync step after `pnpm add` and before
`agent-vm build`.

`2026.6.5` is the current OpenClaw npm line checked during this investigation.
It matters for this incident class because it is the current line and its
changelog includes adjacent channel/runtime fixes, including Discord runtime
adapters staying resolvable and outbound delivery retries surviving budget
deferrals. The changelog does not prove a direct fix for Discord `403` /
websocket `1006`.

## Current Model

### 1Password lane

Service-account auth is meant to be headless. With the patched package, the
SDK remains the primary resolver. If the SDK fails, the `op` CLI fallback runs
with only a service-account token plus process plumbing:

- `OP_SERVICE_ACCOUNT_TOKEN=<resolved service-account token>`
- `OP_BIOMETRIC_UNLOCK_ENABLED=false`
- `OP_CACHE=false`
- fresh isolated `OP_CONFIG_DIR`
- no ambient `OP_CONNECT_*`
- no ambient `OP_SESSION*`
- no ambient `OP_ACCOUNT`
- no user config/cache/data env forwarded

Failure output is redacted. It should keep safe metadata like exit code, signal,
elapsed time, timeout/killed status, and auth isolation facts. It must not log
stdout, stderr, stdin, token values, or resolved secrets.

External reference check:

- 1Password CLI docs say `OP_SERVICE_ACCOUNT_TOKEN` configures service-account
  auth, and list `op read` / `op inject` as supported service-account commands.
- 1Password CLI docs say `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` take
  precedence over `OP_SERVICE_ACCOUNT_TOKEN`; the patched fallback does not
  forward them.
- 1Password SDK docs describe desktop app auth and service-account auth as
  separate modes. The JavaScript example for service-account auth is
  `createClient({ auth: process.env.OP_SERVICE_ACCOUNT_TOKEN, ... })`, matching
  agent-vm's SDK path.
- DeepWiki source analysis for `1Password/onepassword-sdk-js` confirmed that a
  string `auth` value maps to service-account auth and does not enter a
  `DesktopAuth` path.

`tokenSource.type = "op-cli"` was intentionally different: it resolved the
service-account token itself by using the operator's configured `op` auth path.
That keeps a desktop/session dependency alive before service-account auth
exists, so this branch now rejects `op-cli` token bootstrap. Unattended
controllers must use `tokenSource.type = "env"` or `tokenSource.type =
"keychain"`.

### OpenClaw lane

OpenClaw has two health meanings:

- `/health` means the gateway service process is alive.
- `/readyz` means the service is ready for traffic, including provider/channel
  readiness.

OpenClaw also has three heartbeat or health-cadence meanings that must not be
collapsed:

- agent heartbeat turns: scheduled model runs in lanes such as
  `agent:<agentId>:main:heartbeat`
- channel health monitor: OpenClaw's channel-health loop, defaulting to a
  5-minute check cadence with a 30-minute stale-event threshold
- Discord gateway websocket frames / heartbeat ACKs: protocol-level transport
  liveness that update channel `lastTransportActivityAt`

Agent-vm periodic service liveness for OpenClaw should use `/health`.
Gateway startup/replacement should also wait on `/health`, not `/readyz`.
`/readyz` remains the readiness/operator signal after the service is live.
Destructive VM recovery must not be driven by readiness-only Discord/provider
flaps by default. `unhealthy-recoverable` channel-provider events degrade
readiness/status unless `restartGatewayOnRecoverable` is explicitly enabled.

Source-level OpenClaw behavior checked against the local `openclaw` source and
the installed `openclaw@2026.6.5` package:

- `/health` and `/healthz` are liveness probe paths; `/ready` and `/readyz` are
  readiness probe paths.
- readiness evaluates channel runtime health through `evaluateChannelHealth`.
- readiness ignores `stale-socket`, but fails on disconnected, not-running, and
  stuck channel accounts.
- `/health` and `/healthz` return `200` with `{ ok: true, status: "live" }`
  without channel readiness evaluation.
- Discord `Gateway websocket opened` still pushes `connected: false` until the
  gateway reaches READY; READY pushes `connected: true`.
- Discord `Gateway websocket closed: 1006` pushes `connected: false` and records
  the close code in `lastDisconnect.status`.
- Discord websocket frames update `lastTransportActivityAt`. This is transport
  liveness, not proof that an agent heartbeat lane ran.
- Discord REST/API `401`, `403`, and `429` responses are tracked as invalid
  requests. A non-transient Discord `/gateway/bot` `403` fails gateway metadata
  lookup; websocket handshake/transport errors can also carry a `statusCode`.
- The bundled OpenClaw channel health monitor defaults to a 5-minute check
  interval, 30-minute stale-event threshold, and 10 channel restarts per hour.
  That monitor restarts the channel provider, not the whole gateway VM.

Source-level heartbeat/crash read:

- Agent main heartbeats are scheduled model turns. The heartbeat runner catches
  run failures and records failed heartbeat events; the inspected heartbeat
  runner, wake queue, gateway subscription, Discord provider, channel manager,
  and probe paths do not expose a direct process-exit path.
- Before a heartbeat delivers to a channel, the runner calls the channel
  plugin's `heartbeat.checkReady` hook when present. If Discord is already not
  ready, heartbeat delivery is skipped and logged as channel-not-ready rather
  than forcing a VM exit.
- Heartbeat can still add workload: model execution, queue pressure, Discord
  typing REST calls, and outbound delivery. Treat it as possible load/correlation
  unless logs prove it is the first failing lane.
- Discord websocket `1006` is not classified as a fatal gateway close code in
  the inspected runtime; it schedules reconnect. During reconnect, channel
  status is `connected: false`, so `/readyz` can fail while `/health` stays live.
- Discord `/gateway/bot` `403` is not transient in the inspected runtime. It
  fails gateway metadata lookup instead of falling back to the default Discord
  gateway URL.

## Remote Proof Checklist

Run these probes on the remote machine with the patched package installed.
Keep 1Password desktop locked for the first 1Password pass.

Preferred capture harness:

```sh
zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh \
  config/system.jsonc \
  sunfam
```

The harness writes raw command output under `tmp/agent-vm-remote-proof-*` and
prints only the share-safe summary path. Share `share-safe-summary.txt` first.
Do not share raw `*.txt` files if the harness produced a sibling
`*.leak-scan.txt` file with matches.

To include the runtime secret refresh proof, opt in explicitly:

```sh
AGENT_VM_PROOF_RUN_REFRESH=1 \
  zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh \
    config/system.jsonc \
    sunfam
```

If the ingress port is not `18791`, set `AGENT_VM_PROOF_INGRESS_URL`:

```sh
AGENT_VM_PROOF_INGRESS_URL=http://127.0.0.1:18791 \
  zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh \
    config/system.jsonc \
    sunfam
```

### 1Password locked-desktop proof

Confirm the package under test:

```sh
pnpm exec agent-vm --version
node -e 'console.log(require("./node_modules/@agent-vm/agent-vm/package.json").version)'
```

Confirm the controller config uses a headless token source:

```sh
pnpm exec agent-vm validate --config config/system.jsonc
```

Run doctor while the 1Password desktop app is locked:

```sh
mkdir -p tmp/agent-vm-locked-1p-proof
pnpm exec agent-vm doctor --config config/system.jsonc --show-passed \
  > tmp/agent-vm-locked-1p-proof/doctor.txt 2>&1
rg -n '1password-op-cli-headless|tokenSource|opEnvIsolation|opAuth=|opConfig=|opBiometricUnlock=|opCache=|opConnectEnv=|opSessionEnv=|opAccountEnv=|secret-resolution-failed|failed|passed' \
  tmp/agent-vm-locked-1p-proof/doctor.txt
```

Expected:

- `1password-op-cli-headless` passes for `env` or `keychain` token sources.
- Config validation rejects `tokenSource.type: "op-cli"` before controller
  startup or recovery.
- If it fails, the hint must include redacted metadata only.
- The output must not contain `OP_SERVICE_ACCOUNT_TOKEN=<real value>`.
- The output must not contain resolved `op://` secret values.

Before sharing any captured file, run a basic leak scan and inspect matches
locally. Do not paste the full file if this finds anything sensitive:

```sh
rg -n 'OP_SERVICE_ACCOUNT_TOKEN=|Bearer [A-Za-z0-9._-]+|op://|stdout=.*[A-Za-z0-9._-]{20,}|stderr=.*[A-Za-z0-9._-]{20,}' \
  tmp/agent-vm-locked-1p-proof/doctor.txt || true
```

For the `keychain` token-source deployment, also run one ambient-OP poison
probe while the 1Password desktop app is locked. This proves the resolver is
not accidentally reading desktop/session/Connect config from the parent env:

```sh
env \
  OP_CONNECT_HOST=https://connect.invalid.example \
  OP_CONNECT_TOKEN=ambient-connect-token \
  OP_SESSION=ambient-session-token \
  OP_ACCOUNT=ambient-account \
  OP_CONFIG_DIR=/tmp/ambient-human-op-config \
  OP_CACHE=true \
  OP_BIOMETRIC_UNLOCK_ENABLED=true \
  pnpm exec agent-vm doctor --config config/system.jsonc --show-passed \
    > tmp/agent-vm-locked-1p-proof/doctor-poisoned-env.txt 2>&1
rg -n '1password-op-cli-headless|opEnvIsolation|opAuth=|opConfig=|opBiometricUnlock=|opCache=|opConnectEnv=|opSessionEnv=|opAccountEnv=|failed|passed' \
  tmp/agent-vm-locked-1p-proof/doctor-poisoned-env.txt
```

Expected poisoned-env metadata:

```text
opEnvIsolation=enabled
opAuth=service-account-token
opConfig=isolated
opBiometricUnlock=false
opCache=false
opConnectEnv=absent
opSessionEnv=absent
opAccountEnv=absent
```

Exercise the exact gateway-zone secret resolution path while the app is locked
without contacting the controller or restarting the gateway:

```sh
pnpm exec agent-vm controller credentials check --config config/system.jsonc --zone sunfam \
  > tmp/agent-vm-locked-1p-proof/credentials-check.txt 2>&1
rg -n 'resolvedSecretCount|secret-resolution-failed|opEnvIsolation|opAuth=|opConfig=|opBiometricUnlock=|opCache=|opConnectEnv=|opSessionEnv=|opAccountEnv=' \
  tmp/agent-vm-locked-1p-proof/credentials-check.txt || true
```

Expected:

- check returns JSON success for `sunfam`
- no `secret-resolution-failed`
- no raw `stdout` / `stderr` content from `op`

If the controller is running and a restart is acceptable, exercise runtime
refresh while the app is locked:

```sh
pnpm exec agent-vm controller credentials refresh --config config/system.jsonc --zone sunfam \
  > tmp/agent-vm-locked-1p-proof/credentials-refresh.txt 2>&1
rg -n 'operationId|operation-finished|operation-failed|secret-resolution-failed|opEnvIsolation|opAuth=|opConfig=|opBiometricUnlock=|opCache=|opConnectEnv=|opSessionEnv=|opAccountEnv=' \
  tmp/agent-vm-locked-1p-proof/credentials-refresh.txt || true
```

Expected:

- refresh returns JSON success for `sunfam`
- no `secret-resolution-failed`
- no `opEnvIsolation=disabled`
- no raw `stdout` / `stderr` content from `op`

If refresh fails, capture only redacted error lines and these facts:

```text
op version
agent-vm version
tokenSource.type
doctor check name/status/hint
credentials-refresh operationId
redacted fallback metadata
```

Do not paste token values, generated auth profile files, or resolved config.

If a stale or running gateway runtime record exists, also test locked-desktop
controller start with the patched package. Expected ordering:

```text
Preflighting gateway runtime ownership
Preflighting gateway start
Resolving zone secrets / MCP Portal preflight / lifecycle preflight
Building gateway image
Cleaning orphaned tool VMs
Cleaning orphaned gateway runtime
Preparing host state
Booting gateway VM
Waiting for service health
```

If 1Password secret resolution fails during `Preflighting gateway start`, there
must be no `vm-close-started`, no `runtime-record-deleted`, and no orphan Tool
VM or gateway cleanup for that zone.

If final host-state preparation fails after cleanup, startup must abort before
`Booting gateway VM`. This avoids creating a replacement VM that then has to be
closed on a host-state write failure.

### 1Password fallback isolation proof

If you need a direct CLI proof without printing secrets, use only commands that
discard secret output:

```sh
TOKEN="$(security find-generic-password -s agent-vm -a shravan-claw-1p-service-account -w)"
OP_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-vm-op-config.XXXXXX")"
cleanup_op_config_dir() {
  find "$OP_CONFIG_DIR" -depth -type f -exec unlink {} \; 2>/dev/null || true
  find "$OP_CONFIG_DIR" -depth -type l -exec unlink {} \; 2>/dev/null || true
  find "$OP_CONFIG_DIR" -depth -type d -exec rmdir {} \; 2>/dev/null || true
  unset TOKEN OP_CONFIG_DIR
}
trap cleanup_op_config_dir EXIT
env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  TMPDIR="${TMPDIR:-/tmp}" \
  OP_SERVICE_ACCOUNT_TOKEN="$TOKEN" \
  OP_BIOMETRIC_UNLOCK_ENABLED=false \
  OP_CACHE=false \
  OP_CONFIG_DIR="$OP_CONFIG_DIR" \
  op whoami
env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  TMPDIR="${TMPDIR:-/tmp}" \
  OP_SERVICE_ACCOUNT_TOKEN="$TOKEN" \
  OP_BIOMETRIC_UNLOCK_ENABLED=false \
  OP_CACHE=false \
  OP_CONFIG_DIR="$OP_CONFIG_DIR" \
  op read 'op://agent-vm/sunfam-gateway-auth/password' >/dev/null
env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  TMPDIR="${TMPDIR:-/tmp}" \
  OP_SERVICE_ACCOUNT_TOKEN="$TOKEN" \
  OP_BIOMETRIC_UNLOCK_ENABLED=false \
  OP_CACHE=false \
  OP_CONFIG_DIR="$OP_CONFIG_DIR" \
  op inject --in-file config/gateways/sunfam/mcp.config.jsonc >/dev/null
unset TOKEN
```

Expected:

- `op whoami` reports `User Type: SERVICE_ACCOUNT`
- `op read` exits 0
- `op inject` exits 0
- `OP_CONNECT_*`, `OP_SESSION*`, and `OP_ACCOUNT` are not present in the
  `op` child environment

This proves the service account can access the target refs. The stronger
non-destructive agent-vm proof is `agent-vm doctor` plus
`controller credentials check`, because those exercise the same local resolver
plumbing as gateway startup and recovery. `controller credentials refresh` is an
additional opt-in proof because it restarts the zone runtime.

### 1Password repository e2e proof

The repo has a live 1Password proof lane, but it is deliberately test-vault
only. It must not be pointed at deployment vaults.

Required env:

```sh
export AGENT_VM_TEST_OP_SERVICE_ACCOUNT_TOKEN='...' # test-only service account
export AGENT_VM_TEST_OP_REFS='op://agent-vm-testing/item/password'
export AGENT_VM_TEST_OP_VAULT_PREFIX='op://agent-vm-testing/'
pnpm test:e2e:secrets
```

Expected:

- `e2e-secrets` passes.
- The first test proves SDK-failure fallback resolves live refs through one
  isolated `op inject` batch.
- The live `op inject` child is recorded while ambient `OP_CONNECT_*`,
  `OP_SESSION*`, `OP_ACCOUNT`, `OP_CONFIG_DIR`, `OP_CACHE`,
  `OP_BIOMETRIC_UNLOCK_ENABLED`, and ambient `OP_SERVICE_ACCOUNT_TOKEN` are
  poisoned; the child must still use the intended service-account token,
  `OP_BIOMETRIC_UNLOCK_ENABLED=false`, `OP_CACHE=false`, and a fresh isolated
  `OP_CONFIG_DIR`.
- The second test proves SDK failure plus `op inject` failure stops there; no
  serial `op read` fallback is attempted.

Local status on this checkout:

```text
pnpm test:e2e:secrets
  failed before auth because AGENT_VM_TEST_OP_REFS is not set
```

That is an environment blocker for local live 1Password proof, not a code-path
failure. Keep it this way unless using refs under the test vault prefix.

## OpenClaw Failure Proof

When Discord starts `403` / `1006` again, capture state before any manual
restart:

```sh
pnpm exec agent-vm controller status --config config/system.jsonc
pnpm exec agent-vm controller health --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller service-health --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller health-snapshot --config config/system.jsonc --zone sunfam
curl -sS http://127.0.0.1:18791/health
curl -sS -i http://127.0.0.1:18791/readyz
```

Expected patched behavior during a provider/readiness flap:

- QEMU gateway PID stays alive.
- `vmId` stays stable.
- `/health` stays 200 when the service process is alive.
- `/readyz` may return 503 while Discord/provider readiness is red.
- `agent-channel-provider-health` may report `unhealthy-recoverable`.
- There is no `gateway-vm-restart` recovery event unless policy explicitly
  enables `restartGatewayOnRecoverable`.

Collect the nearest logs around the first provider failure:

```text
first Discord gateway error: 403
first Discord websocket closed: 1006
first /readyz 503
nearest /health result
nearest gateway-control-link result
nearest agent-channel-provider-health event
nearest gateway-recovery event, if any
current vmId and hostPid before/after the flap
```

The decisive distinction:

```text
/health 200 + /readyz 503 + stable vmId
  => OpenClaw is alive but not ready. Agent-vm should observe/degrade, not replace.

/health failing repeatedly + control link failing/stale
  => service/VM liveness is actually broken. Recovery can be legitimate.
```

## Heartbeat Question

Do not treat every `intervalMs=1800000` line as an agent heartbeat. In OpenClaw
logs it may be a scheduled agent heartbeat, diagnostic/stability cadence, or
protocol/channel transport cadence. The channel health monitor defaults to 5
minutes, while its stale-event threshold defaults to 30 minutes. For
agent-heartbeat causality, find the actual session lane:

```text
agent:<agentId>:main:heartbeat
```

For each suspected outage, capture:

```text
first model 401 token_invalidated line
session lane for that 401
first agent main heartbeat line after boot
first Discord 403 / 1006 line
first /readyz 503 line
first gateway recovery request line
```

Evidence needed to prove heartbeat causality:

- the failing session lane is `agent:*:main:heartbeat`
- the heartbeat starts before the Discord/provider failure
- no earlier cron/direct session already showed the same model/auth failure
- Discord/provider readiness goes red after that heartbeat
- the Discord failure is not already explained by gateway transport state:
  `connected=false`, `runtime-not-ready`, `startup-not-ready`, or reconnect
  exhaustion

If the first 401 is `agent:*:cron:*` or `agent:*:direct:*`, heartbeat is
correlated workload, not the first proven trigger.

Current best read from the available logs:

- Model auth degradation appeared first in cron/direct lanes, not only
  heartbeats.
- Discord `403` / websocket `1006` is the proximate readiness failure.
- Heartbeats can expose or add load to an already degraded model/channel system,
  but the available evidence does not prove an agent heartbeat caused Discord to
  fail.
- Upgrading the managed OpenClaw line to `2026.6.5` is still appropriate because
  it is the latest checked line and includes adjacent channel/runtime fixes. It
  is not, by itself, proof that Discord `403` / websocket `1006` is fixed.
- The inspected `2026.6.5` heartbeat, Discord reconnect, channel-health, and
  readiness landmarks show why the agent-vm fix must not depend on OpenClaw
  latest alone to avoid destructive VM replacement during channel readiness
  flaps.

## What This Package Should Prove

1. A locked desktop 1Password app should not block `env` or `keychain`
   service-account deployments.
2. If the SDK fails transiently, the `op` fallback should stay service-account
   isolated and headless.
3. If fallback still fails, logs should show safe failure class metadata without
   leaking secret output.
4. Running-gateway recovery should preflight replacement secrets, host state,
   and image availability before closing the old VM.
5. Controller start/cold-start should preflight replacement secrets, host state,
   and image availability before orphan Tool VM or gateway cleanup.
6. OpenClaw readiness-only/provider flaps should not kill the gateway VM by
   default.

## Remaining Open Questions

- The exact first cause of Discord `403` / websocket `1006` is still outside
  agent-vm. Capture OpenClaw/Gondolin/provider telemetry before claiming root
  cause.
- The exact old 1Password failure cause cannot be proven from old redacted logs.
  The patched package is designed to turn the next failure into safe actionable
  metadata.
