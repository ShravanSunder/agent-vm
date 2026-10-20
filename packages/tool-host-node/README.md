# Node Tool Portal host

`@agent-collaboration/tool-host-node` composes the portable Tool Portal engine with
Node HTTP, stdio, filesystem configuration, catalog compilation and durable
operation records. It selects HTTP/SSE or stdio upstream runtimes from trusted
provider configuration. The engine owns admission and dispatch.

Build the workspace with `mise exec node@24.7.0 -- pnpm build`. The built CLI is
`node packages/tool-host-node/dist/bin/tool-host-node.js <configuration.jsonc>`.
HTTP startup prints a JSON readiness record; MCP initialization verifies serving
readiness. Stdio stdout contains only protocol messages.

The configuration requires an authority, revision, explicit store directory,
`operationStoreBounds.maximumOperations` and `operationStoreBounds.maximumRecordBytes`,
complete profiles, credential assignments, MCP providers, exposure mode and
listener. HTTP plaintext binds loopback only and checks configured Host/Origin
bounds. This slice supports the `not-configured` workspace binding and registered
MCP providers. Unsupported bindings refuse startup. Unix sockets are deferred.

`startNodeHost` accepts an injected `secrets.resolve` port. Its input is the copied
secret-reference contract; credentials stay in privileged transport headers or
environment variables. The CLI supplies an environment-only resolver. Other
secret stores require an embedding application's resolver. An omitted approval
port refuses protected work as unavailable; it does not grant approval.

Compact `mcp_portal_call` uses each `calls[].id` as its operation item. In catalog
exposure, every native call must supply a nonempty, bounded string in
`_meta['tool-portal/operation-item']`. Missing or malformed metadata refuses the
call before dispatch. Connect in compact exposure mode if the client cannot carry
that metadata. Independent actions require different items; retries and
reconnects retain the original item. JSON-RPC IDs and session IDs never choose
operation identity. Tests cover SDK 1.29.0 Streamable HTTP and explicit JSON-RPC
`2025-06-18` stdio clients. They do not establish native IDE client behavior.

The public store keeps every usable operation. It uses the repository's copied
crash-durable record mechanism and SQLite ownership fence, with no controller
dependency. Conditional arm transitions permit one portal dispatch. A lost reply
after arm remains ambiguous; lookup never dispatches. This does not promise
exactly-once effects from third-party providers. Caller-scoped lookup rechecks
the injected current context. The opaque credential admission identity includes the
configured service generation, so prior-generation approval receipts refuse after
a restart. The stable authority/agent/item operation key and its history survive
that change. Store or writer-fence failure prevents new work.

Store bounds are required positive integers with no defaults. The record-byte
bound must be at least the copied 4 MiB per-call result limit plus a 32 KiB
schema-derived envelope. Capacity is reserved before arm, counted again on
reopen, and never evicts history. Existing operations remain readable and usable
at capacity. A failed durability acknowledgement retains its reservation until
reopen. Capacity and storage failures have separate fixed diagnostics.
Post-redaction results also meet the copied per-call limit; exceeding it returns
public `ambiguous` and retains the armed record, preventing replay even though
the provider effect is known to have occurred. Production sizing is not chosen.

This slice does not earn R14 or C5 deployment readiness. Sessions, agent scopes,
incoming stdio message bytes, generated helper/artifact bytes and aggregate
gateway output have no explicit host bounds here; S3c owns those categories.

The `catalog-typescript` entrypoint preserves generator v2 and SDK contract v1
bytes. The copied MCP-provider schema retains `agent-vm:mcp:1`. Frozen fixtures
come from the unchanged original generators. Package proof permits exactly
`@agent-vm/oauth-broker-contracts` and `@agent-vm/agent-portal-sdk` as contract/client
dependencies until S4 relocates that artifact. Other `@agent-vm` packages,
Gondolin and secret-management are forbidden. Third-party computed loaders are
statically unenumerated; packed-consumer inventory and runtime blocking cover
that limit.
