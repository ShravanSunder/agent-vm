# Hosted MCP proxy core

`@agent-collaboration/tool-host-core` composes the hosted MCP proxy with injected
workspace membership and replay authority, configuration, secrets, analytics, clock, IDs, limits,
logging and upstream transport creation. `createHostedMcpProxy(ports).handle`
accepts web `Request` objects and returns web `Response` objects.

The path `/workspaces/<workspace-id>/mcp` selects the workspace. The verifier checks
that workspace’s configured audience and signed workspace claim on each call. Its
Durable Object supplies membership and persona without a membership cache. Invalid
tokens and nonmembers return the same HTTP 401 `unknown-caller` envelope. A member
whose persona names no configured profile returns HTTP 401 `profile-unassigned`
before upstream discovery or dispatch.
There is no default profile. Each request also keeps one catalog generation for
its views, access checks and analytics. Across requests the proxy caches only
settled configuration and the last successful catalog snapshot with its discovery-start
time. Each request owns its engine, discovery runtime and pending work; concurrent
cold or expired requests discover independently. Failed discovery publishes no
new cache entry and may serve the previous complete snapshot. A cancelled request
cannot make the next request await its pending engine or refresh.

Workspace authority runs the same admission and approval-use rules over an
`WorkspaceAuthorityStore`. Its atomic callback reads the clock, reads the row,
checks replay, prunes expired uses, checks the byte cap and awaits the write.
Success is returned after that callback commits. `createVolatileAuthorityStore`
is an in-memory conformance store; it makes no process-durability guarantee.
Cloudflare's adapter supplies the Durable Object transaction and its 512 KiB cap.

The core emits semantic `CallAnalytics` events. The Cloudflare adapter owns
Analytics Engine encoding, the existing limit values and SDK v2 upstream
transports. No host adapter or Workers type is imported by core production code.

Tool Access owns provider and secret schemas; core re-exports those contracts and
owns hosted workspace configuration, binding lookup and environment-only enforcement.
The core continues to compose Engine's `createMcpGateway`; standalone Portal is
a separate wire projection of the same Engine.

The shared packed closure guard checks first-party code under ordinary Node
conditions, with no Node imports. Its existing SDK-server shim check permits
only the exact `shimsNode.mjs` to `node:process` edge. The full Worker closure uses
Wrangler's bundler conditions and browser-field resolution, rejects non-literal
imports and has no Node exception. PKCE resolves to its browser build there.
Native tests use ordinary Node conditions; workerd runtime proof belongs to the
Cloudflare host suite.

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

Agent management uses a separate write port. `createWorkspaceAgentManagement`
registers and links before writing membership, removes membership before unlinking,
and removes every configured organization membership before global disable. Failed
second writes stay pending in the affected workspace objects and retry under a live
owner command. Retirement supersedes a pending unlink without calling it. No MCP
module can reach this write port; the architecture audit traces its import closure.
