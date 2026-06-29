# 2026-06-29 - sunfam heartbeat lease control-plane research log

Status: companion appendix for `2026-06-29-sunfam-heartbeat-lease-control-plane-flapping.md`.
Purpose: preserve command evidence, code anchors, and next-agent research notes.
Privacy: raw command payloads that may contain credentials are kept redacted/omitted as emitted by OpenClaw.
Last updated: 2026-06-29T16:23:58Z / 2026-06-29T12:23:58-0400.

Imported target: upstream `agent-vm` repo.
Runtime source: `shravan-claw` deployment evidence captured on 2026-06-29.
Purpose in this repo: handoff evidence for upstream lease/control-link observability and reliability work.
Note: runtime stack traces reference installed `@agent-vm/*@0.0.108` package paths from the deployment; map them to source packages before changing code.

## Files to read first

- Narrative doc: `docs/wip/2026-06-29-sunfam-heartbeat-lease-control-plane-flapping.md`
- Prior related doc: `docs/wip/debugging/2026-06-17-sunfam-agent-stop-and-toolvm-failures.md`
- Manual: `docs/manual/operations.md`
- Manual: `docs/manual/tool-vm-leases.md`
- Manual: `docs/manual/observability.md`

## Exact latest failure slice

Source: `~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-29.log`.

Window: `2026-06-29T15:20:00Z..2026-06-29T16:23:58Z`.

Relevant OpenClaw rows:

```text
2026-06-29T15:26:04.123Z  openclaw-2026-06-29.log:2613
session turn created: runId=fcb7c3b4-ed07-4003-85fe-7340d3cca897 sessionId=fada8b2d-c2ba-49a9-ac31-74c9ccb51e06 sessionKey=agent:shravan:main:heartbeat agentId=shravan channel=discord trigger=heartbeat

2026-06-29T15:26:11.704Z  openclaw-2026-06-29.log:2638
embedded run tool start: runId=fcb7c3b4-ed07-4003-85fe-7340d3cca897 tool=read toolCallId=call_NLaytoWJv4xDwuNfFraXjQTy|fc_0c635ce49bd28387016a428e932a188196a6930b229ab699cc

2026-06-29T15:27:12.525Z  openclaw-2026-06-29.log:2644
tools: read failed stack:
Error: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms
    at fetchWithTimeout (.../@agent-vm/gateway-interface/dist/index.js:172:9)
    at async fetchControllerWithPolicy (.../@agent-vm/gateway-interface/dist/index.js:187:20)
    at async fetchController (.../@agent-vm/openclaw-agent-vm-plugin/dist/index.js:90:55)
    at async Object.startActiveUse (...)

2026-06-29T15:27:12.547Z  openclaw-2026-06-29.log:2645
[tools] read failed: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms raw_params={"path":"memory/heartbeat-state.json"}

2026-06-29T15:27:17.213Z  openclaw-2026-06-29.log:2655
embedded run tool start: runId=fcb7c3b4-ed07-4003-85fe-7340d3cca897 tool=exec toolCallId=call_9Zcet42X8FwIDLH6cztZa4f3|fc_0d599f69ab36612a016a428ed3f02f9e5f55

2026-06-29T15:27:37.508Z  openclaw-2026-06-29.log:2658
tools: exec failed stack:
Error: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms
    at fetchWithTimeout (.../@agent-vm/gateway-interface/dist/index.js:172:9)
    at async fetchControllerWithPolicy (.../@agent-vm/gateway-interface/dist/index.js:187:20)
    at async fetchController (.../@agent-vm/openclaw-agent-vm-plugin/dist/index.js:90:55)
    at async Object.startActiveUse (...)

2026-06-29T15:27:37.525Z  openclaw-2026-06-29.log:2659
[tools] exec failed: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms raw_params={"command":{"omitted":true,"reason":"exec command may contain credentials","type":"string","chars":51,"sha256":"<redacted>"},"workdir":"/workspace","yieldMs":10000,"timeout":15}

2026-06-29T15:27:44.112Z  openclaw-2026-06-29.log:2673
embedded run done: runId=fcb7c3b4-ed07-4003-85fe-7340d3cca897 sessionId=fada8b2d-c2ba-49a9-ac31-74c9ccb51e06 durationMs=99920 aborted=false
```

Conclusion for this slice:

- `read memory/heartbeat-state.json` did not fail because the file was missing.
- It did not reach Tool VM SSH.
- It failed before SSH because the gateway could not complete `lease-use-start` with the controller within the 10s policy.
- The follow-up `exec` failed at the same boundary.

## Latest controller-health slice

Source: `~/.agent-vm/runtime/controller-health/events.jsonl`.

Window: `2026-06-29T15:23:58Z..2026-06-29T16:23:58Z`.

Summary:

```text
rows: 1041
maxConsecutiveGatewayControlLinkFailures: 6

457  gateway-control-link / ok / controller-health
360  gateway-service-health / ok
192  gateway-control-link / timeout / controller-health
 22  tool-vm-ssh / ok / file-bridge
  4  lease-renew / ok
  4  tool-vm-ssh / ok / probe
  1  tool-vm-ssh / ok / finalize
  1  gateway-recovery / failed / secret-resolution-failed
```

First timeout rows in that slice:

```text
2026-06-29T15:24:11.271Z  gateway-control-link timeout controller-health elapsedMs=3006
2026-06-29T15:24:13.454Z  gateway-control-link timeout controller-health elapsedMs=3007
2026-06-29T15:24:14.066Z  gateway-control-link timeout controller-health elapsedMs=3008
2026-06-29T15:24:34.285Z  gateway-control-link timeout controller-health elapsedMs=3001
2026-06-29T15:24:35.490Z  gateway-control-link timeout controller-health elapsedMs=3005
2026-06-29T15:24:36.470Z  gateway-control-link timeout controller-health elapsedMs=3002
```

Important interpretation:

- Gateway service-health remained OK in the same hour.
- Tool VM SSH had successful file-bridge/probe rows in the same hour.
- The failure boundary for the app-visible 11:27 local warning was specifically controller active-use start, amid significant control-link timeout noise.
- One `gateway-recovery failed / secret-resolution-failed` row appears in the hour; do not let that become the whole explanation unless it is correlated to a specific restart/recovery attempt.

## Current live controller state

Command:

```text
pnpm exec agent-vm controller status --config config/system.jsonc
```

Observed on 2026-06-29:

```text
controllerPort: 18800
zone: sunfam
running: true
readiness: degraded
gatewayInfrastructure: running
toolVmPlane: ok
toolVmLeaseState: idle
activeLeaseCount: 2
bootedAt: 2026-06-29T06:22:31.099Z
```

Interpretation:

- The controller process is alive.
- The gateway VM is alive.
- The Tool VM plane is considered OK at status time.
- Readiness is still degraded, so the system is not healthy even though it is not down.

## Code anchors

These line numbers are from installed `@agent-vm` package source in `node_modules`, version `0.0.108`.

### Controller request timeout construction

File:

```text
node_modules/.pnpm/@agent-vm+gateway-interface@0.0.108/node_modules/@agent-vm/gateway-interface/dist/index.js
```

Lines:

```text
151-162  fetchWithTimeout creates an AbortController and marks timedOut.
170-176  timed-out fetch throws ControllerRequestPolicyTransportError with code controller-request-timeout.
182-207  fetchControllerWithPolicy applies the operation policy and retry rules.
```

Direct relevance:

- The OpenClaw stack points at `index.js:172` and `index.js:187`.
- That means the request to the controller timed out at the policy layer, before the controller returned a typed app error.

### Lease operation policies

File:

```text
node_modules/.pnpm/@agent-vm+gateway-interface@0.0.108/node_modules/@agent-vm/gateway-interface/dist/index.js
```

Lines:

```text
245-252  lease-create has timeoutMs=180000, maxAttempts=1.
277-288  lease-renew has timeoutMs=10000, maxAttempts=3, retries on 429/503/504.
297-308  lease-use-start has timeoutMs=10000, maxAttempts=2, retries on 429/503/504.
321-328  lease-use-end has timeoutMs=5000, maxAttempts=2, retries on 503/504.
```

Direct relevance:

- The user-visible `lease-use-start timed out after 10000ms` matches the configured `lease-use-start` timeout.
- A transport timeout is not an HTTP 503/504 response, so the retry behavior depends on `ControllerRequestPolicyTransportError` handling. In the stack observed, it surfaced after timing out.

### Active-use is required before SSH

File:

```text
node_modules/.pnpm/@agent-vm+gateway-interface@0.0.108/node_modules/@agent-vm/gateway-interface/dist/index.js
```

Lines:

```text
755-760  createToolVmActiveUseHandle creates a UUIDv7 useId and awaits options.startActiveUse.
778-805  only after start succeeds does the heartbeat timer schedule.
806-820  endActiveUse runs during dispose/end.
```

Direct relevance:

- If `startActiveUse` times out, the tool does not get a usable active-use handle.
- That means `read`/`exec` fails before SSH-backed file bridge or shell work begins.

### OpenClaw Agent VM lease client

File:

```text
node_modules/.pnpm/@agent-vm+openclaw-agent-vm-plugin@0.0.108/node_modules/@agent-vm/openclaw-agent-vm-plugin/dist/index.js
```

Lines:

```text
87-96    createLeaseClient wraps fetchControllerWithPolicy.
97-102   renewLease posts /lease/:leaseId/renew with operation lease-renew.
185-201  requestLease posts /lease with operation lease-create.
203-212  startActiveUse posts /lease/:leaseId/uses with operation lease-use-start.
```

Direct relevance:

- The stack for the latest failure points through `startActiveUse`.
- The request target is the controller lease active-use API, not the Tool VM SSH endpoint.

### Stale lease behavior after SSH problems

File:

```text
node_modules/.pnpm/@agent-vm+openclaw-agent-vm-plugin@0.0.108/node_modules/@agent-vm/openclaw-agent-vm-plugin/dist/index.js
```

Lines:

```text
790-796  markLeaseStale deletes the gateway-side lease cache and best-effort force-releases the controller lease.
806-825  cached lease renewal is followed by an SSH probe.
831-835  ToolVmSshOperationStaleError during renew/probe marks lease stale; refreshable controller errors delete cache.
895-920  createActiveUseHandle wraps createToolVmActiveUseHandle; refreshable active-use errors mark cached lease stale.
922-934  runWithActiveUse disposes active-use, marks lease stale on ToolVmSshOperationStaleError, then rethrows.
936-950  file bridge runs inside runWithActiveUse and only starts after active-use succeeds.
```

Direct relevance:

- This explains the older 404 pattern after SSH reset.
- It does not explain the latest `lease-use-start` timeout as SSH, because latest timeout happens before `runWithActiveUse` can enter SSH file bridge.

### Controller 404 behavior

Files:

```text
node_modules/@agent-vm/agent-vm/dist/controller/http/controller-http-routes.js
node_modules/@agent-vm/agent-vm/dist/controller/leases/lease-manager.js
```

Lines:

```text
controller-http-routes.js:409-435
  POST /lease/:leaseId/uses calls leaseManager.startActiveUse.
  If no activeUse is returned, controller responds with {error:"Lease not found"} and HTTP 404.

lease-manager.js:518-525
  startActiveUse returns undefined when the lease is missing or expired.
```

Direct relevance:

- `Controller active-use start API returned HTTP 404` means the controller answered but did not accept the lease.
- It is different from `lease-use-start controller-request-timeout`, where the gateway request did not complete in time.

### Gateway control-link monitor

File:

```text
node_modules/.pnpm/@agent-vm+openclaw-agent-vm-plugin@0.0.108/node_modules/@agent-vm/openclaw-agent-vm-plugin/dist/index.js
```

Lines:

```text
1121-1131  gateway-control-link monitor and backoff helpers.
1140-1155  health-event publish goes to /zones/:zoneId/health-events.
1170-1193  controller-health GET is attempted and converted to gateway-control-link ok/failed events.
1194-1208  transport timeout becomes gateway-control-link timeout and logs gateway-control-link fetch failed.
1209-1213  publishing the health event can itself timeout.
```

Direct relevance:

- The `gateway-control-link` timeout rows and `gateway-control-link fetch failed` log lines are generated by this monitor.
- The latest failure happened while this same callback path was noisy.

## Correlation table

| User/app symptom | Log evidence | Code boundary | Current interpretation |
| --- | --- | --- | --- |
| `lease-use-start timed out after 10000ms` | `openclaw-2026-06-29.log:2644-2645`, `:2658-2659` | `gateway-interface` `fetchWithTimeout`; `openclaw-agent-vm-plugin` `startActiveUse`; controller `POST /lease/:leaseId/uses` | Gateway request to controller active-use API timed out before SSH. |
| `Controller active-use start API returned HTTP 404` | Prior June 24/June 26 app messages; controller route code | `controller-http-routes.js:409-435`; `lease-manager.js:518-525` | Controller received the active-use request but the lease was missing/expired/not accepted. |
| SSH reset / stale lease | Prior `kex_exchange_identification` and `tool-vm-ssh failed / file-bridge / ssh-command-failed` rows; June 26 evening had two such rows | `openclaw-agent-vm-plugin` stale lease handling lines `790-796`, `922-934` | SSH file-bridge failure can cause lease cache deletion and best-effort release; follow-on tools may see 404. |
| `Heartbeat check failed before it could produce an update` | June 26 windows show recovery suspended and control-link flapping; latest local daily logs do not always explain the app message | OpenClaw embedded run may fail before reply or app may render a fallback warning | Needs runId/sessionId in app-visible warning to make this exact. |
| `interrupted by gateway restart` | `gateway-lifecycle/events.jsonl` at `2026-06-26T17:57:03Z` operation-finished | Agent VM auto-recovery lifecycle | Real gateway VM restart completed. |
| Current degraded status | `agent-vm controller status` shows `readiness: degraded` with running VM | Controller readiness diagnosis | Liveness and readiness remain separate; not a dead process. |

## What to investigate next in Agent VM

1. Add first-class health events for `lease-use-start` timeouts.
   - Current controller-health shows control-link timeouts, lease renew OK, and Tool VM SSH OK, but not each active-use start attempt.
   - Needed fields: `leaseId`, `activeUseId`, `runId`, `sessionId`, `toolCallId`, `toolName`, controller URL host/port, attempt count, timeout/retry outcome.

2. Explain why `lease-use-start` times out while `gateway-control-link` has interleaved OK and timeout rows.
   - The monitor path is periodic and not identical to the active-use request.
   - Need per-request correlation to know whether active-use hits the same route/address failure or controller saturation.

3. Distinguish active-use timeout from controller 404 in app-visible warnings.
   - Timeout means no timely controller response.
   - 404 means timely controller response but no accepted lease.

4. Add a lease lifecycle ledger.
   - `lease-create`, `lease-reuse`, `lease-renew`, `active-use-start`, `active-use-end`, `lease-mark-stale`, `lease-release`, `lease-expire`, `lease-evict`.
   - Current artifacts force reconstruction from multiple logs and code.

5. Investigate lower-level VM network topology.
   - Gateway to controller callback: `controller.vm.host:18800`.
   - Gateway to Tool VM SSH endpoint: dynamic lease SSH endpoint.
   - Prior evidence saw `198.18.0.1:22` for Tool VM SSH reset and `198.19.0.1:18800` for controller callback timeout.

6. Keep 1Password/secret-resolution separate.
   - June 26 recovery attempts had `secret-resolution-failed`.
   - That explains failed restarts, not every heartbeat/tool failure.
   - Treat it as a compounding recovery failure unless a specific heartbeat run starts during recovery and fails on secret resolution.

## Commands used for this appendix

```text
date -u '+%Y-%m-%dT%H:%M:%SZ'
date '+%Y-%m-%dT%H:%M:%S%z'
git status --short --branch
pnpm exec agent-vm --version
pnpm exec agent-vm controller status --config config/system.jsonc
node scripts/snippets parsing ~/.agent-vm/runtime/controller-health/events.jsonl
node scripts/snippets parsing ~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-29.log
nl -ba node_modules/.pnpm/@agent-vm+gateway-interface@0.0.108/node_modules/@agent-vm/gateway-interface/dist/index.js
nl -ba node_modules/.pnpm/@agent-vm+openclaw-agent-vm-plugin@0.0.108/node_modules/@agent-vm/openclaw-agent-vm-plugin/dist/index.js
nl -ba node_modules/@agent-vm/agent-vm/dist/controller/http/controller-http-routes.js
nl -ba node_modules/@agent-vm/agent-vm/dist/controller/leases/lease-manager.js
```

The Node snippets were one-off read-only parsers run from repo root. They did not edit runtime state.
