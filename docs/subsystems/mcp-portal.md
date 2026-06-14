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

Each profile is a complete portal policy. Profiles do not inherit from or merge
with other profiles; `agents.<agentId>.profile` selects exactly one profile.
Namespace exposure is fail closed. Empty `profiles.<name>.namespaces` exposes no
upstream namespaces. Each namespace colocates its policy:
`tools.allow`, `tools.deny`, `calls.withoutApproval`, and
`calls.requiresApproval`. `tools.allow` is `*` for every discovered tool or an
explicit list of visible tool names; `tools.deny` removes names from that
visible catalog. `calls.withoutApproval` and `calls.requiresApproval` use the
same selector shape. A visible tool that is not matched by either call selector
is listed for discovery but blocked at execution time.

## Schema Contract

MCP JSON Schema is canonical. Zod is derived from JSON Schema for validation and
optional TypeScript helper generation. `mcp_portal_call` validates arguments
before calling upstream and returns per-call Zod-style validation issues when
input is invalid. If Zod cannot reconstruct a validator from the upstream schema,
the portal returns
`schema_validation_unavailable` for that call and does not call that upstream
tool.

Tool VMs receive TypeScript/Zod helper packages and generated helper artifacts.
They do not receive upstream MCP credentials.

Authored deployment config is JSONC. `system.jsonc` points at
`config/schemas/system.schema.json`; gateway MCP config files point at
`../../schemas/mcp.schema.json` and `../../schemas/mcp-portal.schema.json`.
Those schema files are emitted by `agent-vm init` and kept in sync from Zod
schemas for editor tooling. Runtime compatibility checks use `schemaVersion`.

## Auth, Approval, And Redaction

`@agent-vm/mcp-portal/core` owns upstream MCP auth and MCP client connections.
Remote MCP uses Streamable HTTP by default, supports legacy HTTP+SSE, and
supports stdio for gateway-owned local servers. For SSE, auth headers must be
applied to both the initial stream request and subsequent POST requests.

### Stdio Runtime Environment

MCP Portal starts stdio providers with explicit provider secrets plus a narrow
gateway runtime environment allowlist. This avoids leaking arbitrary gateway
environment variables while preserving runtime settings required by package
launchers inside Gondolin.

Inherited runtime variables:

- `NODE_EXTRA_CA_CERTS`
- `NODE_OPTIONS`
- `REQUESTS_CA_BUNDLE`
- `SSL_CERT_FILE`
- `UV_CACHE_DIR`

Use `transport.env` for provider credentials such as `PERPLEXITY_API_KEY` or
`TAVILY_API_KEY`. Prefer `secretPolicies.<name>.injection: "http-mediation"`
when the stdio MCP server reads the env value and sends it in outbound HTTP
headers or other Gondolin-supported request locations. The effective config
rewrites the authored secret to a generated `AGENT_VM_MCP_*` env reference; the
gateway process and stdio child receive a placeholder value, while Gondolin
substitutes the raw secret only for configured hosts. Use raw `env` injection
only as an explicit exception for providers that cannot operate with
placeholders.

Do not rely on whole-process environment inheritance.

For stdio MCP providers, prefer
`secretPolicies.<name>.injection: "http-mediation"` when the provider uses the
secret in HTTP headers or query strings to call a remote API. The controller
resolves the real secret on the host, gives the gateway VM only a generated
placeholder environment value, and passes the real value to Gondolin as a
host-restricted mediated secret. The stdio child process reads the placeholder
from `transport.env`; Gondolin substitutes the real value only on outbound
requests to the configured `hosts`.

Use `secretPolicies.<name>.injection: "env"` only when the provider cannot work
with HTTP mediation, such as protocols that place credentials in request bodies,
opaque WebSocket payloads, or other bytes Gondolin cannot inspect. Raw env
provider secrets must be named intentionally in `zones[].gateway.rawEnvSecrets`.

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
that external process must resolve 1Password refs, it uses `@agent-vm/secret-management`
and accepts `AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=env` or `keychain` plus the
matching source-specific env settings. Token bootstrap does not support ambient
`op` CLI auth; service-account tokens must come from an environment variable or
macOS Keychain. If no token source is configured, env-only MCP Portal configs
still run without 1Password access. The
built-in HTTP bearer server is loopback-only; exposing MCP Portal publicly
requires an outer TLS reverse proxy and an explicit credential `proxyUrl`.

Upstream MCP provider URLs are trusted deployment config. Runtime validation
rejects non-HTTP schemes such as `file:` but does not reject loopback or
private-network hosts. That is deliberate: local sidecars, host-mounted fake
upstreams, and private service MCP providers are supported deployment shapes.
Do not import arbitrary third-party MCP provider definitions into
`mcp.config.jsonc` without review. If a future onboarding flow accepts
less-trusted provider config, it should add an explicit per-provider network
allowlist or operator approval step before enabling private-network targets,
not a blanket ban that would break loopback sidecars.

Annotation trust is per upstream namespace. Untrusted upstream annotations do
not bypass approval. V1 does not accept model-visible approval tokens,
`commitToken`, or draft/commit fields. In managed OpenClaw mode, the
`before_tool_call` hook is the approval boundary: OpenClaw delivers the
post-approval params to the native tool, and the native tool executes exactly
those params through `/core`.

### Item-Level Approval In Batches

`mcp_portal_call` accepts batches, but approval is evaluated per inner MCP call.
When a managed OpenClaw native-tool batch mixes approval-free calls with
approval-required calls, the `before_tool_call` hook prompts for only the
approval-required subset. After approval, the plugin injects a short-lived
server-only `portalApprovalToken` whose digest set covers only that subset.
MCP Portal core then evaluates the full batch item by item:

- approval-free calls execute normally
- blocked calls return item-level `call_blocked` errors
- approval-required calls covered by the approved token execute normally
- approval-required calls without a valid token return item-level approval
  errors

The prompt text lists only the approval-required calls. Approval-free, blocked,
or hidden siblings remain outside the approval token and are still handled by
core policy per item. Direct MCP proxy clients that call core without the
OpenClaw hook see item-level approval errors until they provide a valid
server-issued approval token.

The token is bound to the approved agent id, exact namespace/tool names, and
argument hashes. It is short-lived and single-use in both direct MCP proxy mode
and OpenClaw native plugin mode. This preserves parallel safe reads while
keeping writes and sensitive calls behind the configured approval policy.

V1 redacts credential-shaped values from portal outputs and errors. Tool
catalogs use exact configured credential value redaction only, so
legitimate documentation examples such as `Authorization: Bearer EXAMPLE` are
not clobbered before indexing. This is not general PII minimization. Upstream
tool responses can still contain names, emails, issue comments, and other user
data. The `upstream-response-middleware.ts` boundary is reserved for future PII
and content-policy filtering.

### Runtime diagnostics

MCP Portal returns one result shape in both OpenClaw native plugin mode and
direct MCP proxy mode:

```json
{
	"auditEvents": [
		{
			"kind": "upstream_mcp_failed",
			"namespace": "tavily",
			"phase": "connect",
			"message": "tavily: connect failed: Authentication failed",
			"hint": "remote MCP connection failed; verify URL, auth header, network egress, and transport kind."
		}
	],
	"structuredContent": {
		"diagnostics": []
	}
}
```

OpenClaw native tools return this value in `details`. Direct MCP proxy tools
return the same value as JSON text content. Use
`agent-vm validate --mcp-live` after changing providers, secrets, or profile
tool names.

Discovery failures do not disable catalog caching entirely. If at least one
allowed upstream namespace is discovered and another namespace fails, MCP Portal
caches the degraded catalog and its `discoveryFailures` diagnostics for a short
TTL, currently `min(profile catalogTtlMs, 10s)`. This protects healthy upstreams
from being re-discovered on every portal call while a peer namespace is flapping.
Agent-scope and transport-session invalidation still drops degraded cache
entries immediately.

Intent verification is future work. A future draft-confirm-commit flow should
remain server-side and must not turn model-visible fields into proof of
approval.

## Local E2E Verification

`packages/agent-vm/src/integration-tests/openclaw-mcp-portal.openclaw.e2e.test.ts`
boots a real controller, a real OpenClaw gateway VM, the OpenClaw plugin loader,
native MCP Portal tools, and a fake upstream MCP server. Run it explicitly:

```bash
mise exec -- pnpm test:e2e:openclaw
```

The e2e proof shows the gateway can load the plugin, register native portal tools,
discover fake upstream tools, call read-only tools, and reject approval-gated
writes without approval. It intentionally avoids real upstream credentials.
