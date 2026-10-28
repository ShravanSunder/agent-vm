# tool-host-core: the hosted MCP proxy runs anywhere

> **Status (2026-10-28): record.** `tool-host-core` was built into the #262 stack. The [Switchboard remediation plan](../../2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.html) now governs this code, which moves to its own `agent-collaboration` repository first (OD13). The Tool Portal is now called Switchboard (OD12).

The owner asked that the core libraries run anywhere and that the Cloudflare
packages use them, with Cloudflare's runtime injected the way Fleet does it
(2026-10-21: "use disaggregate so its injectable", "we do teh same thing in
fleet", "make sure teh core libraries run anwyerhe and they are used by teh
cloduflarek apcages"). The owner approved a new package and its tsconfig path
lines.

## Today (#246 at e9db67f5)

- `tool-access` and `tool-engine` have no Cloudflare or Node code.
- `tool-host-cloudflare` holds the hosted proxy's logic: caller check,
  organization engines, request limits, MCP handling, analytics events,
  configuration schemas and profile policy. 16 of its 19 modules make no
  Cloudflare calls, and they already receive runtime pieces by injection
  (`createWorkerHost({ verifier, organizations, configurations, secrets,
  analytics, log, createClient })`). The logic still lives in the Cloudflare
  package, under `worker-*` names.
- `OrganizationAuthorization` (the Durable Object) holds rules, not only
  storage: agent admission parsing, and approval replay, expiry, pruning and
  first use, inside `extends DurableObject` with `ctx.storage.transaction` and
  `Date.now`.
- The architecture guard forbids `node:` in the core packages, but not
  `cloudflare:`.

## Target

Fleet's pattern (agent-fleet-sync 3a2153ec): a runtime-free core whose
`Engine` takes an injected atomic store, host and clock; a native adapter and
a Durable Object adapter build the same `Engine`.

```text
core: runs anywhere (no node:, no cloudflare:, web Request/Response only)
  tool-access          rules and contracts                             (exists)
  tool-engine          dispatch, gateway, upstream connectors          (exists)
  tool-host-core  NEW  the hosted MCP proxy for many organizations

runtime adapters
  tool-host-cloudflare fetch entry; env → configuration and secrets;
                       Durable Object → organization authority store;
                       Analytics Engine → analytics sink; Cloudflare limit values
  tool-host-node       unchanged in this pass
```

### `@agent-collaboration/tool-host-core`

```text
packages/tool-host-core/src/
├── index.ts
├── hosted-mcp-proxy/            createHostedMcpProxy(ports) → { handle(Request): Promise<Response> }
│   ├── hosted-mcp-proxy.ts      (was worker-request-handling/worker-host.ts)
│   ├── hosted-mcp-server.ts     (was worker-mcp-server.ts)
│   └── models/                  the ports: HostedMcpProxyPorts, ObservationLog, …
├── caller-admission/            caller-check (token → organization → listed agent)
├── organization-authority/      admission and approval-replay RULES as pure transitions
│   ├── approval-token-use-rules.ts   decide(state, tokenId, expiresAtMs, nowMs, cap) → { result, next }
│   ├── agent-admission-rules.ts
│   ├── volatile-authority-store.ts   in-memory store for tests (Fleet's "volatile store")
│   └── models/                       OrganizationAuthorityStore (atomic read-modify-write), Clock
├── organization-engines/        organization-engine, request-operation-entries, proxy-profile-policy;
│                                the upstream transport factory is INJECTED (as the design says)
├── request-limits/              batch scheduler, reply budget, trimming order, refusal projection;
│                                limit VALUES injected as HostedProxyLimits
├── call-analytics/              semantic CallAnalytics events and batch derivation; AnalyticsSink port
└── hosted-configuration/        configuration schemas; ConfigurationSource and SecretSource ports
```

### What stays in `tool-host-cloudflare`

```text
packages/tool-host-cloudflare/src/
├── index.ts                         fetch entry: env → ports → createHostedMcpProxy
├── durable-organization-authority/  the OrganizationAuthorization Durable Object: one
│                                    ctx.storage.transaction per decision, calling the core rules
├── analytics-engine-sink/           CallAnalytics → writeDataPoint (indexes, blobs, doubles, byte truncation)
├── worker-bindings/                 env → ConfigurationSource and SecretSource
├── worker-upstream-transports.ts    the SDK v1 SSE and StreamableHTTP client transports, injected into the core
├── worker-limits.ts                 Cloudflare limit values: 4 MiB body, 4 MiB upstream, 16 MiB reply, 50, 6
├── test-fixtures/
└── deployed-checks/                 (from #247)
```

## Rules

1. **No behavior change.** Responses, refusals, limits, analytics points, log
   events, token bytes and stored rows stay byte-identical.
2. **The replay transaction keeps its shape.** Read, check, prune, cap and
   write happen inside one atomic store operation. First use succeeds only
   after the write succeeds. The injected clock is read at the same point
   `Date.now` is read today. The 512 KiB byte cap is a Cloudflare value passed
   in; the rule (refuse when full) is in the core.
3. **No dependency reversals.** `tool-host-core` may import `tool-access` and
   `tool-engine`. Neither may import it, nor each other in a new direction.
   `proxy-profile-policy` moves to `tool-host-core`, not `tool-access`, because
   it uses `PortalToolRecord`.
4. **The guard enforces it.** `scripts/audit-portal-architecture.ts` forbids
   `cloudflare:` (with `node:`, Node builtins, hosts and agent-vm) in
   `tool-access`, `tool-engine` and `tool-host-core`, and checks that
   `tool-host-core` uses no Workers globals types.
5. **Hard cutover.** No re-exports from the old paths. The package follows the
   structure plan's rules (folders by job, `models/` with the guardrail,
   absolute `#` imports, no file over 600 lines).

## Proof

- `tool-host-core` tests run in **plain Node**. They cover the logic tests
  moved from the Worker package, plus new tests for the extracted rules:
  first use, concurrent use, replay, expiry, pruning, the cap, and a store
  failure (no success when the write fails), using the volatile store.
- The Cloudflare adapter **calls the same exported functions**. The Durable
  Object's `consumeApprovalToken` and admission methods delegate to
  `tool-host-core`, which shows in the source and is proven by the Worker's
  e2e-host suite (54 tests, on sunclaw).
- Test counts: every moved test keeps its assertions. The per-package counts
  move, and the totals equal the old total plus the new rule tests.
- `pnpm check` 16/16; the production bundle of `src/index.ts` has no `node:`,
  `tool-host-node` or deployed-checks input.
- After acceptance, #247 merges it, the Lead redeploys, and deployed rows 13,
  14 and 16 run again.

## Sequence

One PR stacked on #246: branch `tool-host-core/runtime-neutral-hosting` from
`e9db67f5`, base `tool-host-cloudflare/s6-worker`. tsconfig.base.json gains
only the `@agent-collaboration/tool-host-core` path entry (owner-approved).

## Amendment (2026-10-21, after the Implementer's closure finding)

- **Upstream transports stay with the runtime.** The design says "the
  transports stay injected by the host", so `worker-upstream-transports.ts`
  stays in `tool-host-cloudflare` and the core takes
  `createUpstreamMcpTransport` as a port. Nothing in `tool-host-core` imports
  `@modelcontextprotocol/sdk/client/*`. The earlier tree that put them in the
  core was wrong.
- **The MCP SDK server stays in the core,** with an explicit proof boundary.
  The SDK runs anywhere through conditional exports:
  1. a strict direct-import ban in `tool-host-core`'s own source, the same as
     `tool-engine` (no `node:`, builtins, `cloudflare:`, hosts, agent-vm or
     Workers types);
  2. a browser/workerd-condition closure with zero `node:` inputs;
  3. a Node-condition closure that may contain only the SDK's own conditional
     shim (`@modelcontextprotocol/server/dist/shimsNode.mjs` → `node:process`),
     and nothing else;
  4. runtime proof on both: plain-Node core tests and the Worker's workerd
     e2e-host suite.
