# 2026-06-29 - sunfam heartbeat lease and control-plane flapping

Status: WIP - investigation evidence captured, lower-level VM network cause not yet proven.
Zone: `sunfam`.
Agent/session focus: `agent:shravan:main:heartbeat`.
Incident span covered: 2026-06-26 through 2026-06-29 America/Toronto.
Repo/source baseline: `shravan-claw` `main` at `origin/main` commit `c21d383`, `@agent-vm/agent-vm` `0.0.108`, OpenClaw `2026.6.8`.

Imported target: upstream `agent-vm` repo.
Runtime source: `shravan-claw` deployment evidence captured on 2026-06-29.
Purpose in this repo: handoff evidence for upstream lease/control-link observability and reliability work.
Note: runtime stack traces reference installed `@agent-vm/*@0.0.108` package paths from the deployment; map them to source packages before changing code.

Companion appendix:

```text
docs/wip/2026-06-29-sunfam-heartbeat-lease-control-plane-research-log.md
```

Use the appendix for exact log snippets, code line anchors, command summaries, and next-agent research notes.

## Bottom line

The repeated Sun app messages are not one single "heartbeat bug".

They are recurring failures in the Agent VM/OpenClaw tool/control plane, with at least three observed shapes:

1. Gateway-to-controller control-link flapping and recovery suspension.
2. `lease-use-start` timeouts before a tool can touch SSH or the workspace.
3. Older `Controller active-use start API returned HTTP 404` failures after a lease is no longer accepted by the controller, often downstream of stale/failed Tool VM transport.

For the 2026-06-29 11:27 local failure, the strongest direct evidence is:

```text
heartbeat starts
  -> model requests read memory/heartbeat-state.json
  -> OpenClaw tries lease-use-start
  -> gateway-to-controller request times out after 10000ms
  -> model tries exec follow-up
  -> lease-use-start times out again after 10000ms
  -> app reports run/show failure
```

That specific failure did not reach Tool VM SSH. It failed while trying to start active-use through the controller.

For the June 26 morning failures, the stronger surrounding evidence is not individual tool SSH failure. It is sustained controller recovery pressure:

```text
gateway-control-link timeouts
  + gateway-recovery-suspended=max-failed-recoveries
  + two secret-resolution-failed auto-recovery attempts
  -> later successful auto-recovery at 13:57 local
```

## Current live state checked

Commands run from `/Users/shravansunder/dev/shravan-claw` on 2026-06-29:

```text
git fetch origin
git status --short --branch
git log --oneline -n 8 --decorate
pnpm exec agent-vm --version
pnpm exec agent-vm controller status --config config/system.jsonc
```

Results:

- `main...origin/main`, no dirty worktree output at the time of status check.
- `origin/main` points at `c21d383 Update agent-vm to 0.0.108`.
- `pnpm exec agent-vm --version` returned `0.0.108`.
- `package.json` pins `@agent-vm/agent-vm` `0.0.108` and `openclaw` `2026.6.8`.
- Controller status:
  - `controllerPort: 18800`
  - `sunfam.running: true`
  - `sunfam.readiness: degraded`
  - `gatewayInfrastructure: running`
  - `toolVmPlane: ok`
  - `toolVmLeaseState: idle`
  - `activeLeaseCount: 2`
  - current boot: `2026-06-29T06:22:31.099Z`

Interpretation: current process/VM liveness is not the same as readiness. The gateway VM is alive and the controller is alive, but the selected zone readiness is degraded.

## Evidence sources

Primary:

- `~/.agent-vm/runtime/controller-health/events.jsonl`
- `~/.agent-vm/runtime/zones/sunfam/gateway-lifecycle/events.jsonl`
- VictoriaLogs / managed OTEL queries, when local OpenClaw daily logs are absent.
- `~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-28.log`
- `~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-29.log`
- `~/.agent-vm/runtime/zones/sunfam/logs/gateway-boot-latest.log`
- installed Agent VM package code under `node_modules`

Source limitation:

- The live `~/.agent-vm/runtime/zones/sunfam/logs` directory currently contains daily OpenClaw logs only for 2026-06-28 and 2026-06-29.
- June 26 OpenClaw per-turn detail therefore comes mainly from controller-health and gateway-lifecycle JSONL, plus user-visible Discord/Sun app messages.
- No separate local source checkout named `agent-vm` was found under the first `/Users/shravansunder/dev` scan; the code references below use installed package source from `@agent-vm/agent-vm@0.0.108` and plugin packages.

## Mental model

```text
Sun heartbeat
  -> OpenClaw embedded run
     -> model selects tools
        -> OpenClaw Agent VM plugin
           -> lease create / renew / active-use start through controller
              -> SSH-backed file bridge or shell
              -> active-use end through controller
```

The recurring failures are on the controller/tool-plane side, not in the Sun message scheduler itself.

Important distinctions:

- `lease-renew`: controller says an existing Tool VM lease can stay alive.
- `lease-use-start`: controller records a short active-use for a specific tool call.
- `tool-vm-ssh`: actual SSH into the Tool VM to run file bridge or shell.
- `gateway-control-link`: gateway VM can call back to the host controller at `controller.vm.host:18800`.
- `gateway-service-health`: host controller can probe the OpenClaw gateway service.

## User-visible event timeline

Times below are America/Toronto local time as shown or implied by Discord.

| Local time | App-visible message | Current classification |
| --- | --- | --- |
| 2026-06-26 07:29 | `Heartbeat check failed before it could produce an update` | June 26 morning controller-health window shows recovery suspended and control-link flapping; no daily OpenClaw log available to decode the exact run. |
| 2026-06-26 07:58 | same before-update failure | Same window. |
| 2026-06-26 08:28 | same before-update failure | Same window. |
| 2026-06-26 08:58 | same before-update failure | Same window. |
| 2026-06-26 09:28 | same before-update failure | Same window. |
| 2026-06-26 09:59 | same before-update failure | Same window. |
| 2026-06-26 10:28 | `run date -> run test memory/heartbeat-state.json -> show memory/heartbeat-state.json -> print text` failed: `lease-use-start controller-request-timeout` | Directly matches the control-plane failure shape: active-use start timed out before tool work. |
| 2026-06-26 10:56 | before-update failure | Same degraded/recovery-suspended period. |
| 2026-06-26 11:26 | before-update failure | Same degraded/recovery-suspended period. |
| 2026-06-26 11:56 | before-update failure | Same degraded/recovery-suspended period. |
| 2026-06-26 12:28 | before-update failure | Same degraded/recovery-suspended period. |
| 2026-06-26 12:58 | before-update failure | Same degraded/recovery-suspended period. |
| 2026-06-26 13:28 | before-update failure | Before the successful 13:57 local auto-recovery completion. |
| 2026-06-26 13:57 | `interrupted by a gateway restart` | Correlates with gateway lifecycle `operation-finished` for auto-recovery at `2026-06-26T17:57:03Z`. |
| 2026-06-26 21:27 | `show memory/heartbeat-state.json -> run true` failed: active-use 404 | Evening window has gateway service OK plus control-link flapping and two `tool-vm-ssh` failures; exact OpenClaw daily log unavailable. |
| 2026-06-26 21:57 | `run python inline script` failed: active-use 404 | Same evening pattern. |
| 2026-06-28 22:27 | `show memory/heartbeat-state.json -> print text -> run date -> run date` failed: `lease-use-start controller-request-timeout` | Controller-health window around 2026-06-29T02:27Z shows control-link flapping, but OpenClaw log around the matching heartbeat run completed without tool error; needs deeper app-message correlation. |
| 2026-06-29 07:28 | before-update failure | OpenClaw log shows the 07:26 heartbeat run completed, but controller-health has control-link timeouts; needs app-message correlation. |
| 2026-06-29 11:27 | `show memory/heartbeat-state.json -> run true` failed: `lease-use-start controller-request-timeout` | Directly proven by OpenClaw log lines for run `fcb7c3b4-ed07-4003-85fe-7340d3cca897`. |

## Controller-health summary

### 2026-06-26 morning / early afternoon

Window: `2026-06-26T11:00:00Z..2026-06-26T18:10:00Z`

Counts:

```text
2579  gateway-service-health / ok
1341  gateway-recovery-suspended / failed / max-failed-recoveries
 372  gateway-control-link / timeout / controller-health
 250  gateway-control-link / ok / controller-health
   2  gateway-recovery / failed / secret-resolution-failed
   1  tool-vm-ssh / ok / file-bridge
   1  gateway-recovery / ok
```

Max consecutive gateway-control-link failures: `24`.

Comment:

- This is no longer just below-threshold flapping.
- The controller was repeatedly recording `gateway-recovery-suspended` because failed recovery count was already exhausted.
- Two auto-recovery attempts failed because zone secret resolution failed.
- The successful recovery was later, at 13:57 local.

### 2026-06-26 gateway lifecycle

`gateway-lifecycle/events.jsonl` shows:

```text
2026-06-26T15:54:43Z  restart-requested, auto-recovery
2026-06-26T15:54:45Z  operation-failed, secret-resolution-failed
2026-06-26T16:55:44Z  restart-requested, auto-recovery
2026-06-26T16:55:46Z  operation-failed, secret-resolution-failed
2026-06-26T17:56:45Z  restart-requested, auto-recovery
2026-06-26T17:56:46Z  stop old VM
2026-06-26T17:56:46Z  start new VM
2026-06-26T17:57:03Z  operation-finished, new gateway hostPid=26856 vmId=7e0103a0-7450-4d26-b95f-a284bb581414
```

Comment:

- The 13:57 local user-visible "interrupted by a gateway restart" lines up with real Agent VM auto-recovery completing.
- Before that, recovery was attempted but blocked by secret resolution failures.

### 2026-06-26 evening 404s

Window: `2026-06-27T01:00:00Z..2026-06-27T02:15:00Z`

Counts:

```text
2173  gateway-control-link / ok / controller-health
 450  gateway-service-health / ok
 227  gateway-control-link / timeout / controller-health
  22  tool-vm-ssh / ok / file-bridge
   2  lease-renew / ok
   2  tool-vm-ssh / ok / probe
   2  tool-vm-ssh / failed / file-bridge / ssh-command-failed
```

Max consecutive gateway-control-link failures: `7`.

Comment:

- Gateway service was alive.
- Control-link was still flaky.
- There were two Tool VM SSH file-bridge failures.
- The app-visible 404s are consistent with stale/missing lease state after failed Tool VM operations, but the direct OpenClaw per-turn log for June 26 is not currently present locally.

### 2026-06-28 22:27 local timeout

Window: `2026-06-29T02:15:00Z..2026-06-29T02:45:00Z`

Counts:

```text
540  gateway-control-link / ok / controller-health
180  gateway-service-health / ok
 46  gateway-control-link / timeout / controller-health
  6  tool-vm-ssh / ok / file-bridge
  2  lease-renew / ok
  2  tool-vm-ssh / ok / probe
```

Max consecutive gateway-control-link failures: `4`.

OpenClaw log comment:

- `openclaw-2026-06-29.log` around `2026-06-29T02:26Z` shows heartbeat run `1a0044ea-58a2-47e7-b9f6-7c6bbd4299fb` completed without an obvious tool error.
- The app-visible `lease-use-start` message may correspond to a nearby run outside the narrow heartbeat line, a different message emission path, or a time-label mismatch.
- Do not overclaim this one from current local daily logs alone.

### 2026-06-29 07:28 local before-update failure

Window: `2026-06-29T11:15:00Z..2026-06-29T11:45:00Z`

Counts:

```text
424  gateway-control-link / ok / controller-health
180  gateway-service-health / ok
 47  gateway-control-link / timeout / controller-health
 24  tool-vm-ssh / ok / file-bridge
  1  tool-vm-ssh / ok / finalize
```

Max consecutive gateway-control-link failures: `3`.

OpenClaw log comment:

- `openclaw-2026-06-29.log` shows heartbeat run `607b3365-9460-4fb3-a821-20b5fbe98245` starting at `2026-06-29T11:26:04Z`.
- It ran `read` and `exec` and ended without an obvious error by `2026-06-29T11:27:11Z`.
- The app-visible before-update failure at 07:28 local is not yet explained by the OpenClaw daily log excerpt.
- There was still meaningful control-link flapping in the same window.

### 2026-06-29 11:27 local lease-use-start timeout

Window: `2026-06-29T15:15:00Z..2026-06-29T15:45:00Z`

Counts:

```text
228  gateway-control-link / ok / controller-health
180  gateway-service-health / ok
 88  gateway-control-link / timeout / controller-health
 19  tool-vm-ssh / ok / file-bridge
  2  lease-renew / ok
  2  tool-vm-ssh / ok / probe
```

Max consecutive gateway-control-link failures: `5`.

OpenClaw log:

```text
2026-06-29T15:26:04Z  session turn created runId=fcb7c3b4-ed07-4003-85fe-7340d3cca897 sessionKey=agent:shravan:main:heartbeat
2026-06-29T15:26:11Z  tool=read starts
2026-06-29T15:27:12Z  read failed: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms raw_params={"path":"memory/heartbeat-state.json"}
2026-06-29T15:27:17Z  tool=exec starts
2026-06-29T15:27:37Z  exec failed: lease-use-start controller-request-timeout: lease-use-start timed out after 10000ms
2026-06-29T15:27:44Z  run completes and session returns idle
```

Comment:

- This is the cleanest current reproduction of the app-visible symptom.
- It failed before SSH work because `createToolVmActiveUseHandle` could not complete `startActiveUse`.
- Gateway service-health stayed OK, so this is not a full gateway process crash.
- The issue is the gateway-to-controller active-use request path.

### Latest refresh after doc creation

Refresh time: `2026-06-29T16:23:58Z` / `2026-06-29T12:23:58-0400`.

Window: `2026-06-29T15:23:58Z..2026-06-29T16:23:58Z`

Counts:

```text
457  gateway-control-link / ok / controller-health
360  gateway-service-health / ok
192  gateway-control-link / timeout / controller-health
 22  tool-vm-ssh / ok / file-bridge
  4  lease-renew / ok
  4  tool-vm-ssh / ok / probe
  1  tool-vm-ssh / ok / finalize
  1  gateway-recovery / failed / secret-resolution-failed
```

Max consecutive gateway-control-link failures: `6`.

Comment:

- The latest hour still shows substantial gateway-to-controller callback timeout noise.
- Gateway service-health stayed OK in the same hour.
- Tool VM SSH had successful probe/file-bridge/finalize events in the same hour.
- This reinforces the current root-cause lane: active-use/controller callback reliability, not a permanent Tool VM SSH outage.

## Code-path correlation

Installed package paths:

- `node_modules/.pnpm/@agent-vm+gateway-interface@0.0.108/node_modules/@agent-vm/gateway-interface/dist/index.js`
- `node_modules/.pnpm/@agent-vm+openclaw-agent-vm-plugin@0.0.108/node_modules/@agent-vm/openclaw-agent-vm-plugin/dist/index.js`
- `node_modules/@agent-vm/agent-vm/dist/controller/http/controller-http-routes.js`
- `node_modules/@agent-vm/agent-vm/dist/controller/leases/lease-manager.js`

Relevant flow:

```text
OpenClaw tool read/exec
  -> createActiveUseHandle
  -> createToolVmActiveUseHandle
  -> leaseClient.startActiveUse
  -> POST /lease/:leaseId/uses on controller
  -> only after that succeeds does file-bridge/shell SSH run
```

For `lease-use-start controller-request-timeout`:

- The gateway/interface request to the controller did not complete within the 10s `lease-use-start` policy.
- The tool command did not get far enough to prove a Tool VM SSH failure.
- This explains `run date`, `show memory/heartbeat-state.json`, `run true`, and similar tool chains failing before doing useful work.

For `Controller active-use start API returned HTTP 404`:

- The controller route returns 404 when `leaseManager.startActiveUse(...)` returns undefined.
- `leaseManager.startActiveUse` returns undefined when the lease is absent or expired.
- In prior 12:27 evidence, a Tool VM SSH reset caused the plugin to treat the lease as stale and best-effort release it, which makes a follow-on active-use 404 code-consistent.

For Tool VM SSH stale handling:

- `runToolVmSshOperationWithGuard` wraps file-bridge/probe/finalize SSH operations.
- SSH command errors become `ToolVmSshOperationStaleError` with a reason such as `ssh-command-failed` or `ssh-command-timed-out`.
- `runWithActiveUse` catches those stale errors, disposes active use, marks the cached lease stale, deletes it from the gateway cache, and best-effort force-releases it from the controller.

## What is wrong with the lease sequence?

The intended healthy sequence is:

```text
cached lease exists
  -> renew lease
  -> SSH probe OK
  -> start active-use
  -> run SSH file bridge / shell
  -> end active-use
```

Observed broken sequences:

```text
start active-use
  -> controller request timeout
  -> no SSH attempted
```

and:

```text
renew/probe OK
  -> start active-use OK
  -> SSH file bridge resets
  -> lease marked stale/released
  -> next tool tries active-use
  -> controller returns 404 because old lease is gone/not accepted
```

So renewal is not the main proven problem in the clean 2026-06-29 11:27 case. Renewal may succeed while `lease-use-start` still fails, because they are separate controller operations with different timing and request paths.

The broader problem is that the gateway-to-controller callback path is not reliable enough for every lease operation.

## What is missing from the logs

Current logs do not provide a complete lease life story.

What we need:

```text
leaseId
  created/reused at
  vmId / tcpSlot / ssh endpoint
  renew attempts and result
  active-use start attempts and result
  toolCallId / runId / sessionKey
  SSH phase entered or not entered
  active-use heartbeat/end result
  stale classification reason
  release requested/result
  controller deletion/expiry/reaping reason
```

Specific gaps:

1. `lease-use-start` timeout does not emit a controller-health row with the lease id and run/tool correlation.
2. `Lease not found` 404 does not say whether the controller saw the lease as missing, expired, releasing, or already tombstoned.
3. Stale lease marking is visible only in gateway logs when that message is retained; it is not a structured lifecycle event.
4. Gateway-to-controller request failures for `lease-create`, `lease-use-start`, `lease-use-end`, and `lease-release` are not first-class health events with shared correlation ids.
5. The app-visible Sun message does not include runId/sessionId/toolCallId, which makes correlating Discord text back to OpenClaw/OTEL unnecessarily hard.
6. The local daily OpenClaw logs are not retained far enough back to decode June 26 per-turn failures.

## Proposed Agent VM observability improvements

No fix is proposed in this doc. These are instrumentation improvements needed before a durable fix can be chosen confidently.

1. Add a structured lease lifecycle event stream:
   - `lease-create-requested`
   - `lease-created`
   - `lease-reused`
   - `lease-renew-requested`
   - `lease-renewed`
   - `active-use-start-requested`
   - `active-use-started`
   - `active-use-start-failed`
   - `active-use-ended`
   - `lease-marked-stale`
   - `lease-release-requested`
   - `lease-released`
   - `lease-expired`
   - `lease-evicted`

2. Include mandatory correlation fields:
   - `zoneId`
   - `agentId`
   - `sessionKey`
   - `sessionId`
   - `runId`
   - `toolCallId`
   - `toolName`
   - `leaseId`
   - `activeUseId`
   - `vmId`
   - `tcpSlot`
   - `operation`
   - `elapsedMs`
   - `controllerHost`
   - `controllerPort`

3. Split controller 404 reasons:
   - `lease-missing`
   - `lease-expired`
   - `lease-releasing`
   - `lease-active-use-tombstoned`
   - `runtime-not-ready`

4. Emit health events for every controller request operation:
   - `lease-create`
   - `lease-renew`
   - `lease-use-start`
   - `lease-use-heartbeat`
   - `lease-use-end`
   - `lease-release`
   - `health-event-publish`

5. Classify SSH failure phase:
   - `connect`
   - `handshake`
   - `command-start`
   - `command-running`
   - `stdout-read`
   - `stderr-read`
   - `exit-status`

6. Preserve app-visible error correlation:
   - Add `runId`, `sessionId`, and first failing `toolCallId` to the internal error metadata used to render Sun app warnings.

## Research log

### Repo and version checks

```text
git fetch origin
git status --short --branch
git log --oneline -n 8 --decorate
pnpm exec agent-vm --version
node -e "const p=require('./package.json'); ..."
pnpm exec agent-vm controller status --config config/system.jsonc
```

Findings:

- `main` matches `origin/main`.
- Current Agent VM package is `0.0.108`.
- Current runtime status is live but degraded.

### Documentation inspected

```text
docs/manual/operations.md
docs/manual/observability.md
docs/manual/tool-vm-leases.md
docs/wip/debugging/2026-06-17-sunfam-agent-stop-and-toolvm-failures.md
```

Comments:

- `operations.md` is the key manual for separating gateway service health, gateway control-link health, Tool VM SSH health, and auto-recovery behavior.
- The June 17 doc remains a useful prior pattern, but this incident has a stronger recurring `lease-use-start` / controller callback timeout shape than the June 17 hard `undici` crash.

### Runtime artifacts inspected

```text
~/.agent-vm/runtime/controller-health/events.jsonl
~/.agent-vm/runtime/zones/sunfam/gateway-lifecycle/events.jsonl
~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-28.log
~/.agent-vm/runtime/zones/sunfam/logs/openclaw-2026-06-29.log
~/.agent-vm/runtime/zones/sunfam/logs/gateway-boot-latest.log
```

Comments:

- Controller-health JSONL is the best source for quantified flapping windows.
- Gateway-lifecycle JSONL is the best source for restart and secret-resolution failure proof.
- OpenClaw daily logs provide per-run tool evidence only for June 28 and June 29 in the current log directory.

### Query script shape

Controller-health windows were summarized by parsing `body.observedAtMs`, grouping by:

```text
kind / result / operation / errorCode
```

and calculating max consecutive `gateway-control-link` failures.

Windows queried:

```text
2026-06-26T11:00:00Z..2026-06-26T18:10:00Z
2026-06-27T01:00:00Z..2026-06-27T02:15:00Z
2026-06-29T02:15:00Z..2026-06-29T02:45:00Z
2026-06-29T11:15:00Z..2026-06-29T11:45:00Z
2026-06-29T15:15:00Z..2026-06-29T15:45:00Z
```

### Code inspected

Installed package source:

```text
@agent-vm/gateway-interface@0.0.108
@agent-vm/openclaw-agent-vm-plugin@0.0.108
@agent-vm/agent-vm@0.0.108 controller routes and lease manager
```

Key code-path conclusions:

- `createToolVmActiveUseHandle` starts active-use before tool SSH.
- `lease-use-start controller-request-timeout` means active-use did not start before the request timed out.
- `POST /lease/:leaseId/uses` returns 404 when the lease manager returns no active-use.
- The lease manager returns no active-use when the lease is missing or expired.
- Tool VM SSH errors are classified as stale operation errors and cause cached lease stale handling.

## Current hypothesis ranking

1. Most likely: gateway-to-controller callback/control-link path is intermittently timing out, causing both heartbeat-before-update failures and explicit `lease-use-start` tool failures.
   - Evidence: repeated `gateway-control-link` timeouts, direct `lease-use-start` timeouts, service-health remaining OK in some windows.
   - Missing: packet/topology proof for why callback path flaps.

2. Also present: Tool VM SSH/file-bridge instability sometimes marks leases stale, which can lead to active-use 404 on the next tool.
   - Evidence: prior `kex_exchange_identification` reset; June 26 evening has `tool-vm-ssh failed / file-bridge / ssh-command-failed`.
   - Missing: local June 26 OpenClaw daily log lines connecting those exact SSH failures to the two app-visible 404s.

3. Recovery compounding factor: auto-recovery can become suspended and recovery attempts can fail due secret resolution.
   - Evidence: June 26 morning `gateway-recovery-suspended` count and two `secret-resolution-failed` lifecycle attempts.
   - Missing: direct explanation for why 1Password SDK/op fallback failed in those two exact recovery attempts.

## Next proof steps

1. Add or temporarily enable structured lease lifecycle logging in Agent VM.
2. Add structured controller request health events for `lease-use-start`, `lease-create`, `lease-use-end`, and `lease-release`.
3. Correlate the next app-visible Sun warning by `runId`, `sessionId`, `toolCallId`, and `leaseId`.
4. Investigate lower-level network topology for:

```text
gateway VM -> controller.vm.host:18800
gateway VM -> Tool VM SSH endpoint
```

5. Separately investigate the June 26 `secret-resolution-failed` recovery attempts only after preserving the controller/control-link evidence, so 1Password does not get incorrectly blamed for all heartbeat failures.
