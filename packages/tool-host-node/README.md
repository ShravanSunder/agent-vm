# Node Tool Portal host

`@agent-collaboration/tool-host-node` runs the portable MCP proxy on Node 24.
It loads trusted configuration, resolves provider credentials, discovers the
organization's catalog before opening its listener, and routes calls through
`tool-engine`'s dispatcher. Outbound HTTP/SSE and stdio use MCP SDK v2 auto
negotiation: modern servers stay on MCP 2026-07-28, and older servers negotiate
their supported protocol. `auto-http` tries Streamable HTTP before deprecated SSE.

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
The old `tool-portal` standalone API remains unchanged until the S4 cutover.

## Standalone Tool Portal

Embedding applications supply current caller/access facts to
`createNodeStandaloneToolPortalService`. Its neutral core in `tool-engine/dispatch`
uses the real Access assessor and S2 dispatcher. `createStandaloneMcpProviderBackend`
adapts the existing MCP connector and a caller-filtered shared catalog; the host
must complete organization discovery before opening listeners. Managed context,
CLI and OAuth facts remain outside this host.

`startStandaloneToolPortalEntrypoints` starts the explicitly configured MCP, JSON
and scoped-stdio listeners over that service. The MCP route exposes
`tool_portal_list`, `tool_portal_search`, `tool_portal_describe` and
`tool_portal_call`, with the full Portal result in `structuredContent`. Its text
projection retains the existing 4,096-byte bound. MCP requests have no additional
incoming limit. The JSON route accepts `{operation, request}`, with a 64 KiB limit
on declared and actual UTF-8 bytes. These are programmatic entrypoints; the proxy
CLI configuration remains separate.

The embedding host supplies the signed-batch HMAC credentials and token issuer.
Approval arrives in `_meta['agent-vm/tool-portal-approval-token']` for MCP, or the
`x-agent-vm-tool-portal-approval-token` JSON header. The in-memory coordinator
binds the ordered protected subset (1–50 calls), caller, credential version,
semantic revisions, surface and process generation, and consumes it once.
No approval issuance or decision endpoint is exposed.

Artifacts use standard MCP `resources/read`; the injected artifact owner validates
the complete reference, caller, expiry and byte range. The Node adapter preserves
the opaque URI, MIME type and binary bytes. Reads advertise private cache scope
with `ttlMs: 0`; tool lists advertise private scope with `ttlMs: 60000`.

The Portal SDK Node client pins MCP 2026-07-28 without a prior protocol or legacy
fallback. Its HTTP request cancellation uses native stream closure, with an
effective canonical-result grace of zero; the existing grace-expired error and
uncertain/no-replay semantics remain. This is provisional A, pending owner
question 9 (B would hold the HTTP stream through grace). Stdio keeps its existing
canonical-result grace. Python and private UDS clients are unchanged.

If a provider is down during startup discovery, healthy providers remain available
on the plain address and discovery diagnostics identify the failed namespace.
The next catalog-dependent request retries only failed providers. Direct
`tools/list` returns bounded HTTP 503 diagnostics while discovery is incomplete.
A complete catalog refreshes on the first access after 60 seconds; a failed
refresh keeps the previous complete tools and adds diagnostics. There is no
background retry or refresh timer.

## Controlled upstream test fixture

Workspace tests import `@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server` for the controlled modern-only upstream HTTP server and its counted observations. It retains the fixture API and provider payloads; SDK v2 adds its reserved server identity metadata. Hono and its Node server are dev dependencies for workspace tests, so this entry is not supported by an isolated production-only package install. The production root and executable do not import or export it.

The private fixture in `packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts` remains an independent old-only source oracle. Its old public package entry is retired.

## Live DeepWiki check

After building the Node host, run this account-free manual check from the repository root:

```bash
mise exec node@24.7.0 -- node packages/tool-host-node/src/manual-tests/deepwiki-outbound.ts
```

It starts the built gateway, lists DeepWiki tools, and makes one read-only
`ask_wiki_question` call against `modelcontextprotocol/typescript-sdk`. The JSON output
records advertised and negotiated protocol versions, wire attempts, the source
commit, Node version, built file hashes, and the result. It fails if advertised
versions are absent or the selected wire version disagrees. This external check
runs manually and is outside the CI inventory.
