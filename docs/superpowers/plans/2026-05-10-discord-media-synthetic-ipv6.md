# OpenClaw Discord Media SSRF Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit unless the human explicitly asks; commit checkpoints below are handoff boundaries, not permission.

**Goal:** Make OpenClaw Discord media downloads pass SSRF validation inside agent-vm's Gondolin-backed OpenClaw gateways without broad Discord hostname bypasses.

**Architecture:** This is an OpenClaw compatibility fix in Shravan's `agent-vm` library. OpenClaw is the external policy behavior we must satisfy, and Gondolin is the external VM/network SDK we configure; do not modify OpenClaw or Gondolin in this implementation. Keep the change in agent-vm's adapter control surface: when `tcpHosts` enables Gondolin synthetic DNS with `syntheticHostMapping: 'per-host'`, keep synthetic A records in RFC2544 IPv4 space and change the shared synthetic AAAA answer from IPv6 unique-local `fc00::1` to IPv4-mapped RFC2544 `::ffff:198.18.0.1`. This preserves OpenClaw's existing `allowRfc2544BenchmarkRange` security model, avoids `browser.ssrfPolicy.allowedHostnames` private-IP bypasses for Discord CDN hosts, and documents that this is an SSRF-validation fix, not true guest IPv6 egress.

**Tech Stack:** TypeScript, pnpm, Vitest, Gondolin `VM.create()` DNS options, OpenClaw SSRF policy behavior, generated agent-vm deployment manual templates.

---

## Evidence Snapshot

- Baseline branch: `fix/discord-media-synthetic-ipv6`
- Baseline worktree: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.fix-discord-media-synthetic-ipv6`
- Focused red test command: `pnpm exec vitest run --config vitest.config.ts packages/gondolin-adapter/src/vm-adapter.test.ts`
- Focused red test result observed before implementation: failed because `SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK` was not exported and the adapter still emitted `fc00::1`.
- Focused green test command after implementation: `pnpm exec vitest run --config vitest.config.ts packages/gondolin-adapter/src/vm-adapter.test.ts`
- Focused green test result observed after implementation: 1 test file passed, 7 tests passed, exit code 0.
- Full-suite caution: an earlier `pnpm test:unit -- packages/gondolin-adapter/src/vm-adapter.test.ts` invocation forwarded arguments poorly and ran the full suite, exposing an unrelated worker coordinator timeout. Use direct Vitest commands for focused tests and rerun the full suite in Task 6.
- OpenClaw evidence: `src/infra/net/ssrf.test.ts` allows `::ffff:198.18.0.1` when `allowRfc2544BenchmarkRange: true`.
- Gondolin evidence: current adapter passes `syntheticIPv6: 'fc00::1'` when `tcpHosts` are enabled; Gondolin's network stack handles IPv4 packets and TCP host mapping reverse-looks up only synthetic IPv4 hostmap addresses.
- Gondolin source correction: `createHttpHooks()` blocks loopback, RFC1918, link-local, CGNAT, unspecified, broadcast, IPv6 loopback/link-local/ULA, and IPv4-mapped variants of those ranges. It does not block RFC2544 `198.18.0.0/15` in `host/src/http/hooks.ts`, so `::ffff:198.18.0.1` is not a Gondolin HTTP-hook internal-range block by itself.
- Gondolin SDK evidence: `allowedInternalHosts` only relaxes `createHttpHooks().isIpAllowed` for matching hostnames. It does not change OpenClaw's own SSRF resolver, and it does not apply to raw `tcp.hosts` mappings such as Discord WebSocket bypass or Tool VM SSH.

---

## Scope Boundaries

- In scope: `agent-vm` library code, `agent-vm` tests, `agent-vm` docs, generated deployment manual guidance, and runtime canary instructions for `shravan-claw`.
- External behavior to validate: OpenClaw Discord media SSRF checks and OpenClaw pinned DNS resolution behavior.
- External behavior to respect: Gondolin synthetic DNS, HTTP hooks, raw `tcp.hosts`, and IPv4-only guest packet handling.
- Out of scope: modifying `earendil-works/gondolin`, modifying `openclaw/openclaw`, changing Discord, or broadening `browser.ssrfPolicy.allowedHostnames` as the primary fix.

---

## File Structure

- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
  - Owns the adapter constants and the `VM.create()` DNS options.
  - Rename the misleading IPv6 unique-local constant to an IPv4-mapped RFC2544 constant.
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`
  - Owns tests proving the adapter emits OpenClaw-compatible DNS options when `tcpHosts` are present.
  - Add a direct assertion that the synthetic AAAA is IPv4-mapped RFC2544.
- Modify: `docs/subsystems/gondolin-vm-layer.md`
  - Canonical subsystem explanation of synthetic DNS, TCP host mapping, and the IPv6 limitation.
- Modify: `docs/architecture/openclaw-gateway.md`
  - OpenClaw gateway architecture page where WebSocket bypass and tool VM TCP mappings are explained.
- Modify: `docs/getting-started/openclaw-guide.md`
  - Operator-facing guide for OpenClaw deployments and Discord setup.
- Modify: `docs/reference/configuration/system-json.md`
  - Configuration reference that explains SSRF policy versus Gondolin `allowedHosts`.
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
  - Generated deployment manual content shipped into user repos.
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
  - Locks the generated manual wording so future defaults do not regress.
- Create: `docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md`
  - Deployment canary checklist for Discord media, controller/tool TCP mapping, and forced IPv6 behavior.

---

### Task 0: OpenClaw Constraint Validation

**Files:**
- Do not modify OpenClaw files.
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/openclaw/src/infra/net/ssrf.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/openclaw/src/infra/net/ssrf.test.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/openclaw/extensions/discord/src/monitor/message-media.ts`

- [ ] **Step 1: Confirm OpenClaw allows IPv4-mapped RFC2544 under Discord media policy**

Run:

```bash
rg -n '"::ffff:198.18.0.1"|allowRfc2544BenchmarkRange|allowIpv6UniqueLocalRange|assertAllowedResolvedAddressesOrThrow|dedupeAndPreferIpv4' /Users/shravansunder/Documents/dev/open-source/openclaw/src/infra/net/ssrf.ts /Users/shravansunder/Documents/dev/open-source/openclaw/src/infra/net/ssrf.test.ts
```

Expected:
- `ssrf.test.ts` contains a case where `::ffff:198.18.0.1` with `{ allowRfc2544BenchmarkRange: true }` is not blocked.
- `ssrf.ts` checks all resolved addresses before `dedupeAndPreferIpv4`.

- [ ] **Step 2: Confirm OpenClaw Discord media uses RFC2544 but not IPv6 ULA bypass**

Run:

```bash
rg -n 'DISCORD_MEDIA_SSRF_POLICY|hostnameAllowlist|allowedHostnames|allowRfc2544BenchmarkRange|allowIpv6UniqueLocalRange' /Users/shravansunder/Documents/dev/open-source/openclaw/extensions/discord/src/monitor/message-media.ts
```

Expected:
- `DISCORD_MEDIA_SSRF_POLICY` includes Discord CDN hostname allowlist.
- `DISCORD_MEDIA_SSRF_POLICY` includes `allowRfc2544BenchmarkRange: true`.
- The Discord media policy does not add `allowIpv6UniqueLocalRange: true`.

- [ ] **Step 3: Attempt focused OpenClaw tests read-only**

Run from `/Users/shravansunder/Documents/dev/open-source/openclaw`:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/infra/net/ssrf.test.ts
```

Expected: PASS. This is a required attempt because Shravan's local OpenClaw checkout is the behavior contract we are targeting. If OpenClaw dependencies are not installed locally, record that the source/test inspection from Steps 1-2 is the evidence and continue; do not install or modify OpenClaw as part of this agent-vm implementation.

- [ ] **Step 4: Record the OpenClaw constraint in the implementation notes**

When implementing the adapter change, keep this invariant in mind:

```txt
OpenClaw Discord media validates every resolved address.
OpenClaw Discord media already permits RFC2544 fake IPv4.
OpenClaw Discord media does not permit fc00::/7 ULA.
Therefore agent-vm should emit a synthetic AAAA address that OpenClaw classifies through the RFC2544 path, not the ULA path.
```

---

### Task 1: Gondolin Constraint Validation

**Files:**
- Do not modify Gondolin files.
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/utils/ip.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/dns.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/contracts.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/net.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/network-stack.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/src/http/hooks.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/test/dns.test.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/test/http-hooks.test.ts`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/docs/network.md`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/docs/security.md`
- Read-only reference: `/Users/shravansunder/Documents/dev/open-source/gondolin/host/bin/gondolin.ts`

- [ ] **Step 1: Confirm Gondolin can encode IPv4-mapped synthetic AAAA answers**

Run:

```bash
rg -n "embedded IPv4|parseIPv6Hextets|parseIPv6Bytes|synthetic ipv6 AAAA|DNS_TYPE_AAAA|buildSyntheticDnsResponse" /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/utils/ip.ts /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/dns.ts /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/contracts.ts /Users/shravansunder/Documents/dev/open-source/gondolin/host/test/dns.test.ts
```

Expected:
- `parseIPv6Hextets()` supports embedded IPv4 suffixes.
- `buildSyntheticDnsResponse()` uses `parseIPv6Bytes()` for AAAA records.
- `DnsOptions.syntheticIPv6` is a public SDK option.

Then run an exact installed-dependency probe from the agent-vm worktree:

```bash
node --input-type=module - <<'EOF'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dnsModulePath = path.resolve(
	'packages/gondolin-adapter/node_modules/@earendil-works/gondolin/dist/src/qemu/dns.js',
);
const {
	DNS_CLASS_IN,
	DNS_TYPE_AAAA,
	buildSyntheticDnsResponse,
	parseDnsQuery,
} = await import(pathToFileURL(dnsModulePath).href);

function dnsNameWire(name) {
	return Buffer.concat(
		name
			.split('.')
			.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]))
			.concat(Buffer.from([0])),
	);
}

const header = Buffer.alloc(12);
header.writeUInt16BE(0x1234, 0);
header.writeUInt16BE(0x0100, 2);
header.writeUInt16BE(1, 4);

const questionTail = Buffer.alloc(4);
questionTail.writeUInt16BE(DNS_TYPE_AAAA, 0);
questionTail.writeUInt16BE(DNS_CLASS_IN, 2);

const packet = Buffer.concat([
	header,
	dnsNameWire('cdn.discordapp.com'),
	questionTail,
]);
const query = parseDnsQuery(packet);
if (!query) throw new Error('failed to parse query');

const response = buildSyntheticDnsResponse(query, {
	ipv4: '198.18.0.1',
	ipv6: '::ffff:198.18.0.1',
	ttlSeconds: 60,
});

if (response.readUInt16BE(6) !== 1) throw new Error('AAAA answer was not emitted');
console.log(response.subarray(response.length - 16).toString('hex'));
EOF
```

Expected: `00000000000000000000ffffc6120001`, proving the installed Gondolin DNS builder accepts and emits the exact IPv4-mapped dotted-quad value.

- [ ] **Step 2: Confirm per-host synthetic identity is IPv4-only**

Run:

```bash
rg -n "SyntheticDnsHostMap|allocate\\(|lookupHostByIp|mappedIpv4|syntheticHostMapping|handleTcpConnect|syntheticIPv6" /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/net.ts /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/utils/dns.ts
```

Expected:
- `SyntheticDnsHostMap.allocate()` creates per-host IPv4 answers in `198.19.x.y`.
- `handleSyntheticDns()` overrides only the synthetic A answer with the per-host IPv4 value.
- `handleTcpConnect()` resolves mapped TCP identity using `lookupHostByIp(message.dstIP)`, so raw `tcp.hosts` identity depends on the IPv4 per-host path.

- [ ] **Step 3: Confirm guest packets are IPv4-only today**

Run:

```bash
rg -n "ETH_P_IP|ETH_P_IPV6|0x86dd|handleIP|version !== 4|IP_PROTO_TCP|IP_PROTO_UDP" /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/qemu/network-stack.ts
```

Expected:
- `ETH_P_IP = 0x0800` exists.
- No IPv6 EtherType handler exists for `0x86dd`.
- `handleIP()` returns unless packet version is 4.

- [ ] **Step 4: Confirm `allowedInternalHosts` is not this fix**

Run:

```bash
rg -n "allowedInternalHosts|blockInternalRanges|isPrivateIPv4|isPrivateIPv6|extractIPv4Mapped|::ffff|198\\.18|100\\.64|fc00" /Users/shravansunder/Documents/dev/open-source/gondolin/host/src/http/hooks.ts /Users/shravansunder/Documents/dev/open-source/gondolin/host/test/http-hooks.test.ts /Users/shravansunder/Documents/dev/open-source/gondolin/docs/security.md
```

Expected:
- `allowedInternalHosts` only changes `createHttpHooks().isIpAllowed`.
- `isPrivateIPv4()` does not include RFC2544 `198.18.0.0/15`.
- IPv4-mapped loopback/private addresses are blocked, but IPv4-mapped public-style addresses are allowed by the Gondolin HTTP hook tests.
- This does not affect OpenClaw's Discord media SSRF resolver and does not affect raw `tcp.hosts`.

- [ ] **Step 5: Confirm Gondolin CLI does not expose the needed synthetic IPv6 knob**

Run:

```bash
rg -n "dnsSyntheticHostMapping|syntheticIPv4|syntheticIPv6|--dns-synthetic-host-mapping|--tcp-map|--dns-trusted-server" /Users/shravansunder/Documents/dev/open-source/gondolin/host/bin/gondolin.ts
```

Expected:
- CLI exposes `--dns-synthetic-host-mapping`, `--dns`, and `--dns-trusted-server`.
- CLI does not expose `--dns-synthetic-ipv4` or `--dns-synthetic-ipv6`.
- agent-vm should keep using SDK-level `VM.create({ dns: { syntheticIPv6 } })` rather than relying on CLI flags.

- [ ] **Step 6: Record the Gondolin constraint in the implementation notes**

When implementing the adapter change, keep this invariant in mind:

```txt
Gondolin can emit an IPv4-mapped synthetic AAAA answer.
Gondolin raw tcp.hosts attribution is IPv4/per-host.
Gondolin guest packet handling is IPv4-only today.
Gondolin allowedInternalHosts is only an HTTP-hook exception, not an OpenClaw SSRF or raw TCP fix.
Therefore ::ffff:198.18.0.1 is useful as an OpenClaw SSRF-validation value, but normal runtime traffic must still use the IPv4/per-host path.
```

---

### Task 2: agent-vm Adapter DNS Constant And Unit Tests

**Files:**
- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`

- [ ] **Step 1: Write the failing test for the new synthetic AAAA contract**

In `packages/gondolin-adapter/src/vm-adapter.test.ts`, add the `node:net` import above the Gondolin imports:

```ts
import net from 'node:net';
```

Add `createHttpHooks` to the existing Gondolin import so the test locks the SDK policy behavior this adapter relies on:

```ts
import {
	MemoryProvider,
	createHttpHooks,
	type HttpHooks,
	type VMOptions,
	type VirtualProvider,
} from '@earendil-works/gondolin';
```

Change the adapter import block from:

```ts
import {
	SYNTHETIC_DNS_IPV4_BENCHMARK,
	SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL,
	createManagedVm,
	type ManagedVmDependencies,
	type ManagedVmInstance,
} from './vm-adapter.js';
```

to:

```ts
import {
	SYNTHETIC_DNS_IPV4_BENCHMARK,
	SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
	createManagedVm,
	type ManagedVmDependencies,
	type ManagedVmInstance,
} from './vm-adapter.js';
```

Add this test at the top of the `describe('createManagedVm', () => {` block:

```ts
	it('uses an IPv4-mapped RFC2544 synthetic AAAA address for OpenClaw SSRF compatibility', () => {
		expect(SYNTHETIC_DNS_IPV4_BENCHMARK).toBe('198.18.0.1');
		expect(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK).toBe('::ffff:198.18.0.1');
		expect(net.isIP(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK)).toBe(6);
		expect(SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK).toContain(
			SYNTHETIC_DNS_IPV4_BENCHMARK,
		);
	});
```

Add this test immediately after it:

```ts
	it('keeps the synthetic AAAA value outside Gondolin default internal-range blocking', async () => {
		const { httpHooks } = createHttpHooks({
			allowedHosts: ['cdn.discordapp.com'],
		});

		await expect(
			httpHooks.isIpAllowed?.({
				family: 6,
				hostname: 'cdn.discordapp.com',
				ip: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
				port: 443,
				protocol: 'https',
			}),
		).resolves.toBe(true);
	});
```

Replace both existing test expectations that use `SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL`:

```ts
syntheticIPv6: SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL,
```

with:

```ts
syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
pnpm test:unit -- packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected: FAIL with a TypeScript/Vitest import error because `SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK` is not exported yet.

- [ ] **Step 3: Implement the adapter constant rename and value change**

In `packages/gondolin-adapter/src/vm-adapter.ts`, replace:

```ts
export const SYNTHETIC_DNS_IPV4_BENCHMARK = '198.18.0.1';
export const SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL = 'fc00::1';
```

with:

```ts
export const SYNTHETIC_DNS_IPV4_BENCHMARK = '198.18.0.1';
export const SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK = '::ffff:198.18.0.1';
```

In the `createManagedVm()` DNS options, replace:

```ts
syntheticIPv6: SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL,
```

with:

```ts
syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
```

Do not keep an exported alias for `SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL`; the old name is now false and should be removed in one cutover.

- [ ] **Step 4: Run the focused passing test**

Run:

```bash
pnpm test:unit -- packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Search for stale constant and old fake IPv6 references**

Run:

```bash
rg -n "SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL|fc00::1" packages docs --glob '!docs/superpowers/plans/**'
```

Expected: no matches. If there are matches, update them in the same task because stale docs would send future agents back to the broken mental model.

- [ ] **Step 6: Adapter change checkpoint**

Run:

```bash
Do not commit unless the human explicitly asks. If asked, use:

```bash
git add packages/gondolin-adapter/src/vm-adapter.ts packages/gondolin-adapter/src/vm-adapter.test.ts
git commit -m "fix(gondolin): use OpenClaw-safe synthetic IPv6

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Canonical Docs For The Network Model

**Files:**
- Modify: `docs/subsystems/gondolin-vm-layer.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/getting-started/openclaw-guide.md`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Update the Gondolin VM layer TCP Host Mapping section**

In `docs/subsystems/gondolin-vm-layer.md`, replace this paragraph under `## TCP Host Mapping`:

```md
When `tcpHosts` is provided in `CreateVmOptions`, the adapter configures:
- `dns.mode: 'synthetic'` with `syntheticHostMapping: 'per-host'` -- Gondolin resolves virtual hostnames to loopback addresses inside the VM
- `tcp.hosts` -- maps each virtual hostname to a real host-side TCP endpoint
```

with:

```md
When `tcpHosts` is provided in `CreateVmOptions`, the adapter configures:
- `dns.mode: 'synthetic'` with `syntheticHostMapping: 'per-host'` -- Gondolin resolves virtual hostnames to per-host RFC2544 IPv4 answers such as `198.19.x.y`
- `dns.syntheticIPv4: '198.18.0.1'` -- fallback synthetic A answer when no per-host mapping applies
- `dns.syntheticIPv6: '::ffff:198.18.0.1'` -- shared IPv4-mapped RFC2544 AAAA answer so OpenClaw SSRF checks that validate all A/AAAA answers can accept the fake address under `allowRfc2544BenchmarkRange`
- `tcp.hosts` -- maps each virtual hostname to a real host-side TCP endpoint

The IPv4-mapped AAAA answer is an SSRF-validation compatibility value, not true guest IPv6 egress. Gondolin's TCP host mapping reverse lookup is keyed by synthetic IPv4 hostmap addresses, so normal clients must use the A/per-host path for raw TCP mappings such as `controller.vm.host`, `tool-0.vm.host`, and WebSocket bypass hosts. Treat `curl -6` failures inside the guest as expected unless Gondolin later adds first-class IPv6 packet handling.

`allowedInternalHosts` is a Gondolin HTTP-hook escape hatch, not the fix for this Discord media failure. It can relax Gondolin's host-side HTTP internal-IP block for matching request hostnames, but it does not affect OpenClaw's Discord media SSRF validation and does not apply to raw mapped TCP.
```

- [ ] **Step 2: Update the OpenClaw Gateway WebSocket Bypass section**

In `docs/architecture/openclaw-gateway.md`, after this paragraph:

```md
Bypass hosts get direct TCP forwarding via `tcpHosts` -- no HTTP interception, no secret injection.
```

add:

```md
Because bypass hosts use raw `tcpHosts`, they rely on Gondolin's per-host synthetic IPv4 mapping. The adapter also emits an IPv4-mapped RFC2544 synthetic AAAA answer for OpenClaw SSRF compatibility, but that AAAA answer is not the identity-bearing route for raw TCP. After changing synthetic DNS behavior, always verify that Discord still stays online through the normal WebSocket client path and that forced IPv6 attempts fail fast rather than delaying reconnects.
```

- [ ] **Step 3: Update the getting-started Web Fetch section**

In `docs/getting-started/openclaw-guide.md`, replace:

```md
Gondolin uses synthetic DNS for mediated egress. Current agent-vm scaffolds
OpenClaw `web_fetch` with the matching fake-IP SSRF policy so OpenClaw trusts
the mediated boundary:
```

with:

```md
Gondolin uses synthetic DNS for mediated egress and TCP host mapping. Current
agent-vm scaffolds OpenClaw `web_fetch` with fake-IP SSRF policy so OpenClaw
trusts the mediated boundary:
```

After the JSON block in the same section, replace:

```md
This only passes OpenClaw's SSRF check. Gondolin still enforces
`zones[].allowedHosts`, so arbitrary public websites are not reachable unless
the deployment allows them or routes `web_fetch` through a provider such as
Firecrawl/Jina.
```

with:

```md
This only passes OpenClaw's SSRF check. Gondolin still enforces
`zones[].allowedHosts`, so arbitrary public websites are not reachable unless
the deployment allows them or routes `web_fetch` through a provider such as
Firecrawl/Jina.

For gateway/tool TCP mappings, agent-vm uses RFC2544 synthetic IPv4 addresses
and an IPv4-mapped RFC2544 synthetic AAAA answer (`::ffff:198.18.0.1`). The
AAAA answer prevents OpenClaw from rejecting a host only because DNS returned a
fake IPv6 answer. It does not mean the guest has general IPv6 egress.
```

- [ ] **Step 4: Update the system configuration reference**

In `docs/reference/configuration/system-json.md`, replace:

```md
OpenClaw `web_fetch` in Gondolin deployments needs the fake-IP SSRF policy that
matches Gondolin's mediated DNS ranges:
```

with:

```md
OpenClaw `web_fetch` in Gondolin deployments needs fake-IP SSRF policy for
mediated DNS and proxy-style environments:
```

After the existing paragraph:

```md
This is separate from `zones[].allowedHosts`. The SSRF policy lets OpenClaw
connect to Gondolin's synthetic addresses; `allowedHosts` still decides which
real destinations Gondolin may fetch.
```

add:

```md
Agent-vm's Gondolin adapter uses RFC2544 synthetic IPv4 answers and
`::ffff:198.18.0.1` for synthetic AAAA when `tcpHosts` are enabled. That value
is accepted by OpenClaw when `allowRfc2544BenchmarkRange` is true. Do not use
`browser.ssrfPolicy.allowedHostnames` as the first fix for Discord media; that
exact-host bypass skips private-IP checks for the named host and is broader
than the adapter-level synthetic DNS fix.
```

- [ ] **Step 5: Run docs stale-reference scan**

Run:

```bash
rg -n "fc00::1|2001:db8::1|SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL" docs packages --glob '!docs/superpowers/plans/**'
```

Expected: no matches.

- [ ] **Step 6: Canonical docs checkpoint**

Run:

```bash
Do not commit unless the human explicitly asks. If asked, use:

```bash
git add docs/subsystems/gondolin-vm-layer.md docs/architecture/openclaw-gateway.md docs/getting-started/openclaw-guide.md docs/reference/configuration/system-json.md
git commit -m "docs: explain OpenClaw-safe synthetic DNS

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Generated Deployment Manual Updates

**Files:**
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Add failing manual assertions**

In `packages/agent-vm/src/cli/manual-templates.test.ts`, after the existing assertion that `openclaw-defaults.md` contains `session.dmScope`, add:

```ts
		expect(
			files.find((file) => file.relativePath.endsWith('openclaw-defaults.md'))?.content,
		).toContain('::ffff:198.18.0.1');
```

After the existing assertion that `channels.md` contains `DISCORD_BOT_TOKEN`, add:

```ts
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'cdn.discordapp.com',
		);
		expect(files.find((file) => file.relativePath.endsWith('channels.md'))?.content).toContain(
			'media.discordapp.net',
		);
```

After the existing assertion that `README.md` contains `coding agents helping end users set up and operate agent-vm deployments`, add:

```ts
		expect(
			files.find((file) => file.relativePath.endsWith('troubleshooting.md'))?.content,
		).toContain('blocked URL fetch');
		expect(
			files.find((file) => file.relativePath.endsWith('troubleshooting.md'))?.content,
		).toContain('curl -6');
```

- [ ] **Step 2: Run the focused failing manual test**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: FAIL because the generated manual does not yet mention the IPv4-mapped synthetic AAAA or Discord media SSRF troubleshooting.

- [ ] **Step 3: Update `openclaw-defaults.md` generated content**

In `packages/agent-vm/src/cli/manual-templates.ts`, in the `openclaw-defaults.md` body, replace:

```md
	tools.web.fetch.ssrfPolicy trusts Gondolin's OpenClaw-compatible fake IP ranges for web_fetch.
```

with:

```md
	tools.web.fetch.ssrfPolicy trusts fake-IP ranges for web_fetch. For gateway/tool TCP mappings, agent-vm's Gondolin adapter uses RFC2544 synthetic IPv4 plus `::ffff:198.18.0.1` as the synthetic AAAA answer so OpenClaw SSRF checks can validate all DNS answers without a broad hostname bypass.
```

- [ ] **Step 4: Update `channels.md` generated Discord recipe**

In `packages/agent-vm/src/cli/manual-templates.ts`, in the Discord recipe, replace:

```md
- Add discord.com and cdn.discordapp.com to allowedHosts.
```

with:

```md
- Add discord.com, discordapp.com, *.discordapp.com, and *.discordapp.net to allowedHosts.
- Discord media downloads use OpenClaw's Discord media SSRF policy, not tools.web.fetch.ssrfPolicy. If media logs show blocked URL fetch for cdn.discordapp.com or media.discordapp.net, verify the installed agent-vm version emits `::ffff:198.18.0.1` synthetic AAAA for Gondolin TCP-host VMs before adding broader OpenClaw hostname bypasses.
```

- [ ] **Step 5: Expand `troubleshooting.md` generated content**

In `packages/agent-vm/src/cli/manual-templates.ts`, replace the `troubleshooting.md` body:

```md
Run agent-vm validate after config edits.
Run agent-vm doctor before starting or after changing images, secrets, or channel plugins.
Run agent-vm manual update after upgrading agent-vm to refresh this manual.
```

with:

```md
Run agent-vm validate after config edits.
Run agent-vm doctor before starting or after changing images, secrets, or channel plugins.
Run agent-vm manual update after upgrading agent-vm to refresh this manual.

Discord media symptom:
- Log text: blocked URL fetch, resolves to private/internal/special-use IP address, cdn.discordapp.com, or media.discordapp.net.
- First check: the gateway is running an agent-vm version whose Gondolin adapter emits `::ffff:198.18.0.1` for synthetic AAAA when tcpHosts are enabled.
- Expected behavior: normal fetches use the IPv4/per-host synthetic path. `curl -6` inside the guest may fail because this is not general guest IPv6 egress.
- Safer fix order: adapter synthetic DNS fix first, Discord allowedHosts second, exact `browser.ssrfPolicy.allowedHostnames` bypass only after naming the broader private-IP-check tradeoff.
- Non-fix: Gondolin `allowedInternalHosts` only affects Gondolin HTTP hooks. It does not change OpenClaw Discord media SSRF and does not apply to raw `tcp.hosts`.
```

- [ ] **Step 6: Run the focused passing manual test**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 7: Generated manual checkpoint**

Run:

```bash
Do not commit unless the human explicitly asks. If asked, use:

```bash
git add packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs(manual): add Discord media SSRF guidance

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Deployment Canary Runbook

**Files:**
- Create: `docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md`

- [ ] **Step 1: Create the runbook with exact canary checks**

Create `docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md` with:

```md
# 2026-05-10 OpenClaw Discord Media Synthetic DNS Canary

Newest first. This runbook validates the agent-vm synthetic DNS change that moves Gondolin's shared synthetic AAAA answer from `fc00::1` to `::ffff:198.18.0.1`.

## Goal

Prove that Discord media no longer fails OpenClaw SSRF validation while controller, Tool VM SSH, and Discord WebSocket raw TCP mappings still use the IPv4/per-host path.

## Expected DNS Model

- `controller.vm.host` A resolves to a per-host RFC2544 address such as `198.19.x.y`.
- `tool-0.vm.host` A resolves to a per-host RFC2544 address such as `198.19.x.y`.
- Discord CDN A resolves to a per-host RFC2544 address such as `198.19.x.y`.
- Shared synthetic AAAA resolves to `::ffff:198.18.0.1`.
- Forced guest IPv6 is not expected to provide general egress.

## Gateway VM Checks

Run through `agent-vm controller ssh --zone <zoneId>` or the protected zone execute-command route.

```bash
getent ahostsv4 controller.vm.host
getent ahostsv6 controller.vm.host
getent ahostsv4 tool-0.vm.host
getent ahostsv6 tool-0.vm.host
getent ahostsv4 cdn.discordapp.com
getent ahostsv6 cdn.discordapp.com
```

Expected:
- IPv4 answers exist for controller/tool/Discord CDN.
- IPv6 answers show `::ffff:198.18.0.1` or no usable forced-IPv6 path.
- No answer should be `fc00::1`.

## Raw TCP Regression Checks

```bash
curl -sS --max-time 5 http://controller.vm.host:18800/health
curl -4 -sS --max-time 5 http://controller.vm.host:18800/health
curl -6 -sS --max-time 5 http://controller.vm.host:18800/health
```

Expected:
- Normal curl succeeds.
- `curl -4` succeeds.
- `curl -6` may fail; failure is acceptable if normal curl does not stall.

## Discord Media Check

Send a Discord image attachment and a Discord voice attachment to the agent.

Check logs:

```bash
agent-vm controller logs --zone <zoneId> | rg -n "blocked URL fetch|failed to download attachment|audio: failed|cdn.discordapp.com|media.discordapp.net"
```

Expected:
- No `blocked URL fetch` for Discord CDN.
- No `resolves to private/internal/special-use IP address` for Discord CDN.
- Media is delivered to the OpenClaw message as a local media payload.

## Discord WebSocket Check

Check logs for reconnect storms:

```bash
agent-vm controller logs --zone <zoneId> | rg -n "gateway.discord.gg|websocket|reconnect|disconnect|heartbeat"
```

Expected:
- No repeated reconnect loop after the synthetic DNS change.
- Agent remains online.

## Rollback

Revert the adapter constant from `::ffff:198.18.0.1` back to `fc00::1`, rebuild the agent-vm package/image, restart the gateway, and re-run the Discord media check. Rollback should reproduce the old SSRF failure and prove the canary is measuring the intended boundary.
```

- [ ] **Step 2: Run markdown sanity checks**

Run:

```bash
rg -n "TODO|TBD|implement later|fill in details" docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md
```

Expected: no matches.

- [ ] **Step 3: Runbook checkpoint**

Run:

```bash
Do not commit unless the human explicitly asks. If asked, use:

```bash
git add docs/wip/debugging/2026-05-10-openclaw-discord-media-synthetic-dns-canary.md
git commit -m "docs: add Discord media synthetic DNS canary

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Full Verification

**Files:**
- No new source files.

- [ ] **Step 1: Format**

Run:

```bash
pnpm fmt
```

Expected: exit code 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
pnpm test:unit -- packages/gondolin-adapter/src/vm-adapter.test.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

- [ ] **Step 3: Full unit test suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS. Baseline before implementation was 124 test files passed, 1053 tests passed, 1 skipped.

- [ ] **Step 4: Full quality gate**

Run:

```bash
pnpm check
```

Expected: exit code 0.

- [ ] **Step 5: Manual update smoke check**

Run:

```bash
tmpdir=$(mktemp -d)
pnpm build
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js init "$tmpdir/sunfam" --type openclaw --openclaw-agents sun,shravan,alevtina
node packages/agent-vm/dist/cli/agent-vm-entrypoint.js manual update --project "$tmpdir/sunfam"
rg -n "::ffff:198.18.0.1|blocked URL fetch|curl -6" "$tmpdir/sunfam/docs/manual"
```

Expected:
- `pnpm build` exits 0.
- `agent-vm init` exits 0.
- `agent-vm manual update` exits 0.
- `rg` prints matches from generated manual files.

- [ ] **Step 6: Final stale-reference scan**

Run:

```bash
rg -n "SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL|fc00::1|2001:db8::1" packages docs --glob '!docs/superpowers/plans/**'
```

Expected:
- No matches in source files.
- The only allowed current-doc matches are historical/rollback mentions in the
  canary runbook; no source or operator-guidance page should still recommend
  `fc00::1` or `2001:db8::1`.

- [ ] **Step 7: Inspect git state**

Run:

```bash
git status --short
git log --oneline -4
```

Expected:
- If commits were requested, `git status --short` is empty and the implementation commits are visible on `fix/discord-media-synthetic-ipv6`.
- If commits were not requested, `git status --short` shows only the intended modified/untracked files from this plan.

---

## Self-Review

- Spec coverage: The plan covers the OpenClaw constraint, the exact Gondolin network/DNS/HTTP-hook files, the adapter-level control surface, tests for the new DNS value, canonical docs, generated manuals, deployment canary checks, and full verification.
- Placeholder scan: The plan contains no `TBD`, no unresolved `TODO`, and no open-ended implementation placeholders.
- Type consistency: The renamed constant is `SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK` everywhere; the old `SYNTHETIC_DNS_IPV6_UNIQUE_LOCAL` symbol is intentionally removed.
- Risk coverage: The plan explicitly tests the major side effects: raw `tcpHosts`, Discord WebSocket bypass, controller health, normal IPv4 path, forced IPv6 behavior, and Discord media SSRF logs.
