# 2026-06-18 OpenClaw Gateway Crash Recovery

## Summary

Sunclaw `shravan-claw` showed repeated OpenClaw gateway hard crashes on
OpenClaw `2026.5.20`, Node `24.x`, and `undici@8.3.0`.

The direct fatal signature in the available `shravan-claw` evidence is an
OpenClaw gateway Node process assertion:

```text
AssertionError [ERR_ASSERTION]: assert(!this.paused)
at undici/lib/dispatcher/client-h1.js:374
```

The controller and QEMU host runtime stayed alive. The OpenClaw gateway service
process died. Tool VM heartbeat and SSH symptoms were adjacent control-plane
degradation after the gateway failure, not the first fatal event in the
available evidence.

The recovery change is deliberately two-layered:

1. Move managed OpenClaw from `2026.5.20` to current stable `2026.6.8` and align
   the managed Codex CLI to `@openai/codex@0.139.0`.
2. Wrap `openclaw gateway --port 18789` in a tiny in-VM supervisor loop so an
   OpenClaw child-process crash is logged and restarted inside the gateway VM
   instead of leaving the VM up but the service permanently dead.

The update is worth doing, but it is not by itself a proven direct fix for the
specific `undici@8.3.0` assertion: `openclaw@2026.6.8` still depends on
`undici@8.3.0`, and the Discord package still bundles that version. The
supervisor is the containment layer for the exact crash class.

## Evidence Loaded

- `shravan-claw` was fast-forwarded to `f470353`:
  `docs: update sunfam gateway crash evidence`.
- Source debug doc:
  `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/wip/debugging/2026-06-17-sunfam-agent-stop-and-toolvm-failures.md`
- Earlier matching crash doc:
  `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/wip/debugging/2026-05-27-sunfam-gateway-undici-assert-crash.md`
- Sunclaw LAN share `/Users/shravansunder/Documents/dev/!logs` was not mounted
  in this local environment during this run. `/Volumes` did not expose the
  Sunclaw share. The investigation therefore used the checked-in `shravan-claw`
  evidence docs plus current npm/package research.
- Current npm evidence on 2026-06-18 showed:
  - `openclaw@latest` = `2026.6.8`
  - `@openclaw/codex@latest` = `2026.6.8`
  - `@openclaw/discord@latest` = `2026.6.8`
  - `@openclaw/diagnostics-otel@latest` = `2026.6.8`
  - `openclaw@2026.6.8` still depends on `undici@8.3.0`
  - `@openclaw/codex@2026.6.8` depends on `@openai/codex@0.139.0`

## OpenClaw 2026.5.20 To 2026.6.8 Ledger

This is a reconstructed operator-focused ledger from npm metadata, package
tarballs, upstream changelog excerpts, and repository release metadata.

| Version | Agent-vm-relevant changes |
| --- | --- |
| `2026.5.20` | Baseline from Sunclaw crash evidence. Bundled Codex harness at `@openai/codex@0.132.0`; OpenClaw dependencies include `undici@8.3.0`, `@openclaw/fs-safe@0.2.7`, `@openclaw/proxyline@0.3.3`; gateway process is vulnerable to fatal Node process exits leaving the VM alive but service dead. |
| `2026.5.22` | No decisive dependency delta found in this run; release detail was thin relative to later stable tags. |
| `2026.5.26` | Larger reliability and config train. Diagnostics/OTel and gateway/reply paths improve; `@openclaw/fs-safe` moves to `0.3.0`; `ws` moves to `8.21.0`; `openai` moves to `6.39.x`; `@openclaw/codex` uses `@openai/codex@0.134.0`. |
| `2026.5.27` | More Codex app-server recovery, provider/model coverage, and plugin/package boundary fixes. |
| `2026.5.28` | Adds Anthropic SDK and more model/media/package surface work; beta notes include heartbeat timeout, Discord reply typing lifecycle, channel reload/reconnect, and benign WebSocket pre-handshake close classification. |
| `2026.6.1` | Resilient agent/Codex run handling, Discord state/typing/session recovery across restart and transport paths, provider dependency refreshes, and `@openai/codex@0.135.0` via `@openclaw/codex`. |
| `2026.6.5` | MCP result normalization before provider conversion, Anthropic thinking recovery, model/provider resolution fixes, restart/upgrade fixes, channel reconnect behavior, and heartbeat metadata forwarding. |
| `2026.6.6` | `@openclaw/codex` moves to `@openai/codex@0.139.0`; additional channel/security tightening. |
| `2026.6.8` | Current stable observed on 2026-06-18. Safer model routing, normalized provider IDs, managed SecretRef auth, bounded model browsing, OpenAI/Anthropic tool-schema recovery, heartbeat event de-dupe, channel delivery fixes, and plugin/update repair including omitted Codex platform binaries. Still uses `undici@8.3.0`. |

## Agent-vm Changes Made

### Managed OpenClaw Line

Updated `packages/agent-vm/managed-images.json`:

```json
{
  "openClawVersion": "2026.6.8",
  "openAiCodexCliVersion": "0.139.0"
}
```

Updated live docs, doctor hints, manual templates, and
`@agent-vm/openclaw-mcp-portal-plugin` dev dependency from `2026.6.5` to
`2026.6.8`. Historical `docs/wip/**` evidence docs were intentionally left as
records.

### Gateway Process Supervision

Changed the OpenClaw gateway process spec from a one-shot background process:

```text
nohup /usr/local/bin/openclaw gateway --port 18789 ...
```

to a shell-supervised child loop:

```text
nohup sh -c 'attempt=0; while true; do attempt=$((attempt + 1)); ...; /usr/local/bin/openclaw gateway --port 18789; exit_code=$?; ...; sleep 5; done'
```

The boot log now records:

```text
gateway-supervisor: starting openclaw gateway attempt=1 at=...
gateway-supervisor: openclaw gateway exited attempt=... exit_code=... at=...
```

on child process restarts. This keeps the existing controller/gateway boundary
intact while containing hard child-process exits such as the observed undici
assertion.

## Red/Green Proof

### Red Phase

After updating tests first:

- Unit release test failed because `resolveManagedImageRelease()` still returned
  `2026.5.20`.
- Integration orchestrator test failed because the VM exec command still used
  one-shot `nohup /usr/local/bin/openclaw gateway --port 18789`.
- Host e2e lifecycle test failed on the same one-shot command shape.

### Green Phase

Commands run from
`/Users/shravansunder/Documents/dev/project-dev/agent-vm.fix-openclaw-crashes`:

```text
pnpm vitest run --config vitest.config.ts --project unit \
  packages/agent-vm/src/build/managed-image-release.unit.test.ts \
  packages/agent-vm/src/operations/doctor.unit.test.ts
```

Result: 2 files, 34 tests passed.

```text
pnpm vitest run --config vitest.config.ts --project integration \
  packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts \
  packages/agent-vm/src/cli/build-command.integration.test.ts
```

Result: 2 files, 93 tests passed.

```text
pnpm test:e2e:host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
```

Result: 1 file, 48 tests passed, 0 skipped, 0 todo.

```text
pnpm check
```

Result: 6 gates passed, 0 failed:
package-version sync, zod guard, taxonomy, format, type-aware lint, typecheck.
Oxlint reported warnings only.

```text
pnpm test:e2e:inventory
```

Result: 1 passed, 15 files skipped; inventory only, not live VM proof.

## Beta Proof

Deployment:
`/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`

Beta was updated to:

- `@agent-vm/agent-vm` local tarball from this worktree:
  `file:../agent-vm.fix-openclaw-crashes/tmp/beta-tarballs-badc2867/agent-vm-agent-vm-0.0.102.tgz`
- host validation OpenClaw packages:
  `openclaw@2026.6.8`, `@openclaw/codex@2026.6.8`,
  `@openclaw/discord@2026.6.8`
- gateway overlay runtime package overrides:
  `openclaw@2026.6.8`, `@openclaw/codex@2026.6.8`,
  `@openclaw/discord@2026.6.8`
- local overlay tarballs refreshed to `0.0.102-badc2867`

Proof commands:

```text
pnpm exec openclaw --version
```

Result: `OpenClaw 2026.6.8 (844f405)`.

```text
node -e "const pkg=require('./node_modules/@agent-vm/agent-vm/package.json'); const managed=require('./node_modules/@agent-vm/agent-vm/managed-images.json'); console.log(pkg.version); console.log(managed.openClawVersion); console.log(managed.openAiCodexCliVersion);"
```

Result:

```text
0.0.102
2026.6.8
0.139.0
```

```text
mise exec -- pnpm run doctor
```

Result: 54 passed, 0 failed.

```text
mise exec -- pnpm validate
```

Result: `ok: true`, all config checks passed.

```text
mise exec -- pnpm build
```

Result: built `agent-vm-gateway:latest` and `agent-vm-tool:latest`, converted
gateway/tool Gondolin images, cache auto-prune completed, observability stack
healthy. The generated plan printed OpenClaw runtime packages at `2026.6.8`.

```text
mise exec -- pnpm start
```

Run escalated for host process inspection and QEMU/Gondolin access. Result:

```json
{
  "controllerPort": 18900,
  "ingress": {
    "host": "127.0.0.1",
    "port": 18891,
    "url": "http://127.0.0.1:18891"
  },
  "vmId": "0232330c-7991-494d-9269-71b21d24bbc1",
  "zoneId": "beta"
}
```

Runtime probes while foreground controller was alive:

```text
agent-vm controller status --config config/system.jsonc
```

Result: beta `lifecycleState: running`, `readiness: running`,
`gatewayInfrastructure: running`, ingress `127.0.0.1:18891`.

```text
agent-vm controller health --config config/system.jsonc --zone beta
```

Result: `ok: true`, `/readyz`, HTTP 200.

```text
agent-vm controller service-health --config config/system.jsonc --zone beta
```

Result: `ok: true`, `/health`, HTTP 200.

```text
curl -sS -i http://127.0.0.1:18891/readyz
```

Result: HTTP 200, `{"ready":true}`.

Mounted boot log:

```text
/Users/shravansunder/.agent-vm/runtime/zones/beta/logs/gateway-boot-latest.log
```

confirmed:

```text
gateway-boot: NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection
gateway-supervisor: starting openclaw gateway attempt=1 at=2026-06-18T13:54:41Z
...
[gateway] http server listening (... diagnostics-otel, discord, gondolin, mcp-portal ...)
[gateway] ready
[discord] Discord bot probe resolved @pulse-beta
```

The foreground beta controller was stopped after proof because `agent-vm
controller start` has no daemon mode. Final cleanup:

```text
mise exec -- pnpm force-stop
```

Result: stale runtime record removed, no gateway or Tool VM pids killed.

## Residual Risks

- This does not prove the upstream undici assertion is gone. OpenClaw latest
  still contains `undici@8.3.0`.
- The fix should be treated as reduced trigger surface plus crash containment.
  A longer Sunclaw/Discord burn-in is still the right production confidence
  step.
- The Sunclaw LAN evidence bundle was not mounted locally during this run, so
  raw evidence from `/Users/shravansunder/Documents/dev/!logs` was not directly
  re-read here.
- Beta has an untracked `.pnpm-store/` directory from the noninteractive pnpm
  install. It was not deleted because this run did not have explicit permission
  to remove directories.
