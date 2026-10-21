# Node Tool Portal host

`@agent-collaboration/tool-host-node` runs the portable MCP proxy on Node 24.
It loads trusted configuration, resolves provider credentials, discovers the
organization's catalog before opening its listener, and routes calls through
`tool-engine`'s dispatcher. HTTP/SSE and stdio upstream clients retain SDK v1
until the outbound protocol decision is settled.

Build with `mise exec node@24.7.0 -- pnpm build`. Run the built CLI with
`mise exec node@24.7.0 -- node packages/tool-host-node/dist/bin/tool-host-node.js <configuration.jsonc>`.
HTTP startup prints a JSON readiness record. Stdio stdout carries only MCP
messages.

Inbound HTTP and stdio accept MCP 2026-07-28 only. Each HTTP request authenticates
independently, and a stdio connection uses its configured agent. HTTP binds
loopback and checks the configured Host and Origin policy. It issues no MCP
session IDs; incoming session IDs are ignored. GET and DELETE return 405.

The plain MCP address selects `indirect`: four `mcp_portal_*` search and call
tools. Adding `?tools=direct` selects `direct`: the caller's tools plus those
same four tools. The address chooses presentation, and cannot change access.
The configuration's exposure field is retained; HTTP presentation follows the
request address and stdio uses indirect presentation. Every list result has
`cacheScope: "private"` and `ttlMs: 60000`. Direct pages hold whole tools and
limit the serialized result, including cursor and cache fields, to 1 MiB.
JSON-RPC framing is outside that budget. Incoming MCP requests have no added
body-size cap.

`startNodeHost` accepts `secrets.resolve`; the CLI provides an environment
resolver. Provider secrets stay in privileged headers or environment variables
and are redacted from catalogs, results and diagnostics. An embedding application
may supply `approvalKeysByAgent` for the proxy's signed approval tokens, or the
existing `approvals` port. An absent approval authority refuses protected work.
Tokens arrive in `portalApprovalToken` on `mcp_portal_call`, or in
`_meta['agent-vm/tool-portal-approval-token']` on a direct call. The host keeps
one-use token tracking and protected-call entries in memory for its process
lifetime. Unprotected calls are unrecorded and may run again when retried.
The retained `storeDirectory` configuration field creates no files.
Direct calls require no operation-item metadata.

The `catalog-typescript` entrypoint preserves generator v2 and SDK contract v1
bytes. The copied provider schema retains `agent-vm:mcp:1`. Production imports
permit `@agent-vm/oauth-broker-contracts` and `@agent-vm/agent-portal-sdk` until
the later package cutover. Other agent-vm packages and VM providers are forbidden.
Standalone `tool_portal_*`, JSON and artifact routes and the Portal SDK's Node
client migration belong to the following standalone-core slice.

If a provider is down during startup discovery, healthy providers remain available
on the plain address and discovery diagnostics identify the failed namespace.
The next catalog-dependent request retries only failed providers. Direct
`tools/list` returns bounded HTTP 503 diagnostics while discovery is incomplete.
A complete catalog refreshes on the first access after 60 seconds; a failed
refresh keeps the previous complete tools and adds diagnostics. There is no
background retry or refresh timer.
