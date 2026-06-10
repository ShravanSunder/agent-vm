# 2026-06-10 Remote 1Password and OpenClaw Proof Request

Send this to the agent on the remote deployment machine.

## Goal

Prove two things with the `@agent-vm/*` `0.0.94` candidate:

1. A locked 1Password desktop app does not block service-account secret
   resolution.
2. OpenClaw Discord/provider readiness flaps do not drive gateway VM replacement
   when `/health` is still live.

Do not print tokens, resolved secrets, generated auth profiles, or raw
1Password stdout/stderr into chat.

## Candidate Bundle

Use this proof bundle:

```text
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz
tmp/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz.sha256
sha256: fabe3cdd0804f6bfefa60770c00d41a6b1d38a9777f52c1f13f3b8cf3a88963f
```

Use the sidecar `.sha256` file as authoritative. Do not trust an old checksum
pasted in chat after the bundle has been refreshed.

Install all package tarballs together from the deployment root:

```sh
tar -xzf /path/to/agent-vm-0.0.94-remote-proof-bundle-20260610061145.tar.gz
BUNDLE=tmp/agent-vm-0.0.94-candidate-tarballs-20260610060805
pnpm add --force "$BUNDLE"/*.tgz
pnpm exec agent-vm --version
```

Expected installed package version:

```text
0.0.94
```

## Locked 1Password Pass

Keep the 1Password desktop app locked for this pass.

Run the proof harness from the deployment root:

```sh
zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh \
  config/system.jsonc \
  sunfam
```

If the controller is running and runtime secret refresh is safe to exercise,
also run:

```sh
AGENT_VM_PROOF_RUN_REFRESH=1 \
  zsh docs/wip/debugging/2026-06-10-remote-openclaw-1password-proof.zsh \
    config/system.jsonc \
    sunfam
```

If ingress is not `http://127.0.0.1:18791`, set:

```sh
AGENT_VM_PROOF_INGRESS_URL=http://127.0.0.1:<port>
```

Share only:

```text
tmp/agent-vm-remote-proof-*/share-safe-summary.txt
```

Do not share raw `*.txt` files if any sibling `*.leak-scan.txt` file contains
matches. First summarize the leak-scan filenames and match classes without
copying the matched secret material.

Required success signals:

```text
installed-agent-vm-version=0.0.94
proof-check:validate=passed exit=0
proof-check:doctor-locked-desktop=passed exit=0
proof-check:doctor-locked-desktop-poisoned-env=passed exit=0
proof-check:credentials-check-locked-desktop=passed exit=0
proof-check:leak-scan-matches=none
1password-op-cli-headless passed
resolvedSecretCount
opEnvIsolation=enabled
opAuth=service-account-token
opConfig=isolated
opBiometricUnlock=false
opCache=false
opConnectEnv=absent
opSessionEnv=absent
opAccountEnv=absent
```

Failure signals to report, redacted:

```text
secret-resolution-failed
opEnvIsolation=disabled
opAuth=missing
opConnectEnv=present
opSessionEnv=present
opAccountEnv=present
output=redacted with exit/signal/elapsed metadata
```

## OpenClaw Readiness/Liveness Pass

When Discord `403` / websocket `1006` appears, capture these facts:

```sh
pnpm exec agent-vm controller status --config config/system.jsonc
pnpm exec agent-vm controller health --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller service-health --config config/system.jsonc --zone sunfam
pnpm exec agent-vm controller health-snapshot --config config/system.jsonc --zone sunfam
curl -sS -i http://127.0.0.1:18791/health
curl -sS -i http://127.0.0.1:18791/readyz
```

Required classification:

```text
/health 200 + /readyz 503 + stable vmId
  => readiness/provider flap; patched agent-vm should not replace VM.

/health failing repeatedly + control link failing/stale
  => service liveness failure; gateway VM recovery may be legitimate.
```

Report:

```text
first Discord 403 line timestamp
first websocket 1006 line timestamp
first /readyz 503 timestamp
nearest /health result
vmId before and after
qemu host PID before and after
whether gateway-runtime.json stayed present
whether agent-vm logged auto-restarting gateway VM
```

## Heartbeat Causality Pass

Do not treat every `intervalMs=1800000` line as an agent heartbeat. Prove the
lane.

Report:

```text
first model 401 token_invalidated timestamp
session lane for first 401
first agent:*:main:heartbeat line after boot
first Discord 403 / websocket 1006 line
first /readyz 503 line
first agent-vm recovery request line
```

Heartbeat is causal only if the first failing lane is
`agent:*:main:heartbeat`, starts before Discord/provider failure, and no earlier
cron/direct lane already showed the same model/auth failure.
