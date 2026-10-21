# Hosted MCP proxy core

`@agent-collaboration/tool-host-core` composes the hosted MCP proxy with injected
organization authority, configuration, secrets, analytics, clock, IDs, limits,
logging and upstream transport creation. `createHostedMcpProxy(ports).handle`
accepts web `Request` objects and returns web `Response` objects.

Organization authority runs the same admission and approval-use rules over an
`OrganizationAuthorityStore`. Its atomic callback reads the clock, reads the row,
checks replay, prunes expired uses, checks the byte cap and awaits the write.
Success is returned after that callback commits. `createVolatileAuthorityStore`
is an in-memory conformance store; it makes no process-durability guarantee.
Cloudflare's adapter supplies the Durable Object transaction and its 512 KiB cap.

The core emits semantic `CallAnalytics` events. The Cloudflare adapter owns
Analytics Engine encoding, the existing limit values and SDK v1 upstream
transports. No host adapter or Workers type is imported by core production code.

The MCP server SDK selects its runtime through conditional exports. The packed
closure guard checks browser and workerd graphs with no Node dependencies, and
the ordinary Node graph with exactly one allowed edge: the SDK's own
`@modelcontextprotocol/server/dist/shimsNode.mjs` to `node:process`. No other
Node imports, PKCE dependency or host package is allowed. Core's own source has
no Node exception. Native tests use ordinary Node conditions; they do not force
browser exports. Workerd runtime proof belongs to the Cloudflare host suite.

From the repository root:

```sh
mise exec node@24.7.0 -- pnpm exec vitest run --project unit packages/tool-host-core
mise exec node@24.7.0 -- pnpm exec vitest run --project integration packages/tool-host-core
mise exec node@24.7.0 -- pnpm exec tsx scripts/verify-tool-host-core-closure.ts --fixtures
```

The authenticated integration journey uses signed JWT/JWKS and a controlled HTTP
MCP upstream, through the real MCP handler and injected transport. It checks
native listing, effects, approval first use, stored bytes and replay refusal.
It does not establish the real sign-in service, Durable Object persistence or
deployed analytics.
