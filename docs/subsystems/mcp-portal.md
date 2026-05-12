# MCP Portal

[Overview](../README.md) > Subsystems > MCP Portal

MCP Portal is an agent-facing MCP server facade and an upstream MCP client
aggregator. It exposes a small progressive-disclosure tool surface to the
agent, then calls configured upstream MCP servers from the gateway process.

## Model

Each OpenClaw agent gets a separate portal binding, and each Streamable HTTP
MCP transport session under that binding gets its own runtime scope. The
binding owns:

- the server-side agent identity and binding ID
- the allowed namespace/tool policy
- the server-generated MCP session ID for the active client transport
- upstream MCP clients
- the catalog snapshot
- the scoped search index

The agent never passes `agentId`, `bindingId`, upstream auth headers, env, or
upstream server config through portal tool inputs. `mcp-session-id` is generated
by the portal transport during MCP initialization and is used to scope cached
catalogs and upstream clients.

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
the scoped catalog after resolving the server-side binding policy, then builds
the search index from that scoped catalog. It does not build one global index
and post-filter results.

## Schema Contract

MCP JSON Schema is canonical. Zod is derived from JSON Schema for validation and
optional TypeScript helper generation. `mcp_portal_call` validates arguments
before calling upstream and returns per-call Zod-style validation issues when
input is invalid. If any call in a batch requires approval, no upstream calls in
that batch run until the server-injected approval nonce is granted. If Zod
cannot reconstruct a validator from the upstream schema, the portal returns
`schema_validation_unavailable` for that call and does not call that upstream
tool.

Tool VMs receive TypeScript/Zod helper packages and generated helper artifacts.
They do not receive upstream MCP credentials.

## Auth, Approval, And Redaction

Gateway code owns upstream MCP auth and MCP client connections. Remote MCP uses
Streamable HTTP by default, supports legacy HTTP+SSE, and supports stdio for
gateway-owned local servers. For SSE, auth headers must be applied to both the
initial stream request and subsequent POST requests.

Annotation trust is per upstream namespace. Untrusted upstream annotations do
not bypass approval. V1 does not accept model-visible approval tokens,
`commitToken`, or draft/commit fields. When the OpenClaw approval hook grants a
call, it injects an unadvertised one-time `portalApprovalNonce` nonce into the tool
call payload; the portal consumes that nonce once and still verifies the
canonical namespace, tool name, and validated arguments before calling upstream.

V1 redacts credential-shaped values from portal outputs, tool catalogs, and
errors, including configured credential header/env values before tools enter the
agent-scoped catalog. This is not general PII minimization. Upstream tool
responses can still contain names, emails, issue comments, and other user data. The
`upstream-response-middleware.ts` boundary is reserved for future PII and
content-policy filtering.

Intent verification is future work. A future draft-confirm-commit flow should
remain server-side and must not turn model-visible fields into proof of
approval.
