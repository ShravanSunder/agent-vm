# MCP Portal

[Overview](../README.md) > Subsystems > MCP Portal

MCP Portal is an agent-facing tool facade and an upstream MCP client aggregator.
Managed OpenClaw uses native OpenClaw tools that call `@agent-vm/mcp-portal/core`
inside the gateway VM. External MCP clients use the separate
`mcp-portal mcp-proxy serve` adapter.

## Model

Each OpenClaw agent calls the same four native portal tools. The plugin resolves
the agent from OpenClaw's trusted `ctx.agentId` and the loaded
`mcp-portal.config.jsonc`; the model never sends `agentId` as a portal tool
argument. Each tool call gets a runtime scope. The agent scope owns:

- the OpenClaw-provided agent identity
- the allowed namespace/tool policy
- upstream MCP clients
- the catalog snapshot
- the scoped search index

The agent never passes upstream auth headers, env, or upstream server config
through portal tool inputs.

The OpenClaw plugin injects prompt context through OpenClaw hooks and gates
portal calls before native tool execution. OpenClaw's hook-approved params are
the in-process approval boundary for managed native tools.

## Agent-Facing Tools

The agent sees only:

- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`

Calls use `namespace + toolName` as the canonical identity. `toolRef` is a
stable reference for links, cursors, caches, and exact lookup; it does not
replace the namespace.

All portal tools are batch-shaped. `mcp_portal_list`, `mcp_portal_search`, and
`mcp_portal_describe` accept `requests: [{ id, ... }]`; `mcp_portal_call`
accepts `calls: [{ id, namespace, toolName, arguments }]`. Every response uses
`{ ok, results, errors, diagnostics }`, where `results` is keyed by request/call
`id`. Each `results[id]` is a discriminated result:
`{ ok: true, input, output }` or `{ ok: false, input, error }`. Duplicate IDs
reject the whole portal request. `diagnostics` carries batch-level partial
discovery state, such as an upstream namespace that failed while healthy
namespaces remained available.

## Catalog And Search Isolation

Denied tools never enter an agent's catalog or search index. The portal builds
the scoped catalog after resolving the server-side agent policy, then builds
the search index from that scoped catalog. It does not build one global index
and post-filter results.

Namespace exposure is fail closed. Empty namespace config exposes no upstream
namespaces. `enabledToolsByNamespace` further narrows the catalog before
hidden-tool policy, graph construction, or search indexing. A missing namespace
entry or an empty list means "all tools in this enabled namespace"; list one or
more tool names to narrow that namespace, and use `hiddenToolsByNamespace` for
explicit exclusions.

## Schema Contract

MCP JSON Schema is canonical. Zod is derived from JSON Schema for validation and
optional TypeScript helper generation. `mcp_portal_call` validates arguments
before calling upstream and returns per-call Zod-style validation issues when
input is invalid. If any call in a batch requires approval, no upstream calls in
that batch run until the plugin-injected approval token is granted. If Zod
cannot reconstruct a validator from the upstream schema, the portal returns
`schema_validation_unavailable` for that call and does not call that upstream
tool.

Tool VMs receive TypeScript/Zod helper packages and generated helper artifacts.
They do not receive upstream MCP credentials.

Authored deployment config is JSONC. `system.jsonc` points at
`config/schemas/system.schema.json`; gateway MCP config files point at
`../../schemas/mcp.schema.json` and `../../schemas/mcp-portal.schema.json`.
Those schema files are emitted by `agent-vm init` and
kept in sync from Zod schemas for editor tooling. Runtime
migration gates use `schemaVersion`.

## Auth, Approval, And Redaction

`@agent-vm/mcp-portal/core` owns upstream MCP auth and MCP client connections.
Remote MCP uses Streamable HTTP by default, supports legacy HTTP+SSE, and
supports stdio for gateway-owned local servers. For SSE, auth headers must be
applied to both the initial stream request and subsequent POST requests.

Managed OpenClaw gateway mode does not start a portal HTTP server, does not open
guest port `18790`, and does not require `MCP_PORTAL_SERVER_SECRET`. The
OpenClaw plugin registers native `mcp_portal_*` tools and calls `/core` directly
with trusted OpenClaw context. `agent-vm` materializes effective MCP Portal
config before gateway boot and injects only the runtime environment needed by
configured upstream providers. Generated provider-secret environment names are
provider-scoped, such as `AGENT_VM_MCP_LINEAR_AUTHORIZATION`, so two upstream
providers can use the same authored header or env key without colliding.

External `/mcp-proxy` mode is different: `mcp-portal mcp-proxy serve` runs on the
operator host, resolves its configured auth secrets at process startup, and
authenticates callers before constructing trusted agent scope for `/core`. When
that external process must resolve 1Password refs, it uses `@agent-vm/secrets`
and accepts `AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=env`, `op-cli`, or `keychain`
plus the matching source-specific env settings. If no token source is
configured, env-only MCP Portal configs still run without 1Password access.
The built-in HTTP bearer server is loopback-only; exposing MCP Portal publicly
requires an outer TLS reverse proxy and an explicit credential `proxyUrl`.

Annotation trust is per upstream namespace. Untrusted upstream annotations do
not bypass approval. V1 does not accept model-visible approval tokens,
`commitToken`, or draft/commit fields. In managed OpenClaw mode, the
`before_tool_call` hook is the approval boundary: OpenClaw delivers the
post-approval params to the native tool, and the native tool executes exactly
those params through `/core`.

V1 redacts credential-shaped values from portal outputs and errors. Tool
catalogs use exact configured credential value redaction only, so
legitimate documentation examples such as `Authorization: Bearer EXAMPLE` are
not clobbered before indexing. This is not general PII minimization. Upstream
tool responses can still contain names, emails, issue comments, and other user
data. The `upstream-response-middleware.ts` boundary is reserved for future PII
and content-policy filtering.

Intent verification is future work. A future draft-confirm-commit flow should
remain server-side and must not turn model-visible fields into proof of
approval.

## Local Smoke Verification

`packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`
boots a real controller, a real OpenClaw gateway VM, the OpenClaw plugin loader,
native MCP Portal tools, and a fake upstream MCP server. Run it explicitly:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

The smoke proves the gateway can load the plugin, register native portal tools,
discover fake upstream tools, call read-only tools, and reject approval-gated
writes without approval. It intentionally avoids real upstream credentials.
