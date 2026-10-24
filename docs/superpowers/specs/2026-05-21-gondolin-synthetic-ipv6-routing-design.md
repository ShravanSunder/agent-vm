# 2026-05-21 — Gondolin Synthetic IPv6 Routing — IPv4-Preference Fix

**Status:** Draft — design proposed; codex skeptical-validation completed (medium-high confidence; merge-order finding folded in); implementation plan not yet written.
**Author:** Shravan Sunder (Codex / Claude collaboration).
**Branch:** `fix/gondolin-synthetic-ipv6-routing`.
**Driving incident:** `shravan-claw@0ddf5f2` debug doc (`docs/wip/debugging/2026-05-21-lease-keepalive-400-and-discord-403-ipv6-race.md`).

---

## TL;DR

Bake `/etc/gai.conf` into all `agent-vm` managed-base images via a shared helper, and always set `NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection` + `GODEBUG=netdns=cgo` from `gondolin-adapter`'s `createManagedVm`. Together these cover Node, Python, Go, Ruby, C, and system-resolver Rust inside any VM that uses gondolin's synthetic DNS + tcpHosts. Hickory-DNS in Rust is documented as a known gap. The fix is unconditional, harmless when tcpHosts isn't set, and trivially reversible.

---

## Problem statement

Inside any VM created by `agent-vm` with `tcpHosts` set, outbound HTTP requests using Node fetch fail intermittently (~5–20% under sequential load):

- The controller lease keepalive endpoint returns plain-text `400 Bad Request` (16 bytes) instead of JSON, causing the in-VM plugin to throw and abort tool calls.
- Discord WebSocket handshakes return `403 Forbidden`, causing reconnect loops.

Both failures share a single root cause. Full mechanics and source citations live in `shravan-claw@0ddf5f2:docs/wip/debugging/2026-05-21-lease-keepalive-400-and-discord-403-ipv6-race.md`.

---

## Background — the contract gap

`gondolin-adapter`, when given a non-empty `tcpHosts` map, configures gondolin with `dns.mode: 'synthetic'` and `syntheticHostMapping: 'per-host'`. This produces:

- **A records**: per-host IPv4 in `198.19.0.0/16`. Each virtual hostname (e.g. `controller.vm.host`, `gateway.discord.gg`) gets a unique IPv4 address, registered in gondolin's `SyntheticDnsHostMap` for reverse lookup.
- **AAAA records**: a single shared `::ffff:198.18.0.1` for every virtual hostname. **Not registered** in `SyntheticDnsHostMap`.

The shared AAAA was added deliberately (commit `18925e5`, 2026-05-10) to satisfy OpenClaw's SSRF policy, which validates every DNS answer before allowing a fetch. OpenClaw's `src/shared/net/ip.ts:283-287` normalizes `::ffff:N.N.N.N` to `N.N.N.N` for the policy check, and `src/infra/net/ssrf.test.ts:284-289` confirms `::ffff:198.18.0.1` passes under `allowRfc2544BenchmarkRange: true`. The design intent (recorded in `agent-vm:docs/superpowers/plans/2026-05-10-discord-media-synthetic-ipv6.md:9, 25` and `agent-vm:docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md:21–23`) was that the AAAA would never carry actual TCP traffic: "Forced guest IPv6 is not expected to provide general egress."

What the design did not account for: Node 20+'s built-in `fetch` (via `undici`) defaults to `autoSelectFamily: true` (Happy Eyeballs, RFC 8305). It races IPv4 and IPv6 connects in parallel. When the IPv6 race wins, the L4 connection completes (gondolin accepts the connect on the synthetic address), but gondolin's `tcp.hosts` reverse-lookup at `gondolin/host/src/qemu/net.ts:887` returns `null`, the connection falls into the HTTP/TLS MITM, and one of two branches in `gondolin/host/src/qemu/http.ts:1077-1085` emits the failure.

---

## Root cause

```
                  Node fetch / undici
                  in gateway VM
                          │
                          │ dns.lookup()
                          ▼
                  ┌──────────────────┐
                  │ A: 198.19.0.x    │ ◄── per-host
                  │ AAAA: shared     │     reverse-lookable
                  │   ::ffff:198.    │
                  │   18.0.1         │ ◄── shared
                  └──────────────────┘     NOT reverse-lookable
                          │
                          │ Happy Eyeballs race
                          ▼
                ┌─────────┴─────────┐
                ▼                   ▼
         IPv4 wins             IPv6 wins
         (~80-95%)             (~5-20%)
                │                   │
                │                   │ no reverse-lookup,
                │                   │ no tcp.hosts bypass
                │                   ▼
                │             protocol sniff
                │           ┌───────┴────────┐
                │           ▼                ▼
                │      HTTP MITM        TLS MITM
                │           │                │
                │           ▼                ▼
                │     upstream fetch    SNI not in
                │     fails             allowedHosts
                │           │                │
                │           ▼                ▼
                │     catch-all 400     policy 403
                │
                ▼
        controller serves JSON / Discord WSS completes
```

---

## Scope

### In scope

- **Image layer**: shared helper in `agent-vm` that bakes `/etc/gai.conf` into all managed-base image rootfs.
- **Runtime layer**: `gondolin-adapter` unconditionally injects `NODE_OPTIONS` and `GODEBUG` env vars into every VM's process env via `createManagedVm`.
- **Test coverage**: unit tests for the helper and the env injection; integration repro of the original failure showing 0% IPv6 wins after fix.
- **Documentation**: update the 2026-05-10 canary doc to add Node Happy Eyeballs as a regression vector, and update the gondolin-vm-layer subsystem doc.

### Out of scope

- **Upstream gondolin per-host AAAA support.** Tracked separately; a future spec/PR in gondolin would extend `SyntheticDnsHostMappingMode` to allocate per-host `::ffff:198.19.x.y` and register them in `SyntheticDnsHostMap`. When that lands, the env vars become redundant and can be dropped (gai.conf remains harmless).
- **Hickory-DNS** (pure-Rust resolver) in Rust. Hickory bypasses glibc's `getaddrinfo` and ignores `/etc/gai.conf`. We don't ship Hickory today. If a future plugin uses it, the plugin owns the in-code family preference.
- **Deno, Bun, or other non-Node JavaScript runtimes.** Not in our stack.
- **Application-level fixes** (e.g., patching `controller-lease-client.ts` with a custom undici Agent). The platform-level fix covers all callers; per-application patches would duplicate the policy.

---

## Design alternatives considered

Four candidates were evaluated. Full tradeoff matrix is in the shravan-claw debug doc (`0ddf5f2`); summary here:

| ID | Approach | Where | Coverage | Reversible | Why not chosen |
|----|----------|-------|----------|------------|----------------|
| A | `NODE_OPTIONS=--dns-result-order=ipv4first` in lifecycle env | `openclaw-lifecycle.ts` + `worker-lifecycle.ts` | Node only, ~99% (Happy Eyeballs can still race if IPv4 connect > 250 ms) | trivially | Doesn't fully close the race; Node-only; duplicated across lifecycles |
| B | A + `--no-network-family-autoselection` in lifecycle env | same | Node 100% (race disabled entirely) | trivially | Same locality problems as A; doesn't cover non-Node runtimes |
| C | Surgical undici Agent with `connect: { family: 4 }` in `controller-lease-client.ts` | `openclaw-agent-vm-plugin` | Plugin paths only; other Node code still races | trivially | Per-application patch leaks policy into every Node consumer separately; doesn't help Discord WSS path or worker-gateway |
| D | Upstream gondolin: per-host AAAA in `SyntheticDnsHostMap` | `gondolin` + `agent-vm` adapter opt-in | 100% architecturally | yes | Slowest; separate repo; separate release cycle; deferred to follow-up spec |
| **β (chosen)** | **Shared image helper + always-on env vars** | **`agent-vm` managed-base images + `gondolin-adapter`** | **Node, Python, Go, Ruby, C, system-resolver Rust** | **trivially** | — |

Why β is correct:

- One centralized place per concern: gai.conf in the image (constant), env vars in the adapter (process-level).
- Covers every language we use today (Node) and every language we might plausibly use tomorrow (Python, Go, Ruby) without per-application patches.
- Unconditional, so no "did we remember to set this for the new VM type?" risk.
- Harmless when tcpHosts isn't set — there's no IPv6 race to defeat, and gai.conf only re-ranks IPv4-mapped IPv6 (a range that doesn't appear in normal DNS responses).
- Reversible by dropping the env vars; gai.conf stays harmless even when no longer needed.

---

## Recommended approach

### Part 1 — Shared image helper bakes `/etc/gai.conf`

A new helper module in `agent-vm` exports the gai.conf file specification. `managed-image-dockerfile.ts` uses it for all three managed bases.

**Contents of `/etc/gai.conf`**:

```
precedence ::ffff:0:0/96 100
```

Per RFC 6724 §10.3 this is the administrator-canonical "prefer IPv4" recipe. It bumps the precedence of IPv4-mapped IPv6 addresses from the default `10` to `100`, which is above `::/0`'s default `40`. Per RFC 6724 sort rules, this causes `getaddrinfo` to return plain IPv4 addresses before plain IPv6 addresses for any caller using glibc's resolver.

**Single-line vs full-table** (per `gai.conf(5)`): an uncommented `precedence` line replaces the entire default precedence table at parse time. The single-line form is conventional and works for the common case, but the safer form ships the full default table with the bumped line. We will pick during plan-writing based on a `getent ahosts <synthetic-host>` validation inside a test image:

- if the single-line form gives correct ordering ▸ ship it (less surface)
- if the parse-replace behavior loses needed defaults ▸ ship the full table

**Coverage by this rule alone**:

- Python (stdlib + `requests` + `urllib3` + `httpx` + `aiohttp` when using the system resolver)
- Ruby's `Socket.getaddrinfo`
- Go when using the cgo resolver (`GODEBUG=netdns=cgo`)
- system-resolver Rust (default `tokio` + `reqwest` + `hyper` when not using Hickory)
- C / C++ programs calling `getaddrinfo(3)`

**Coverage gaps**:

- Node bypasses gai.conf via Happy Eyeballs even when `dns.lookup()` returns IPv4 first — needs explicit env var (Part 2).
- Hickory-DNS pure-Rust resolver bypasses gai.conf entirely — out of scope.
- Go's `net.Dialer` Fast Fallback (Happy Eyeballs at the Go level) is **independent of DNS order**. Even with IPv4 ranked first, a slow IPv4 connect can still trigger a parallel IPv6 attempt. Needs live canary verification — see Testing strategy.

### Part 2 — Shared canonical-env helper in `agent-vm`

**Codex validation surfaced a real merge-order problem** with the original "inject from gondolin-adapter only" approach:

- `gondolin-adapter/src/vm-adapter.ts:302-304` merges env as `{ ...hookBundle.env, ...options.env }` — caller env wins.
- `openclaw-gateway/src/openclaw-lifecycle.ts:101` already exports `NODE_OPTIONS=--dns-result-order=ipv4first` into the shell profile, and `:532` sets the same narrower value in the VM env spec.
- If the adapter injects the broader `--dns-result-order=ipv4first --no-network-family-autoselection` value, the gateway's narrower value at `:532` overrides it. The load-bearing `--no-network-family-autoselection` flag never reaches the process.

`NODE_OPTIONS` and `GODEBUG` are **compositional** env vars (whitespace-separated and comma-separated flag lists respectively). Naive object-merge replacement loses information. The fix is to centralize the canonical value as a shared constant so every lifecycle that sets these vars uses the same string.

**Shared helper**: `packages/agent-vm/src/build/force-ipv4-egress.ts` exports:

```typescript
export const FORCE_IPV4_EGRESS_NODE_OPTIONS =
  '--dns-result-order=ipv4first --no-network-family-autoselection';

export const FORCE_IPV4_EGRESS_GODEBUG = 'netdns=cgo';
```

Each call site (currently three identified) imports + uses the constant rather than hardcoding the flag string.

**Call sites to update**:

| File | Line(s) | Current | After |
|------|---------|---------|-------|
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | 101 (shell profile) | `export NODE_OPTIONS=--dns-result-order=ipv4first` | `export NODE_OPTIONS='${FORCE_IPV4_EGRESS_NODE_OPTIONS}'` |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | 532 (VM env spec) | `NODE_OPTIONS: '--dns-result-order=ipv4first'` | `NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS` |
| `packages/worker-gateway/src/worker-lifecycle.ts` | env block (no current NODE_OPTIONS) | n/a | add `NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS` |
| `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` | env block (no current NODE_OPTIONS) | n/a | add `NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS` |
| same three lifecycles | env block | no current GODEBUG | add `GODEBUG: FORCE_IPV4_EGRESS_GODEBUG` (compose with existing if any) |

**Why call-site updates rather than adapter-only injection**:

- adapter-only would be overridden by the gateway's existing narrower value (the merge-order problem).
- shared-constant + per-lifecycle import gives every consumer the canonical value without code duplication of the flag string.
- test verifies the constant ends up in the final VM env spec, regardless of merge order.

**GODEBUG composition note**: if a future caller needs to set additional GODEBUG flags (e.g. `race=1` for race detector or `gctrace=1`), they must compose into the existing value: `GODEBUG: '${FORCE_IPV4_EGRESS_GODEBUG},race=1'`. Document this in the helper module's docstring.

### Part 3 — Apply to all base images

- `openclaw-gateway` base — gai.conf via `managed-image-dockerfile.ts`
- `tool-vm` base — gai.conf via `managed-image-dockerfile.ts`
- `worker-gateway` base — gai.conf via `managed-image-dockerfile.ts`

The env vars are picked up per-lifecycle by importing the shared constant.

### Part 4 — Custom imagePath VMs (known limitation)

VMs created with a custom `imagePath` (rather than a managed base) will not get gai.conf baked in. They will still benefit from the env vars (which come from `gondolin-adapter` + lifecycle), but glibc-resolver consumers in those custom images won't have the IPv4-preference rule.

This is documented as a known limitation. Consumers using custom images own their own gai.conf provisioning, the same way they own the rest of their image rootfs.

---

## Implementation outline

(Detailed plan with task-by-task steps lives in `docs/superpowers/plans/2026-05-21-*-plan.md` after this spec is approved.)

### File-level changes

```
packages/agent-vm/src/build/                 NEW
  force-ipv4-egress.ts                         shared helper
                                               exporting:
                                                 ▸ gai.conf
                                                   contents +
                                                   Dockerfile
                                                   snippet
                                                 ▸ FORCE_IPV4_
                                                   EGRESS_NODE_
                                                   OPTIONS
                                                   constant
                                                 ▸ FORCE_IPV4_
                                                   EGRESS_GODEBUG
                                                   constant
  force-ipv4-egress.test.ts                    unit tests

packages/agent-vm/src/build/                 MODIFY
  managed-image-dockerfile.ts                  inject gai.conf
                                               via shared helper
                                               into every managed
                                               base ('openclaw-
                                               gateway', 'tool-vm',
                                               'worker-gateway')

packages/agent-vm/src/build/                 MODIFY
  managed-base-dockerfiles.test.ts             assert gai.conf
                                               instruction appears
                                               in all three base
                                               Dockerfiles

packages/openclaw-gateway/src/               MODIFY (~4 lines
  openclaw-lifecycle.ts                        across 2 sites)
                                                 ▸ line ~101
                                                   shell profile
                                                   export
                                                 ▸ line ~532
                                                   VM env spec
                                               both use the
                                               shared constant

packages/worker-gateway/src/                 MODIFY (~2 lines)
  worker-lifecycle.ts                          add NODE_OPTIONS +
                                               GODEBUG using
                                               shared constants
                                               in env block

packages/agent-vm/src/tool-vm/               MODIFY (~2 lines)
  tool-vm-lifecycle.ts                         add NODE_OPTIONS +
                                               GODEBUG using
                                               shared constants
                                               in env block

packages/gondolin-adapter/src/               NO CHANGE this PR
  vm-adapter.ts                                (codex finding:
                                               adapter injection
                                               would be overridden
                                               by lifecycle env;
                                               fix at call site
                                               instead)

docs/
  superpowers/specs/                         (this file)
    2026-05-21-gondolin-synthetic-ipv6-
    routing-design.md
  superpowers/plans/                         NEW (plan)
    2026-05-21-...
  wip/debugging/                             AMEND
    2026-05-10-openclaw-discord-media-
    synthetic-dns-canary.md
  subsystems/                                AMEND
    gondolin-vm-layer.md
```

### Helper module shape

```typescript
// packages/agent-vm/src/build/force-ipv4-egress.ts
//
// Single source of truth for the IPv4-preference rule baked
// into managed-base Docker images.

export const FORCE_IPV4_EGRESS_GAI_CONF = 'precedence ::ffff:0:0/96 100\n';

export const FORCE_IPV4_EGRESS_GAI_CONF_PATH = '/etc/gai.conf';

/**
 * Returns the Dockerfile snippet that writes the gai.conf rule
 * into the image rootfs.  Shape matches existing snippet helpers
 * in managed-image-dockerfile.ts.
 */
export function forceIpv4EgressDockerfileSnippet(): string {
  return [
    `# Force IPv4-preferred egress for synthetic-DNS+tcpHosts VMs.`,
    `# See docs/superpowers/specs/2026-05-21-gondolin-synthetic-`,
    `# ipv6-routing-design.md`,
    `RUN printf '${FORCE_IPV4_EGRESS_GAI_CONF}' > ${FORCE_IPV4_EGRESS_GAI_CONF_PATH} \\`,
    `    && chmod 644 ${FORCE_IPV4_EGRESS_GAI_CONF_PATH}`,
  ].join('\n');
}
```

(Exact integration shape — Dockerfile snippet vs file spec — to be confirmed against existing `managed-image-dockerfile.ts` patterns during plan-writing.)

### Lifecycle env additions

Each lifecycle imports the shared constants from `agent-vm/src/build/force-ipv4-egress.ts` and uses them in its env block. Example for the openclaw-gateway lifecycle:

```typescript
// packages/openclaw-gateway/src/openclaw-lifecycle.ts (excerpt, line ~532)
import {
  FORCE_IPV4_EGRESS_NODE_OPTIONS,
  FORCE_IPV4_EGRESS_GODEBUG,
} from '@agent-vm/agent-vm/build/force-ipv4-egress';

return {
  env: {
    HOME: '/home/openclaw',
    NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
    NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,    // was '--dns-result-order=ipv4first'
    GODEBUG: FORCE_IPV4_EGRESS_GODEBUG,              // new
    OPENCLAW_CONFIG_PATH: effectiveOpenClawConfigVmPath,
    // ...
  },
  // ...
};
```

And in the shell profile written at line ~101:

```typescript
// packages/openclaw-gateway/src/openclaw-lifecycle.ts (excerpt, line ~101)
const environmentLines = [
  'export OPENCLAW_HOME=/home/openclaw',
  // ...
  `export NODE_OPTIONS='${FORCE_IPV4_EGRESS_NODE_OPTIONS}'`,
  `export GODEBUG='${FORCE_IPV4_EGRESS_GODEBUG}'`,
  // ...
];
```

Worker and tool-vm lifecycles get a minimal env-block addition (both currently set no NODE_OPTIONS / GODEBUG):

```typescript
// packages/worker-gateway/src/worker-lifecycle.ts (excerpt)
env: {
  // ...existing env...
  NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,
  GODEBUG: FORCE_IPV4_EGRESS_GODEBUG,
},
```

```typescript
// packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts (excerpt)
env: {
  // ...existing env...
  NODE_OPTIONS: FORCE_IPV4_EGRESS_NODE_OPTIONS,
  GODEBUG: FORCE_IPV4_EGRESS_GODEBUG,
},
```

---

## Testing strategy

### Unit

- `force-ipv4-egress.test.ts`: helper returns expected gai.conf contents + Dockerfile snippet; canonical NODE_OPTIONS and GODEBUG constants exported.
- `managed-base-dockerfiles.test.ts`: assert gai.conf instruction appears in all three managed-base Dockerfiles.
- Per-lifecycle tests (`openclaw-lifecycle.test.ts`, `worker-lifecycle.test.ts`, `tool-vm-lifecycle.test.ts`): assert `NODE_OPTIONS` in the final VM env spec equals `FORCE_IPV4_EGRESS_NODE_OPTIONS` (both flags present), and `GODEBUG` equals `FORCE_IPV4_EGRESS_GODEBUG`.

### Pre-build validation (gai.conf parse behavior)

Before baking gai.conf into the image, run `getent ahosts <synthetic-hostname>` inside a test image built with the single-line form. Verify:

- the IPv4 address appears first in the result.
- no default ordering regressions for non-RFC2544 destinations (e.g. `getent ahosts example.com`).

If the single-line form regresses ordering for any tested destination, ship the full-table form (default precedence table + bumped `::ffff:0:0/96 100` line).

### Integration (manual, in-VM)

- **Before-fix baseline**: 20-curl repro from inside the gateway VM (via the controller's `POST /zones/<zoneId>/execute-command` endpoint) — expect ~4/20 IPv6 wins / 400 responses (matches `shravan-claw@0ddf5f2` repro data).
- **After-fix verification**:
  - `cat /etc/gai.conf` matches the helper's output.
  - `env | grep -E 'NODE_OPTIONS|GODEBUG'` shows both vars with the canonical values.
  - 20-curl repro shows 0/20 IPv6 wins.
  - `getent ahostsv4 controller.vm.host` shows the per-host IPv4.
  - `getent ahostsv6 controller.vm.host` still shows the synthetic AAAA (SSRF compatibility preserved).

### Live Go Fast Fallback canary (new, per codex)

`GODEBUG=netdns=cgo` + gai.conf gives Go IPv4-first DNS ordering, but Go's `net.Dialer` Fast Fallback (RFC 8305 Happy Eyeballs at the Go level) is independent and may still launch a parallel IPv6 attempt if the IPv4 connect is slow. Verify the race is suppressed in practice:

- write a small Go probe that does `net.DialTimeout("tcp", "controller.vm.host:18800", 5*time.Second)` in a loop, and logs the remote address used.
- run it inside a test gateway VM with the fix applied; expect 0% IPv6 connect destinations in the log.
- if non-zero, the spec needs a follow-up to either set `net.Dialer.FallbackDelay: -1` in Go consumers (in-code, not env) or accept the residual risk as low-frequency.
- this is the only "we don't yet know for sure" item in the design.

### Regression

- Re-run the 2026-05-10 OpenClaw Discord media SSRF canary doc (`docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md`). Verify:
  - AAAA still returned by gondolin synthetic DNS (`getent ahostsv6 controller.vm.host`).
  - OpenClaw's SSRF check still passes for Discord media URLs.
  - Bot media downloads work end-to-end.
- Observe Discord WSS reconnect rate 24h post-deploy. Expect close to zero gateway 403s (modulo unrelated bot-token or rate-limit issues).

---

## Rollout

1. Land this spec and the implementation plan on the `fix/gondolin-synthetic-ipv6-routing` branch.
2. Merge to `master`; publish `agent-vm@0.0.70` (or whatever the next semver bump is).
3. Update `shravan-claw`'s `package.json` to consume the new agent-vm.
4. Run `pnpm install` and rebuild VM images (`agent-vm build`).
5. Restart the gateway at a convenient time. Active sessions terminate; Discord bots reconnect.
6. Monitor for 24 hours:
   - lease keepalive 400 count in `~/.agent-vm/runtime/zones/<zone>/logs/`
   - Discord gateway 403 count in the same logs
   - both should drop to ≈ 0 (excluding unrelated upstream issues).

---

## Risks and reversibility

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| A future IPv6-only destination needs egress | very low (gondolin has no IPv6 path today; would require gondolin upstream changes first) | medium (single destination would fail) | drop the env vars and the shared-constant import; `autoSelectFamily` reactivates; gai.conf is harmless |
| **Go Fast Fallback still races IPv6 despite gai.conf ordering** (codex finding) | medium | medium (Go consumers in VMs could still hit IPv6 path) | live Go canary in Testing strategy; if positive, follow-up to set `net.Dialer.FallbackDelay: -1` in Go consumers (in-code). We don't currently ship Go consumers in agent-vm runtime, but future plugins could |
| **NODE_OPTIONS / GODEBUG composition collision** with a future caller | low | medium (caller's narrower value silently wins) | shared-constant pattern + per-lifecycle test asserting the canonical value reaches the final VM env spec; helper docstring warns about composition |
| nscd / systemd-resolved caching layer bypasses gai.conf | very low (codex confirmed our base Dockerfiles don't ship either) | high (bug returns) | confirmed absent in current images; CI lint to reject adding them without explicit review |
| **gai.conf single-line form drops needed defaults** (codex finding: glibc replaces entire default precedence table on first uncommented `precedence` line) | medium | low-medium (some non-RFC2544 destinations could re-order) | pre-build canary validates ordering; ship full-table form if single-line regresses |
| Custom imagePath VMs miss gai.conf | low (no current consumers) | medium (libc consumers in custom images would still race) | documented limitation; custom-image consumers own their own image rootfs and their own gai.conf provisioning |
| gondolin upstream ships per-host AAAA (fix D) | medium (we may upstream this) | none (positive — IPv6 path becomes routable) | drop the env vars; gai.conf can stay |
| Hickory-DNS-using plugin added in future | medium | medium (only affects that plugin) | documented gap; plugin owns its own family preference |

### Reversibility

To revert the fix without re-releasing:

- env vars: caller can set `NODE_OPTIONS=` (empty) or `GODEBUG=` (empty) in their `CreateVmOptions.env` to override the adapter default.
- gai.conf: requires image rebuild to remove (or, in emergency, runtime overwrite via SSH).

Net cost of reverting: minutes for env vars, an image rebuild for gai.conf. No data migration, no version pin.

---

## Open questions / pending validation

- **Codex skeptical-validation pass** (background task `ad6263982ba5cebe3`): COMPLETED. Findings folded in:
  - Identified merge-order bug → recommended approach restructured around shared constants imported per-lifecycle (instead of adapter-only injection).
  - Confirmed nscd / systemd-resolved absent from base Dockerfiles.
  - Surfaced Go Fast Fallback as a separate-from-DNS-ordering race vector → added live Go canary.
  - Surfaced gai.conf single-line behavior of replacing entire default precedence table → added pre-build validation step.
  - Confirmed `--no-network-family-autoselection` covers `net.connect`, `tls.connect`, `http.Agent` (all inherit from socket.connect).
  - Confidence: medium-high.
- **Per-image config integration shape**: whether to extend an existing rootfs-file-spec type or introduce a new "shared system config" abstraction. Decide during plan-writing based on the existing image-build code patterns in `managed-image-dockerfile.ts`.
- **agent-vm semver**: 0.0.70 vs minor bump. The change is additive (no breaking surface), so 0.0.70 (patch) seems right.
- **Live Go canary**: when implementation lands, run the Go canary described in Testing strategy. If positive (IPv6 connects in log), follow-up to address Go Fast Fallback in plugin code or accept residual risk.

---

## References

### Evidence chain

- `shravan-claw@0ddf5f2:docs/wip/debugging/2026-05-21-lease-keepalive-400-and-discord-403-ipv6-race.md` — full mechanics, live repro, source citations, what-was-ruled-out matrix.
- `agent-vm` commits:
  - `22664e3` (2026-05-07) — original `Align Gondolin synthetic DNS with OpenClaw SSRF` (introduced `fc00::1` AAAA).
  - `18925e5` (2026-05-10) — `fix(gondolin): use OpenClaw-safe synthetic IPv6` (switched to `::ffff:198.18.0.1`; this is the current state).

### Source code

- `gondolin/host/src/qemu/net.ts:449-454` — `syntheticDnsOptions` initialization (scalar `ipv6`, not per-host).
- `gondolin/host/src/qemu/net.ts:773-776` — DNS response builder (only `ipv4` gets per-host override).
- `gondolin/host/src/qemu/dns.ts:167-175` — AAAA query responder.
- `gondolin/host/src/qemu/net.ts:887-888` — `SyntheticDnsHostMap.lookupHostByIp` reverse-lookup (IPv4-only).
- `gondolin/host/src/qemu/net.ts:895-908` — `resolveMappedTcpTarget` (returns null if `syntheticHostname` is null).
- `gondolin/host/src/qemu/http.ts:1077-1085` — `respondWithError` catch-all branches (400 for generic error, 403 for `HttpRequestBlockedError`).
- `openclaw/src/infra/net/ssrf.ts` — `assertAllowedResolvedAddressesOrThrow` (validates every DNS answer).
- `openclaw/src/infra/net/ssrf.test.ts:284-289` — confirms `::ffff:198.18.0.1` accepted under `allowRfc2544BenchmarkRange: true`.
- `openclaw/src/shared/net/ip.ts:283-287` — normalizes IPv4-mapped IPv6 to IPv4 for policy check.

### Standards and external docs

- RFC 6724 — Default Address Selection for IPv6.
- RFC 8305 — Happy Eyeballs Version 2.
- Linux `getaddrinfo(3)` man page — confirms `/etc/gai.conf` is honored by glibc.
- Node.js DNS docs — `dns.setDefaultResultOrder` / `--dns-result-order`.
- Node.js issues:
  - https://github.com/nodejs/node/issues/52216 — initial autoSelectFamily / ETIMEDOUT regression report.
  - https://github.com/nodejs/node/issues/54359 — Node core team recommends `--no-network-family-autoselection` as the revert.
- Go `pkg.go.dev/net` — documents `GODEBUG=netdns=cgo` semantics and the cgo-vs-pure-Go resolver split.

### Related agent-vm docs

- `docs/superpowers/plans/2026-05-10-discord-media-synthetic-ipv6.md` — original plan that introduced `::ffff:198.18.0.1`. Correct for its stated SSRF goal; did not anticipate Node Happy Eyeballs.
- `docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md` — canary that flagged the IPv6 risk as a watch item but didn't catch Node fetch's behavior. To be amended to add Happy Eyeballs as a regression vector.
- `docs/subsystems/gondolin-vm-layer.md` — subsystem doc; to be amended with the IPv4-preference policy.
