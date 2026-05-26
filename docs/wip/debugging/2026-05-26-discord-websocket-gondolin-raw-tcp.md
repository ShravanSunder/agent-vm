# 2026-05-26 Discord WebSocket Stability in Gondolin Raw TCP

## Scope

OpenClaw Discord gateway runs inside a Gondolin gateway VM. The observed failure
shape is:

- Discord gateway stays connected for roughly 30-60 minutes.
- The WebSocket closes abnormally (`1006`, no close frame).
- Reconnect attempts receive `Unexpected server response: 403` in a burst.
- A later retry succeeds, then the cycle repeats.

This note separates the network layers so we do not keep applying duplicate
fixes to the wrong path.

## Current Conclusion

The Discord flap is no longer explained by the original IPv6/MITM race alone:

- guest Node IPv4-preference flags were present
- host-side agent-vm/Gondolin IPv4 defaults were active
- `gateway.discord.gg:443` was using raw `tcpHosts` passthrough
- the live Discord socket was IPv4
- a beta-only raw TCP keepalive/no-delay patch still reproduced the failure

The best supported current model is:

1. The first drop is still not fully explained by available logs.
2. Gondolin raw TCP did not report an abort, socket error, or buffer-limit
   marker during the keepalive-patched failure.
3. OpenClaw's gateway-internal retry loop treats `1006` as resumable and
   retries with deterministic backoff.
4. The provider-level health monitor recovered beta by restarting the Discord
   provider, which reset more state than the gateway-internal resume loop.

So the immediate, testable work splits into:

- keep agent-vm host IPv4 defaults as general Gondolin hardening, but do not
  claim they fix Discord by themselves
- pursue OpenClaw reconnect resilience and diagnostics for repeated
  `403`/`1006` loops
- keep Gondolin raw TCP error/abort logging as upstream diagnostic hardening
- treat raw TCP keepalive/no-delay as useful hardening, not as a proven fix

## Current Code Facts

### Gateway VM Node processes already force IPv4 preference

`@agent-vm/gateway-interface` defines:

```text
--dns-result-order=ipv4first --no-network-family-autoselection
```

The flags are applied to OpenClaw gateway VMs, worker gateway VMs, and Tool VMs.
The second flag is the important one for modern Node because DNS ordering alone
does not prevent Happy Eyeballs family racing.

### OpenClaw Discord also has a Discord-specific IPv4-first lookup

`@openclaw/discord` creates an `HttpsAgent` with `createDiscordDnsLookup()`.
That lookup reorders resolved Discord addresses so IPv4 answers come first for
`discord.com`, `discord.gg`, and `gateway.discord.gg`.

This is useful inside the OpenClaw process, but it only covers code paths using
that Discord agent.

### `websocketBypass` uses Gondolin raw `tcpHosts`

Agent-vm maps `zone.websocketBypass` entries such as
`gateway.discord.gg:443` into Gondolin `tcpHosts`:

```text
gateway.discord.gg:443 -> gateway.discord.gg:443
```

For these mappings, Gondolin allows raw TCP passthrough. The Discord TLS and
WebSocket handshake is not HTTP/TLS-mediated by Gondolin.

### Host-side `tcpHosts` dialing is outside gateway VM `NODE_OPTIONS`

The raw mapped TCP upstream socket is opened by the host-side Gondolin network
backend, which runs inside the agent-vm controller process. Gateway VM
`NODE_OPTIONS` do not affect this host process.

That is why the `websocket-issues` branch adds host-process defaults through
`@agent-vm/gondolin-adapter`:

```ts
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);
```

This is not a replacement for VM `NODE_OPTIONS`; it closes the matching gap on
the host-side raw `tcpHosts` path.

## Fix Matrix

| Layer | Candidate | Relevance to Discord raw `tcpHosts` | Notes |
| --- | --- | --- | --- |
| Gateway VM Node | `NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection` | High, already present | Covers OpenClaw and other Node services inside the VM. Keep this as a general Gondolin invariant. |
| OpenClaw Discord plugin | Discord-specific IPv4-first `HttpsAgent` lookup | Useful, already present | Covers OpenClaw's Discord client path. Does not affect host-side Gondolin raw TCP dialing. |
| Agent-vm/Gondolin adapter host process | `dns.setDefaultResultOrder("ipv4first")` and `net.setDefaultAutoSelectFamily(false)` | High | Covers Gondolin host-side raw `tcpHosts` upstream sockets from the controller, smoke tests, and direct adapter users. PR-worthy. |
| Gondolin mapped TCP socket | `socket.setKeepAlive(true, 30_000)` | Medium/high | Can help long-lived raw TCP survive idle middleboxes; also a reasonable default for mapped service tunnels. |
| Gondolin mapped TCP socket | `socket.setNoDelay(true)` | Low/medium | Improves small-frame latency. Unlikely to fix 30-60 minute drops by itself. |
| Gondolin mapped TCP socket | Preserve/log socket error details | High for diagnosis | Does not prevent failures, but turns future `1006` events into actionable `ECONNRESET`, `ETIMEDOUT`, etc. evidence. |
| Gondolin HTTP WebSocket bridge | `webSocketUpstreamConnectTimeoutMs`, `webSocketUpstreamHeaderTimeoutMs` | Not a raw Discord bypass fix | These affect Gondolin's HTTP-mediated WebSocket upgrade path. `gateway.discord.gg:443` bypasses that path through `tcpHosts`. Still useful for other non-bypassed WebSockets. |
| OpenClaw config | `gateway.channelHealthCheckMinutes`, `channelStaleEventThresholdMinutes`, `channelMaxRestartsPerHour` | Recovery only | Helps recover from stale sockets but does not explain or prevent the underlying raw TCP close. |
| OpenClaw Discord proxy | `channels.discord.proxy` | Situational | Only useful if intentionally running a trusted local loopback proxy. It bypasses the direct `HttpsAgent` path, but it is operationally heavier and should not be the default fix. |

## OpenClaw Reconnect Facts

OpenClaw's Discord gateway plugin currently constructs the gateway with
`reconnect: { maxAttempts: 50 }`. The internal gateway reconnect path:

- handles WebSocket `close` by stopping heartbeat, clearing the outbound
  limiter, marking the gateway disconnected, and scheduling reconnect unless the
  close code is fatal
- uses exponential backoff capped at 30 seconds
- resets `reconnectAttempts` on Discord `READY` and `RESUMED`
- reports `Gateway websocket closed`
- does not currently emit the `Gateway reconnect scheduled in ...` or
  `Gateway forcing fresh IDENTIFY after ...` debug messages that
  `gateway-logging.ts` and `provider.lifecycle.ts` already know how to promote

The controlled beta burst is consistent with that behavior: fast first retries,
then 30-second cadence, then a successful reconnect when Discord accepts the
gateway again or when the health monitor restarts the provider.

The OpenClaw health monitor knobs remain useful for operator experience, but
they do not change the raw TCP socket lifetime:

```jsonc
{
  "gateway": {
    "channelHealthCheckMinutes": 3,
    "channelStaleEventThresholdMinutes": 15,
    "channelMaxRestartsPerHour": 20
  }
}
```

Use this as recovery tuning only. It should not be described as a fix for the
Discord raw `tcpHosts` close.

## Remaining Hypotheses To Instrument

The `403` burst is likely a downstream symptom of rapid reconnects. The root
cause is the first abnormal close. Instrument that boundary first.

### Gondolin raw TCP abort paths

Gondolin can abort a TCP session when buffered writes exceed
`maxTcpPendingWriteBytes`, with reasons like:

```text
pending-write-buffer-exceeded
socket-write-buffer-exceeded
```

Those host-side aborts would look like an abnormal WebSocket close from inside
OpenClaw. A useful upstream diagnostic patch should log mapped TCP close/error
and `abortTcpSession()` reasons with the synthetic hostname, upstream target,
and Node error `code` when available.

### Heartbeat visibility

OpenClaw logs `Gateway websocket closed: 1006`, but the useful pre-failure
question is whether Discord heartbeat ACKs were flowing through the raw tunnel
until the end. If heartbeat sends or ACKs stall before the first `1006`, that
points toward host-side flow control or a half-open raw socket rather than
Discord rejecting a healthy connection.

### Keepalive caveat

`socket.setKeepAlive(true, 30_000)` remains reasonable hardening for long-lived
mapped TCP, but beta showed it is not sufficient for this Discord failure. Node
sets the initial keepalive delay; the later probe cadence is OS-dependent. It
can prevent some idle middlebox drops, but diagnosis still needs error/abort
logs to prove what happened.

## What To Keep

### Agent-vm PR

Keep the host-process network default change:

- It generalizes beyond Discord.
- It protects any Node-host-side Gondolin raw `tcpHosts` dial.
- It lives in `gondolin-adapter` so direct `createManagedVm()` users get the
  same default, while controller startup still logs the configured state early.
- It is small and testable without live beta.
- It is not sufficient by itself to stop the observed Discord flap. The
  controlled beta run below reproduced a `403`/`1006` burst while the host
  process was using IPv4-only Discord sockets.

### Gondolin upstream PR or issue

The dirty local Gondolin checkout already contains useful candidate changes:

- mapped TCP `setKeepAlive(true, 30_000)`
- mapped TCP `setNoDelay(true)`
- debug log socket error `code` and message

Split these conceptually:

1. raw TCP error/abort logging: directly relevant and diagnostic-only
2. raw TCP keepalive/noDelay: directly relevant behavior change for `tcpHosts`
3. WebSocket upstream timeout plumbing: useful SDK completeness, but not the
   Discord raw bypass fix

The current beta run did not prove the raw TCP keepalive candidate. The
installed package resolved by beta is `@earendil-works/gondolin@0.12.0` with a
pnpm patch hash, and its built `dist/src/qemu/net.js` does not contain mapped
TCP `setKeepAlive()` or mapped TCP `setNoDelay()` calls. The upstream dirty
checkout has those calls, but beta was not running that checkout during the
controlled soak.

The installed `@earendil-works/gondolin@0.12.0` copy used by beta exposes
`webSocketUpstreamConnectTimeoutMs` and
`webSocketUpstreamHeaderTimeoutMs` in some generated QEMU/internal types, but
the agent-vm worktree's public `VMOptions` typecheck currently rejects those
fields. Do not push a cast through agent-vm just to set them. Treat this as a
separate Gondolin SDK/API follow-up for non-bypassed HTTP/WebSocket bridge
traffic.

## Beta-Free Validation

Run these before touching `shravan-claw-beta`.

1. Agent-vm unit tests:

```sh
pnpm vitest run --config vitest.config.ts \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/gateway-interface/src/force-ipv4-egress.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/worker-gateway/src/worker-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts
```

Evidence required:

- host defaults are called before zone startup work
- `createManagedVm()` also applies host defaults before constructing Gondolin VM
  state
- OpenClaw/worker/tool VM specs always include both IPv4 flags
- user-provided `NODE_OPTIONS` cannot erase the forced flags

2. Gondolin unit tests:

```sh
pnpm test host/test/qemu-net.test.ts
```

Evidence required:

- mapped `tcpHosts` sockets call `setKeepAlive(true, 30_000)`
- mapped `tcpHosts` sockets call `setNoDelay(true)`
- errors retain enough detail in debug output

3. Config audit for deployments:

```sh
rg -n "websocketBypass|gateway.discord.gg|channelHealthCheckMinutes|channelStaleEventThresholdMinutes|channelMaxRestartsPerHour|NODE_OPTIONS" \
  config vm-images docs
```

Evidence required:

- `gateway.discord.gg:443` is in `websocketBypass`
- deployment is on an agent-vm version containing forced IPv4 flags
- optional OpenClaw health monitor tuning is explicit if used

## Later Beta Validation

Only use beta when it is intentionally available.

### Current passive beta evidence

Read-only inspection on 2026-05-26 found `shravan-claw-beta` currently symlinked
to this `agent-vm.websocket-issues` worktree for `@agent-vm/*` packages:

```text
node_modules/@agent-vm/agent-vm -> ../../../agent-vm.websocket-issues/packages/agent-vm
node_modules/@agent-vm/gondolin-adapter -> ../../../agent-vm.websocket-issues/packages/gondolin-adapter
```

The built package output also contains the host-defaults code:

```text
packages/agent-vm/dist/controller/controller-runtime.js:
  Host network defaults: dnsResultOrder=...

packages/gondolin-adapter/dist/index.js:
  setDefaultResultOrder("ipv4first")
  setDefaultAutoSelectFamily(false)
```

The live beta gateway record showed the controller and gateway VM were already
running from `shravan-claw-beta`:

```text
controller: node .../shravan-claw-beta/node_modules/.../@agent-vm/agent-vm/dist/cli/agent-vm-entrypoint.js controller start --config config/system.jsonc --zone beta
gateway runtime createdAt: 2026-05-26T01:11:30.181Z
qemuPid: 2295
```

Existing OpenClaw logs showed the last observed Discord `1006`/`403` burst at
`2026-05-25T10:26:19Z`. The `2026-05-26` beta log had no `1006`/`403` entries
through `2026-05-26T01:57:57Z`:

```text
openclaw-2026-05-25.log:
  bad_count: 84
  last bad: 2026-05-25T10:26:19.660Z
  clean close: 2026-05-25T23:56:21.395Z code=1000

openclaw-2026-05-26.log:
  range: 2026-05-26T00:01:52.480Z -> 2026-05-26T01:57:57.727Z
  bad_count: 0
  opened_count: 8
  closed_count: 0
```

At `2026-05-26T02:52:40Z`, beta controller and zone health both returned
HTTP 200:

```text
GET http://127.0.0.1:18900/health
  {"ok":true,"port":18900,"state":"ready"}

GET http://127.0.0.1:18900/zones/beta/health
  {"ok":true,"observation":"http 200","zoneId":"beta"}
```

At the same time, the host-side controller process had an established IPv4 TCP
socket to one of the live `gateway.discord.gg` A records:

```text
dig +short gateway.discord.gg A:
  162.159.135.234
  162.159.136.234
  162.159.133.234
  162.159.130.234
  162.159.134.234

lsof -nP -a -p 1813 -iTCP:
  node 1813 ... TCP 10.0.0.71:55701->162.159.130.234:443 (ESTABLISHED)
```

This matters because `gateway.discord.gg:443` is configured as raw `tcpHosts`
passthrough. The observed socket is in the host-side controller/Gondolin process
and is IPv4, which is the exact path the host-defaults change is meant to make
deterministic.

Because beta had an active tool lease, the next validation step was limited to a
non-mutating 15-minute passive watch of appended log bytes:

```text
watch started:  2026-05-25T22:36:05-0400
watch finished: 2026-05-25T22:51:06-0400
log: /Users/shravansunder/.agent-vm/runtime/zones/beta/logs/openclaw-2026-05-26.log
start_size: 742013
end_size:   742013
new 1006:   0
new 403:    0
new 1000:   0
  new opened: 0
```

### Controlled beta restart evidence

After the active beta lease cleared, beta was restarted from
`shravan-claw-beta` while its `@agent-vm/*` packages were symlinked to this
`agent-vm.websocket-issues` worktree.

Controller startup printed the host default proof:

```text
[agent-vm] Host network defaults: dnsResultOrder=ipv4first autoSelectFamily=false
```

The new gateway VM booted at:

```text
gateway runtime createdAt: 2026-05-26T03:41:29.275Z
controller PID: 15376
qemuPid: 16163
vmId: a28f8b11-70dc-465b-b913-a7d306485aea
```

The gateway boot log also showed guest Node IPv4 flags:

```text
gateway-boot: NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection --dns-result-order=ipv4first --no-network-family-autoselection
```

The duplicate flags are harmless, but worth cleaning up separately if we want
tidier operator logs.

Discord connected immediately:

```text
2026-05-26T03:41:30.242Z connected to gateway
2026-05-26T03:41:30.563Z Gateway websocket opened
```

The host-side controller process had an IPv4 Discord socket after startup:

```text
node 15376 ... TCP 10.0.0.71:55236->162.159.130.234:443 (ESTABLISHED)
```

A controlled sampler then watched health, bad log events, and host-side
Discord sockets every ten minutes. Samples 1-4 were clean, then the failure
reproduced:

```text
sample 1  2026-05-26T03:42:55Z  bad=0   closed=0   zoneHealth=200  discordSocket=IPv4 established
sample 2  2026-05-26T03:52:55Z  bad=0   closed=0   zoneHealth=200  discordSocket=IPv4 established
sample 3  2026-05-26T04:02:55Z  bad=0   closed=0   zoneHealth=200  discordSocket=IPv4 established
sample 4  2026-05-26T04:12:56Z  bad=0   closed=0   zoneHealth=200  discordSocket=IPv4 established
sample 5  2026-05-26T04:22:56Z  bad=15  closed=10  zoneHealth=503  discordSocket=none
sample 6  2026-05-26T04:32:56Z  bad=21  closed=14  zoneHealth=503  discordSocket=none
sample 7  2026-05-26T04:42:57Z  bad=36  closed=24  zoneHealth=200  discordSocket=IPv4 established
```

The first failure in the OpenClaw log was:

```text
2026-05-26T04:21:55.377Z discord gateway error: Error: Unexpected server response: 403
2026-05-26T04:21:55.385Z discord gateway: Gateway websocket closed: 1006
```

The connection recovered without manual intervention:

```text
2026-05-26T04:26:27.317Z connected to gateway
2026-05-26T04:26:27.638Z Gateway websocket opened
```

After recovery, beta health returned to HTTP 200 and the controller process had
a new IPv4 Discord socket:

```text
GET /zones/beta/health
  {"ok":true,"observation":"http 200","zoneId":"beta"}

lsof -nP -a -p 15376 -iTCP
  node 15376 ... TCP 10.0.0.71:61383->162.159.133.234:443 (ESTABLISHED)
```

Conclusion from the controlled run:

- the original Happy Eyeballs/IPv6 hypothesis is no longer the best fit for this
  failure shape
- host-side IPv4 defaults are still PR-worthy because they close a real
  correctness gap for raw `tcpHosts`
- the remaining problem is long-lived mapped TCP durability and/or Discord's
  behavior after an abnormal raw socket loss
- the next live test should first run beta with upstream Gondolin raw TCP
  error/abort-detail logging, then separately test keepalive/noDelay

The lease remained active during further validation:

```text
GET /leases:
  id: 019e61f8-ef4d-728b-abce-6051a6b113a5
  agentId: beta
  zoneId: beta
  tcpSlot: 0
  createdAt: 2026-05-26T01:49:24Z
  lastUsedAt: 2026-05-26T01:55:58Z

process state:
  controller pid 1813 elapsed 01:46:19
  gateway qemu pid 2295 elapsed 01:46:17
  tool qemu pid 73250 elapsed 01:08:16
```

A longer non-mutating sampler then ran seven samples over 30 minutes. Each
sample checked controller health, zone health, Discord log counts, and the
host-side controller TCP sockets:

```text
sampler output:
  /tmp/beta-discord-socket-sampler-2026-05-26.jsonl

sample window:
  first: 2026-05-26T02:58:39.452393Z
  last:  2026-05-26T03:28:40.567132Z

health:
  controller: {"ok":true,"port":18900,"state":"ready"}
  zone:       {"ok":true,"observation":"http 200","zoneId":"beta"}

log:
  size: 742013
  last timestamp: 2026-05-26T01:57:57.727Z
  bad counts: [0]
  close counts: [0]
  open counts: [8]

socket:
  node 1813 ... IPv4 TCP 10.0.0.71:55701->162.159.130.234:443 (ESTABLISHED)
  IPv6 Discord socket lines: []
```

This is encouraging but not a completed validation. The beta deployment had
pre-existing workspace/package edits from another agent, and a controlled soak
has not been started by this investigation.

1. Confirm boot/runtime flags from logs:

```sh
rg -n "gateway-boot: NODE_OPTIONS|Host network defaults" \
  ~/.agent-vm/runtime/zones/beta/logs/*
```

2. Confirm Discord symptoms before and after the candidate package:

```sh
rg -n "discord gateway error|Unexpected server response: 403|Gateway websocket closed: 1006|connected to gateway|reconnect" \
  ~/.agent-vm/runtime/zones/beta/logs/openclaw-*.log
```

3. Soak window:

- Minimum useful signal: 90 minutes without repeating the 30-60 minute
  `1006 -> 403 burst -> reconnect` cycle.
- Better signal: overnight run with counts grouped by hour.

4. If failures continue, capture lower-level evidence:

- Gondolin debug logs for mapped TCP socket error code/message.
- Host-side packet trace only if needed and approved.
- Discord reconnect pacing and session resume/identify behavior from OpenClaw
  logs.

## Current Hypothesis

The old IPv6/Happy-Eyeballs failure is mostly addressed inside the VM. The
remaining gap is host-side raw `tcpHosts` dialing plus lack of raw TCP
resilience/diagnostics. The practical fix sequence is:

1. Land agent-vm/Gondolin-adapter host-process network defaults.
2. Land or upstream Gondolin mapped TCP keepalive/noDelay/error-detail changes.
3. Treat Gondolin WebSocket upstream timeout exposure as useful but separate.
4. Use OpenClaw health monitor tuning only as recovery improvement.
5. Validate with beta soak before calling the Discord issue fixed.

## External Review Notes

Two read-only second-opinion reviews were run against this branch and evidence.

Gemini verdict:

- Host-side `dns.setDefaultResultOrder("ipv4first")` and
  `net.setDefaultAutoSelectFamily(false)` are distinct from VM `NODE_OPTIONS`
  because Gondolin raw `tcpHosts` sockets are opened by the host controller
  process.
- Gondolin raw TCP keepalive/noDelay/error logging should be upstream Gondolin
  work.
- Gondolin HTTP WebSocket connect/header timeouts do not affect Discord while
  `gateway.discord.gg:443` is raw `tcpHosts`.
- More confidence needs long-running uptime plus reconnect testing. It also
  called out the tradeoff that disabling family autoselection assumes IPv4 is
  reachable.

Claude verdict:

- The branch is PR-worthy and correctly covers a host-process gap left by guest
  `NODE_OPTIONS`.
- The host defaults are process-wide, so the PR should say that controller
  egress becomes IPv4-first by design, not only Discord.
- The helper is idempotently invoked both at controller startup and inside
  `createManagedVm()`. Keep this if we want early controller logs plus direct
  adapter-user safety; otherwise the adapter call is the canonical invariant.
- Before declaring fixed, require a longer active beta soak, preferably with
  Discord activity and repeated `lsof` snapshots showing the raw passthrough
  socket remains IPv4. Focused tests are not a substitute for the full repo
  check.

Additional validation still needed before closing the issue:

1. Run `pnpm check` on this branch.
2. Run a longer beta soak while beta is intentionally available.
3. If possible, capture repeated `lsof -nP -a -p <controllerPid> -iTCP`
   snapshots during the soak.
4. If a `1006` recurs, capture Gondolin raw TCP error detail after the upstream
   diagnostics patch lands.

## 2026-05-26 05:03Z Debug-Enabled Beta Soak

After rebuilding this branch, beta was restarted with host-side Gondolin network
debug enabled:

```sh
GONDOLIN_DEBUG=net node .../agent-vm-entrypoint.js controller start \
  --config config/system.jsonc --zone beta
```

Controller startup confirmed the host-process defaults:

```text
[agent-vm] Host network defaults: dnsResultOrder=ipv4first autoSelectFamily=false
```

The Gondolin debug log confirms that Discord gateway traffic is taking the raw
`tcpHosts` path:

```text
[net] tcp map 192.168.127.3:45862 gateway.discord.gg:443 -> gateway.discord.gg:443
```

The 30-minute soak completed cleanly:

```text
window:      2026-05-26T05:05:09Z through 2026-05-26T05:35:10Z
samples:     7, every 5 minutes
health:      controller ready and beta HTTP 200 at every sample
leases:      [] at every sample
discord:     1 connect/open event, 0 bad events since restart
socket:      IPv4 10.0.0.71:64045 -> 162.159.134.234:443 ESTABLISHED
             at every sample
gondolin:    no tcp session aborted / pending-write-buffer-exceeded /
             socket-write-buffer-exceeded markers
```

The soak output was written to:

```text
/tmp/beta-discord-net-debug-soak-2026-05-26.jsonl
```

This is a useful short controlled pass, not final proof that Discord is fixed.
The earlier observed failure cadence included 30-60 minute windows, so the next
validation should be a 90-minute or overnight soak with the same debug markers.

One non-blocking cleanup finding: the live boot log still prints duplicate
forced `NODE_OPTIONS` flags even after making `composeNodeOptions()` and the
OpenClaw profile export idempotent. In-VM inspection shows `/etc/profile.d`
contains the idempotent profile line, so the duplicate value is entering the
guest process environment before the profile line can normalize it. This is log
hygiene, not the remaining Discord failure, because both copies are the same
IPv4-forcing flags.

Validation run after these changes:

```text
pnpm vitest run --config vitest.config.ts \
  packages/gondolin-adapter/src/vm-adapter.test.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/gateway-interface/src/force-ipv4-egress.test.ts \
  packages/openclaw-gateway/src/openclaw-lifecycle.test.ts \
  packages/worker-gateway/src/worker-lifecycle.test.ts \
  packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts

6 files passed, 81 tests passed

pnpm check
passed
```

## 2026-05-26 06:01Z Failure During Extended Soak

The first 30-minute pass was not enough. The same beta process later reproduced
the real failure shape after about 58 minutes:

```text
opened:      2026-05-26T05:03:38.645Z
first bad:   2026-05-26T06:01:19.498Z
recovered:   2026-05-26T06:03:36.568Z
duration:    about 2m17s of 403 / 1006 reconnect churn
```

Observed OpenClaw sequence:

```text
06:01:19.498  Gateway websocket closed: 1006
06:01:21.592  Unexpected server response: 403
06:01:25.666  Unexpected server response: 403
06:01:33.707  Unexpected server response: 403
06:01:49.730  Unexpected server response: 403
06:02:19.745  Unexpected server response: 403
06:02:49.757  Unexpected server response: 403
06:03:19.774  Unexpected server response: 403
06:03:36.568  Gateway websocket opened
```

During the failure:

- controller stayed ready
- `/zones/beta/health` briefly returned HTTP 503
- `/leases` returned `[]`
- the OpenClaw/Discord socket disappeared during the burst
- Gondolin debug showed no `tcp session aborted`
- Gondolin debug showed no `pending-write-buffer-exceeded`
- Gondolin debug showed no `socket-write-buffer-exceeded`
- Gondolin debug showed no `tcp socket error`

This changes the conclusion:

- Host-process IPv4 defaults are useful and PR-worthy, but they are not the
  whole Discord stability fix.
- `webSocketUpstreamConnectTimeoutMs` and
  `webSocketUpstreamHeaderTimeoutMs` remain unrelated to this Discord path
  because `gateway.discord.gg:443` is raw `tcpHosts`, not the Gondolin
  HTTP/WebSocket bridge.
- The remaining discriminator is raw TCP socket resilience/diagnostics plus
  OpenClaw reconnect behavior after `1006 -> 403` bursts.

## Installed Gondolin Dependency Gap

The local upstream Gondolin checkout currently contains mapped-TCP keepalive,
no-delay, and socket-error logging in `host/src/qemu/net.ts`:

```text
socket.setKeepAlive(true, 30_000)
socket.setNoDelay(true)
tcp socket error ... code=... message=...
```

But the beta deployment was resolving the installed public dependency:

```text
@earendil-works/gondolin@0.12.0
```

and its installed `dist/src/qemu/net.js` did not contain those calls. That
means beta was testing the old raw TCP behavior even though the local Gondolin
source already has the right shape.

As of this writing, npm still reports `@earendil-works/gondolin` latest as
`0.12.0`; there is no newer public Gondolin package to consume directly.

## 2026-05-26 06:10Z Beta-Only Raw TCP Keepalive Experiment

To test one variable without turning a vendored patch into the agent-vm PR, the
beta deployment's installed Gondolin `dist/src/qemu/net.js` was patched in
`node_modules` only:

```text
if (session.mappedTcp) {
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  ...
}
```

The beta controller was restarted with `GONDOLIN_DEBUG=net`. Immediate evidence
from the new controller log:

```text
[agent-vm] Host network defaults: dnsResultOrder=ipv4first autoSelectFamily=false
[net] tcp map 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
[net] tcp keepalive enabled 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
```

OpenClaw connected again:

```text
2026-05-26T06:10:38.319Z connected to gateway
2026-05-26T06:10:38.601Z Gateway websocket opened
```

A longer soak is running with output at:

```text
/tmp/beta-discord-keepalive-patched-soak-2026-05-26.jsonl
```

The minimum useful signal is passing the previous 58-minute failure point. A
stronger signal is 90 minutes or overnight with zero new `1006`, `403`, or raw
TCP error markers.

Checkpoint at `2026-05-26T06:24:36Z`, about 14 minutes after the
keepalive-patched restart:

```text
controller_pid=60243
TCP 10.0.0.71:53201->162.159.133.234:443 (ESTABLISHED)
bad_since_0610=0
controller_health={"ok":true,"port":18900,"state":"ready"}
zone_health={"ok":true,"observation":"http 200","zoneId":"beta"}
leases=[]
```

Controller debug markers still show only the raw TCP map and keepalive setup,
with no `tcp socket error`, `tcp session aborted`, or buffer-limit marker:

```text
[agent-vm] Host network defaults: dnsResultOrder=ipv4first autoSelectFamily=false
[net] tcp map 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
[net] tcp keepalive enabled 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
```

## 2026-05-26 06:41Z Keepalive Experiment Failed

The beta-only raw TCP keepalive/no-delay patch did not prevent the Discord flap.
The failure reproduced about 31 minutes after the `06:10Z` restart, earlier than
the previous 58-minute failure:

```text
first_bad=2026-05-26T06:41:32.478Z discord gateway error: Error: Unexpected server response: 403
last_bad=2026-05-26T06:45:00.695Z discord gateway: Gateway websocket closed: 1006
bad_since_0610=30
```

At `2026-05-26T06:46:40Z`, while the failure was still visible:

```text
controller_health={"ok":true,"port":18900,"state":"ready"}
zone_health={"ok":false,"observation":"http 503","zoneId":"beta"}
leases=[]
```

The controller still had no Gondolin raw TCP abort/error/buffer marker. Its raw
TCP debug evidence remained limited to the original mapping and keepalive setup:

```text
[net] tcp map 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
[net] tcp keepalive enabled 192.168.127.3:43172 gateway.discord.gg:443 -> gateway.discord.gg:443
```

OpenClaw recovered through the channel health monitor rather than through raw TCP
keepalive:

```text
2026-05-26T06:45:35.485Z health-monitor: restarting (reason: disconnected)
2026-05-26T06:45:35.538Z auto-restart attempt 1/10 in 5s
2026-05-26T06:45:36.234Z connected to gateway
2026-05-26T06:45:36.465Z Gateway websocket opened
```

At `2026-05-26T06:48:35Z`, zone health had recovered:

```text
{"ok":true,"observation":"http 200","zoneId":"beta"}
```

Updated conclusion: raw TCP keepalive/no-delay is still reasonable upstream
hardening and diagnostics, but this run proves it is not sufficient as the
Discord stability fix. The most actionable next fix is OpenClaw-side reconnect
escalation and diagnostics for repeated `403`/`1006` reconnect loops.

## 2026-05-26 06:49Z Current Beta State

After the health-monitor restart, beta had recovered:

```text
2026-05-26T06:49:46Z
controller_pid=60243
TCP 10.0.0.71:56402->162.159.134.234:443 (ESTABLISHED)
counts_since_0610={
  "403": 11,
  "1006": 22,
  "opened": 2,
  "connected": 2,
  "health_restart": 1
}
first.403=2026-05-26T06:41:32.478Z
last.403=2026-05-26T06:45:30.709Z
health_restart=2026-05-26T06:45:35.485Z
last.connected=2026-05-26T06:45:36.234Z
last.opened=2026-05-26T06:45:36.465Z
controller_health={"ok":true,"port":18900,"state":"ready"}
zone_health={"ok":true,"observation":"http 200","zoneId":"beta"}
leases=[]
```

The deployment config was also checked. Beta has `websocketBypass` for
`gateway.discord.gg:443`, but no explicit OpenClaw health monitor tuning:

```text
config/system.jsonc:
  websocketBypass = ["gateway.discord.gg:443"]

config/gateways/beta/openclaw.json:
  no gateway.channelHealthCheckMinutes
  no gateway.channelStaleEventThresholdMinutes
  no gateway.channelMaxRestartsPerHour
  no channels.discord.accounts.*.gatewayRuntimeReadyTimeoutMs
```

So beta is currently using OpenClaw defaults for recovery:

```text
gateway.channelHealthCheckMinutes = 5
gateway.channelStaleEventThresholdMinutes = 30
gateway.channelMaxRestartsPerHour = 10
channels.discord.gatewayRuntimeReadyTimeoutMs = 30000
```

The observed outage recovered at roughly the 4-minute mark because the periodic
health monitor happened to run at `06:45:35Z`. Setting the monitor interval to
`1` minute is the only config-only mitigation that directly shortens this
class of outage today.

## Second Opinion Consensus After Keepalive Failure

DeepWiki, Gemini, Claude, and local source tracing now agree on the main shape:

- `1006` is treated as resumable because it is not in
  `nonResumableGatewayCloseCodes`
- the reconnect path keeps `sessionId`, `resumeGatewayUrl`, and `sequence`
  after `1006`
- a rejected RESUME WebSocket upgrade surfaces as `Error: Unexpected server
  response: 403` followed by another `1006`
- the gateway then schedules another resumable reconnect against the same
  resume state
- the loop runs until a retry happens to succeed, max reconnect attempts are
  exhausted, or the provider health monitor restarts Discord

The highest-leverage OpenClaw patch is now clear:

1. Track consecutive failed resume attempts.
2. Record WebSocket HTTP upgrade rejection status such as `403`.
3. After a small threshold, reset session state and force the next reconnect to
   use fresh IDENTIFY.
4. Emit the already-supported debug markers:

```text
Gateway reconnect scheduled in ...
Gateway forcing fresh IDENTIFY after ...
```

5. Add jitter to close-path reconnects so multiple bots do not retry in lockstep.

This beats only lowering `maxAttempts`: lowering attempts makes the health
monitor/provider restart happen sooner, but it still relies on a heavier restart
instead of fixing the stale-resume loop inside the gateway lifecycle.

Second-opinion outputs:

```text
/tmp/gemini-analysis/discord-flap-after-keepalive/result.md
/tmp/claude-analysis/discord-flap-after-keepalive/result.md
```

## Immediate Deployment Mitigation

Until OpenClaw has the reconnect escalation patch, the safest deployment
mitigation is explicit health-monitor tuning:

```jsonc
{
  "gateway": {
    "channelHealthCheckMinutes": 1,
    "channelStaleEventThresholdMinutes": 5,
    "channelMaxRestartsPerHour": 20
  }
}
```

Tradeoffs:

- This reduces likely outage windows from roughly 4-5 minutes to roughly 1-2
  minutes.
- It does not stop the first `1006` or the repeated `403` loop.
- Very low stale thresholds can cause restarts during quiet periods, but the
  Discord provider records transport activity on inbound gateway frames, so a
  5-minute stale threshold is a reasonable starting floor.
- Increase `channelMaxRestartsPerHour` when lowering the interval so a temporary
  Discord-side incident does not exhaust the restart budget too quickly.

## 2026-05-26 07:00Z Health-Tuned Beta Restart

After the beta-only raw TCP keepalive/no-delay experiment reproduced the flap,
the beta OpenClaw config was changed to use the mitigation above:

```jsonc
{
  "gateway": {
    "channelHealthCheckMinutes": 1,
    "channelMaxRestartsPerHour": 20,
    "channelStaleEventThresholdMinutes": 5
  }
}
```

Validation passed before restart:

```text
pnpm validate
```

Beta was then restarted with the same debug environment and the beta-only
Gondolin keepalive/no-delay patch still present in installed `node_modules`.
Controller log:

```text
/Users/shravansunder/.agent-vm/runtime/zones/beta/logs/controller-start-gondolin-net-debug-20260526T070024Z-health-tuned.log
```

Startup markers:

```text
[agent-vm] Host network defaults: dnsResultOrder=ipv4first autoSelectFamily=false
[net] tcp map 192.168.127.3:56862 gateway.discord.gg:443 -> gateway.discord.gg:443
[net] tcp keepalive enabled 192.168.127.3:56862 gateway.discord.gg:443 -> gateway.discord.gg:443
2026-05-26T07:00:34.351Z connected to gateway
2026-05-26T07:00:34.696Z Gateway websocket opened
```

A bounded 15-minute passive watch then sampled controller health, beta zone
health, Discord bad-event counts, restart counts, and live TCP socket presence:

```text
/tmp/beta-health-tuned-watch-2026-05-26.jsonl
```

Result:

```text
samples:             15/15 clean
window:              2026-05-26T07:01:12Z .. 2026-05-26T07:15:15Z
403 count:           0
1006 count:          0
health restarts:     0
tcp error markers:   0
discord socket:      present in every sample
controller health:   ready in every sample
zone health:         HTTP 200 in every sample
leases:              []
```

This proves only that the health-tuned restart was healthy and did not
immediately regress Discord connectivity. It does not prove the underlying
30-60 minute flap is fixed. The next meaningful beta observation is what happens
when the next `1006`/`403` burst appears: with this config, the expected success
criterion is recovery in roughly 1-2 minutes through the health monitor, not
absence of the initial abnormal close.

A later read-only check around `2026-05-26T07:23Z` still showed controller
ready, beta zone health HTTP 200, no active leases, and zero `403`/`1006`
markers in the OpenClaw log since the `07:00Z` restart.

## OpenClaw Reconnect Findings

OpenClaw's Discord gateway implementation treats close code `1006` as
resumable:

```text
canResumeAfterGatewayClose(code) returns true unless the code is one of:
NotAuthenticated, InvalidSeq, SessionTimedOut, AlreadyAuthenticated
```

The close handler therefore schedules a resume reconnect after `1006`.
Separately, OpenClaw has logging/tests for messages such as:

```text
Gateway reconnect scheduled in ...
Gateway forcing fresh IDENTIFY after ...
```

but the inspected `extensions/discord/src/internal/gateway.ts` implementation
does not emit those messages from `scheduleReconnect()`. The live logs likewise
show close/error/open markers but no reconnect-mode diagnostics.

This is not proven to be the root cause, but it is a concrete OpenClaw follow-up:

- log reconnect delay, cause, and `resume=true/false`
- log whether reconnect uses `resume_gateway_url` or the base gateway URL
- log heartbeat send/ack timing around abnormal close
- after repeated failed resume attempts or repeated 403 handshakes, consider
  resetting session state and forcing a fresh IDENTIFY with jittered backoff
- keep Discord identify concurrency/rate-limit constraints explicit in tests

## 2026-05-26 OpenClaw Reconnect Candidate

Latest `origin/main` for OpenClaw already includes a nearby stale-socket fix:
`handlePayload()` now receives the source socket and
`identifyWithConcurrency()` ignores stale sockets before sending IDENTIFY. That
means the reconnect candidate should be based on current `main`, not the older
source snapshot used earlier in this investigation.

A clean OpenClaw worktree was created from `origin/main`:

```text
/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw-discord-ws-reconnect
branch: codex/discord-ws-reconnect
base:   4beadbf9519ef45d2b9cf74dbb60c4b75af3a48e
```

The tested candidate changes only `extensions/discord/src/internal/gateway.ts`
and `extensions/discord/src/internal/gateway.test.ts`:

1. Parse `Error: Unexpected server response: 403` as a WebSocket HTTP upgrade
   rejection.
2. Count only consecutive resume attempts that fail with HTTP 4xx upgrade
   rejection.
3. After three such failed resume attempts, clear `sessionId`,
   `resumeGatewayUrl`, and `sequence`, then schedule the next reconnect with
   `resume=false`.
4. Preserve normal `1006` resume behavior when the abnormal close is not part
   of a repeated 4xx upgrade-rejection sequence.
5. Emit the existing lifecycle/debug vocabulary:

```text
Gateway reconnect scheduled in ... (close=1006, resume=true|false)
Gateway forcing fresh IDENTIFY after 3 failed resume attempts
```

The first new test was red against current `origin/main`:

```text
expected [ true, true, true, true ] to deeply equal [ true, true, true, false ]
```

That proves current OpenClaw keeps retrying RESUME after repeated
`403`/`1006` resume-upgrade failures.

Focused proof after the candidate patch:

```text
node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-discord.config.ts extensions/discord/src/internal/gateway.test.ts
  1 file passed, 23 tests passed

pnpm exec oxfmt --check --threads=1 extensions/discord/src/internal/gateway.ts extensions/discord/src/internal/gateway.test.ts
  passed

node scripts/run-oxlint.mjs --tsconfig config/tsconfig/oxlint.extensions.json extensions/discord/src/internal/gateway.ts extensions/discord/src/internal/gateway.test.ts
  passed

pnpm tsgo:extensions:test
  passed

git diff --check
  passed
```

This is now the strongest root-fix candidate. It is not yet live-proven in beta
because beta is still running the published OpenClaw package plus config
mitigation. To live-test this candidate, package/install this OpenClaw branch
into beta or consume a published OpenClaw build that includes it, then wait for
the next historical 30-60 minute flap window. The expected evidence after fix is
not "the initial `1006` can never happen"; it is "after repeated 403 resume
upgrade failures, the gateway logs forced fresh IDENTIFY and reconnects without
waiting for the provider health monitor restart."

## Second Opinion Pass After 06:01Z Reproduction

DeepWiki, Gemini, and Claude were asked again after the 58-minute beta failure
was captured.

Consensus:

- Gondolin WebSocket upstream connect/header timeouts are not relevant to the
  Discord `gateway.discord.gg:443` path because that path is raw `tcpHosts`.
- Guest `NODE_OPTIONS` and host-side Node defaults are different process
  boundaries; both are worth keeping.
- The most testable network-side fix is mapped raw TCP keepalive/no-delay plus
  socket error detail, validated with a soak that runs past the historical
  30-60 minute failure window.
- The most testable OpenClaw recovery fix is reconnect escalation: after
  repeated failed RESUME attempts or repeated 403 handshakes, reset session
  state and force fresh IDENTIFY with jittered backoff. Do not reclassify the
  first `1006` as non-resumable globally.

Important nuance from the second pass:

- The agent-vm host-default PR should not claim to fix Discord by itself. The
  06:01Z reproduction happened after host IPv4 defaults were active and the
  live Discord socket was IPv4.
- The beta-only raw TCP keepalive patch is an experiment. It is not evidence
  that the published `@earendil-works/gondolin@0.12.0` already has the raw TCP
  behavior.
- 30-second WebSocket bridge defaults are useful hardening for HTTP-mediated
  WebSockets, but they are deliberately orthogonal to the Discord bypass and
  should wait for a clean public SDK surface.

Second-opinion output files:

```text
/tmp/claude-analysis/discord-gondolin-ws/result.md
/tmp/gemini-analysis/discord-gondolin-ws/result.md
```

## 2026-05-26 Beta Live Test With Patched OpenClaw

Beta was rebuilt with a local OpenClaw 2026.5.26 root package and a local
`@openclaw/discord` reconnect-candidate package.

The first Discord package tarball was malformed: it packed
`dist/extensions/discord`, whose `index.js` imports root OpenClaw chunks by
relative path. In the gateway image this failed at plugin load:

```text
[plugins] discord failed to load ... Cannot find module '../../channel-entry-contract-BWEkW9ct.js'
```

That tarball was replaced with a package-local runtime build:

```text
node scripts/lib/plugin-npm-runtime-build.mjs extensions/discord
node scripts/lib/plugin-npm-package-manifest.mjs --run extensions/discord -- npm pack --pack-destination ../../tmp/agent-vm-websocket-live-pack
```

The corrected tarball was verified in a fresh temp install:

```text
import @openclaw/discord/dist/index.js
=> {"entryType":"object","entryId":"discord","entryName":"Discord"}
```

The corrected beta image build showed:

```text
openclaw local reconnect packages installed 2026.5.26 2026.5.26
```

Startup after the corrected package was valid:

```text
2026-05-26T07:40:25Z [plugins] loading discord from ... @openclaw+discord@file+...
2026-05-26T07:40:27Z [plugins] loaded 6 plugin(s) (6 attempted)
2026-05-26T07:40:29Z discord gateway: Gateway websocket opened
```

At 08:02Z the socket still closed abnormally, but the failure shape changed:

```text
2026-05-26T08:02:06Z discord gateway: Gateway websocket closed: 1006
2026-05-26T08:02:06Z discord gateway: Gateway reconnect scheduled in 2000ms (close=1006, resume=true)
2026-05-26T08:03:53Z discord: gateway READY wait timed out after 15000ms; reconnecting with backoff (attempt 1)
2026-05-26T08:03:59Z discord gateway: Gateway websocket opened
```

There were no `403` responses in this cycle. The host-side Gondolin debug log
showed the more important clue:

```text
[net] tcp socket error ... gateway.discord.gg:443 -> gateway.discord.gg:443 code=ETIMEDOUT message=read ETIMEDOUT
[net] tls sni gateway-us-east1-c.discord.gg
[error] getaddrinfo ENOTFOUND gateway-us-east1-c.discord.gg
```

Interpretation:

- The original canonical gateway host was correctly raw TCP bypassed.
- Discord's `resume_gateway_url` can be regional, here
  `gateway-us-east1-c.discord.gg`.
- Beta only had `gateway.discord.gg:443` in `websocketBypass`.
- Gondolin `tcp.hosts` explicitly rejects wildcards, so a raw passthrough
  wildcard cannot be expressed through today's `websocketBypass` surface.
- Wildcards such as `*.discord.gg`, `*.discord.com`, `*.discord.media`,
  `*.discordapp.com`, and `*.discordapp.net` are valid for agent-vm
  `egressHosts`, but not for Gondolin raw `tcpHosts`.

Beta config was then adjusted:

```json
{ "host": "discord.com", "audience": "both" }
{ "host": "*.discord.com", "audience": "both" }
{ "host": "discord.gg", "audience": "both" }
{ "host": "*.discord.gg", "audience": "both" }
{ "host": "discord.media", "audience": "both" }
{ "host": "*.discord.media", "audience": "both" }
{ "host": "discordapp.com", "audience": "both" }
{ "host": "*.discordapp.com", "audience": "both" }
{ "host": "*.discordapp.net", "audience": "both" }

"websocketBypass": [
  "gateway.discord.gg:443",
  "gateway-us-east1-b.discord.gg:443",
  "gateway-us-east1-c.discord.gg:443",
  "gateway-us-east1-d.discord.gg:443"
]
```

`pnpm validate` passed after that config edit.

After restart, beta loaded the patched Discord package, connected, and opened
the gateway socket:

```text
2026-05-26T08:09:38Z [plugins] loading discord from ... @openclaw+discord@file+...
2026-05-26T08:09:40Z [plugins] loaded 6 plugin(s) (6 attempted)
2026-05-26T08:09:42Z discord gateway: Gateway websocket opened
```

A 45-minute regional-bypass soak from 08:09Z to 08:55Z stayed clean:

```text
health:         ok throughout
leases:         []
403:            0
1006:           0
opened:         1
forced identify:0
reconnect:      0
READY timeout:  0
load failures:  0
```

The latest evidence points to two different fix tracks:

1. Agent-vm config/defaults/docs should account for Discord regional resume
   gateway hosts. Exact regional bypass is a beta mitigation; upstream-quality
   support probably needs wildcard-capable raw TCP bypass in Gondolin/adapter,
   or OpenClaw must avoid regional `resume_gateway_url` when running behind an
   exact-host raw passthrough.
2. The OpenClaw reconnect candidate is still useful, but the 08:02Z repro did
   not exercise its 403-escalation path. It only proved that repeated 403 was
   not the only recovery hazard; regional resume host reachability is another.
