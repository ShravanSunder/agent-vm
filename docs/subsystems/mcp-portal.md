# MCP Portal

[Overview](../README.md) > Subsystems > MCP Portal

MCP Portal is an MCP-specific provider backend and upstream MCP client
aggregator. Managed Hermes reaches MCP-backed capabilities through Tool
Portal. External MCP clients use the separate `mcp-portal mcp-proxy serve`
adapter.

Tool Portal is a separate cross-backend facade. It can expose MCP-backed
capabilities, controller-owned host actions, and Tool VM runner-backed
capabilities through the same portal-neutral list/search/describe/call
vocabulary. When Tool Portal exposes MCP-backed capabilities, it composes MCP
Portal through `@agent-vm/mcp-portal/mcp-provider-backend`; it does not call or
register the native `mcp_portal_*` model tool names.

## Model

Managed Gateway mode has one service-wide Tool Portal service, one MCP provider
runtime, and one configured `managedMcp.guestPort` for all agents in the zone.
It does not create one MCP backend instance or listener per agent. Each call
carries trusted invocation context supplied by the framework adapter; the model
never sends `agentId` as a portal tool argument. Tool Portal verifies the
trusted agent assignment and profile revision, then selects that profile's
capability policy for the call. The invocation scope contains:

- the trusted agent and session identity
- the selected complete profile
- the allowed capability/tool policy for the active surface
- the catalog and search view filtered for that invocation

The agent never passes upstream auth headers, env, or upstream server config
through portal tool inputs.

Managed `calls.requiresApproval` is authorized by the controller approval
authority. Tool Portal reserves the exact call intent and dispatches only under
the resulting controller reservation or grant; standalone MCP Portal HMAC
tokens are not authority for managed calls. If any managed approval selector
effectively admits a tool, the zone must declare `approvalAccess`; static
validation and gateway preflight fail closed instead of supplying a default.

## MCP Portal And Tool Portal Modes

Only one model-visible policy authority should own a capability for a given
agent/profile.

- Standalone MCP Portal mode exposes `mcp_portal_list`,
  `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
  `mcp.config.jsonc` owns providers and `mcp-portal.config.jsonc` owns the
  visible MCP namespace/tool policy plus standalone bearer/HMAC settings.
- Tool Portal mode exposes portal-neutral list/search/describe/call adapters.
  Managed Gateway authors `mcp.config.jsonc` plus `tool-portal.config.jsonc`.
  The latter owns complete profiles, `capabilities`, explicit `backend.kind`
  bindings, and call/tool selectors. MCP-backed capabilities are projected into
  an internal MCP compatibility view and executed by MCP Portal's MCP provider
  backend.

MCP Portal still owns upstream MCP provider sessions, upstream MCP transport
handling, provider secret resolution, upstream MCP JSON Schema validation, and
MCP-specific redaction. Tool Portal owns whether a capability is model-visible,
the cross-backend approval decision, the catalog-static backend binding, and
the portal-neutral result contract.

Managed `agent-vm validate` loads `tool-portal.config.jsonc` directly. A
generated `mcp-portal.config.<generation>.jsonc` may still exist in the managed
cache as a transitional compatibility projection, but managed deployments do
not author or load `mcp-portal.config.jsonc` as policy authority.

## Standalone MCP Portal Agent-Facing Tools

In standalone MCP Portal mode, the agent sees only:

- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`

Managed Hermes agents do not see these native MCP Portal tools. Managed Hermes
exposes `tool_portal_list`, `tool_portal_search`,
`tool_portal_describe`, and `tool_portal_call`; Tool Portal delegates
MCP-backed capabilities to MCP Portal as an internal backend.

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

## Standalone MCP Portal Catalog And Search Isolation

Denied tools never enter an agent's catalog or search index. The portal builds
the scoped catalog after resolving the server-side agent policy, then builds
the search index from that scoped catalog. It does not build one global index
and post-filter results.

In standalone `mcp-portal.config.jsonc`, each profile is a complete portal
policy. Profiles do not inherit from or merge with other profiles;
`agents.<agentId>.profile` selects exactly one profile. Namespace exposure is
fail closed. Empty `profiles.<name>.namespaces` exposes no upstream namespaces.
Each namespace colocates its policy:
`tools.allow`, `tools.deny`, `calls.withoutApproval`, and
`calls.requiresApproval`. `tools.allow` is `*` for every discovered tool or an
explicit list of visible tool names; `tools.deny` removes names from that
visible catalog. `calls.withoutApproval` and `calls.requiresApproval` use the
same selector shape. A visible tool that is not matched by either call selector
is listed for discovery but blocked at execution time.

## Schema Contracts

Upstream MCP tool JSON Schema is canonical for MCP provider calls. MCP Portal
derives Zod validators from upstream JSON Schema for argument validation and
optional TypeScript helper generation. `mcp_portal_call` validates arguments
before calling upstream and returns per-call Zod-style validation issues when
input is invalid. If Zod cannot reconstruct a validator from the upstream schema,
the portal returns
`schema_validation_unavailable` for that call and does not call that upstream
tool.

Portal-neutral contracts are different. `@agent-vm/agent-portal-sdk`,
`@agent-vm/controller-execution-contracts`, Tool Portal config contracts, and
the MCP provider backend seam use explicit Zod v4 schemas as the source of
truth. JSON Schema artifacts for these portal contracts are generated from Zod
with `z.toJSONSchema()`, not hand-written separately.

Tool VMs receive TypeScript/Zod helper packages and generated helper artifacts.
They do not receive upstream MCP credentials.

Authored deployment config is JSONC. `system.jsonc` points at
`config/schemas/system.schema.json`; gateway MCP config files point at
`../../schemas/mcp.schema.json` plus either
`../../schemas/tool-portal.schema.json` for managed Gateway policy or
`../../schemas/mcp-portal.schema.json` for standalone MCP Portal policy. Those
schema files are emitted by `agent-vm init` and kept in sync from Zod schemas
for editor tooling. Runtime compatibility checks use `schemaVersion`.

## Auth, Approval, And Redaction

`@agent-vm/mcp-portal/core` owns upstream MCP auth and MCP client connections.
Remote MCP uses Streamable HTTP by default, supports legacy HTTP+SSE, and
supports stdio for gateway-owned local servers. For SSE, auth headers must be
applied to both the initial stream request and subsequent POST requests.

Provider secret references describe storage separately from presentation.
`source: "environment"` and `source: "1password"` always resolve to the raw
secret value. Omit `format` when the upstream wants that raw value. Add
`format: { "kind": "bearer" }` when the upstream wants `Bearer <token>`, or
`format: { "kind": "prefix", "prefix": "Token" }` for a provider-specific
scheme. Prefix presentation always inserts exactly one space after the prefix;
the prefix itself must not contain whitespace.

Managed Gateway effective-config generation preserves `format` on the generated
provider environment reference, but keeps `runtimeEnvironment` and
`runtimeMediatedSecrets` raw. The provider runtime applies presentation after
resolving the current raw value or Gondolin placeholder. This avoids storing
duplicate 1Password fields such as one raw Linear API token for CLI use and a
second `Bearer ...` field for MCP use.

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
substitutes the raw secret only for configured hosts. When a `format` is present,
the stdio child receives the presented placeholder, such as
`Bearer GONDOLIN_SECRET_...`; Gondolin substitutes the placeholder inside
supported outbound HTTP headers. Use raw `env` injection only as an explicit
exception for providers that cannot operate with placeholders.

Do not rely on whole-process environment inheritance.

For stdio MCP providers, prefer
`secretPolicies.<name>.injection: "http-mediation"` when the provider uses the
secret in HTTP headers or query strings to call a remote API. The controller
resolves the real secret on the host, gives the gateway VM only a generated
placeholder environment value, and passes the real value to Gondolin as a
host-restricted mediated secret. The stdio child process reads the placeholder
from `transport.env`; Gondolin substitutes the real value only on outbound
requests to the configured `hosts`. If the env ref has `format`, the provider
runtime formats the placeholder before the child sees it; the host-side mediated
secret state still stores the raw resolved value.

Use `secretPolicies.<name>.injection: "env"` only when the provider cannot work
with HTTP mediation, such as protocols that place credentials in request bodies,
opaque WebSocket payloads, or other bytes Gondolin cannot inspect. Raw env
provider secrets must be named intentionally in `zones[].gateway.rawEnvSecrets`.

Managed Gateway mode does not start the standalone MCP Portal server and does
not require `MCP_PORTAL_SERVER_SECRET`. The managed Tool Portal service instead
uses `zones[].toolPortal.managedMcp.guestPort` when its bounded MCP surface is
attached. MCP Portal remains the shared MCP-provider backend inside that one
service. `agent-vm` materializes effective provider and Tool Portal config before
gateway boot and injects only the runtime environment needed by configured
upstream providers. Generated provider-secret environment names are
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
`commitToken`, or draft/commit fields. In managed mode, the controller approval
authority binds the trusted principal, exact call, arguments, backend kind, and
active semantic revisions before dispatch. Managed Tool Portal does not accept
standalone `portalApprovalToken` or HMAC material as authority.

### Item-Level Approval In Batches

`mcp_portal_call` accepts batches, but approval is evaluated per inner MCP call.
When a batch mixes approval-free calls with approval-required calls:

- approval-free calls execute normally
- blocked calls return item-level `call_blocked` errors
- approval-required calls return item-level `approval_required` errors
- the whole outer `mcp_portal_call` is not converted into one approval prompt

Agents should retry only the approval-required calls in a separate
`mcp_portal_call` batch. This behavior belongs to standalone MCP Portal
native-tool mode. In that mode, a homogeneous approval-required batch triggers
the plugin approval prompt. After the operator approves it, the plugin injects a
short-lived server-only `portalApprovalToken`, and MCP Portal core verifies the
token before executing the gated calls.

The token is bound to the approved agent id, exact namespace/tool names, and
argument hashes. It is short-lived and single-use in standalone MCP Portal
direct proxy mode. This preserves parallel safe reads while
keeping writes and sensitive calls behind the configured approval policy.

V1 redacts credential-shaped values from portal outputs and errors. Tool
catalogs use exact configured credential value redaction only, so
legitimate documentation examples such as `Authorization: Bearer EXAMPLE` are
not clobbered before indexing. This is not general PII minimization. Upstream
tool responses can still contain names, emails, issue comments, and other user
data. The `upstream-response-middleware.ts` boundary is reserved for future PII
and content-policy filtering.

### Runtime diagnostics

MCP Portal returns one result shape in both managed Hermes Tool Portal backend
mode and standalone direct MCP proxy mode:

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

Managed Tool Portal tools return this value in `details`. Direct MCP proxy
tools return the same value as JSON text content. Use
`agent-vm validate --mcp-live` after changing managed providers, secrets, or
profile tool names. Managed live validation follows only capabilities whose
`backend.kind` is `mcp_provider`; other backend kinds are not interpreted as MCP
provider namespaces.

Intent verification is future work. A future draft-confirm-commit flow should
remain server-side and must not turn model-visible fields into proof of
approval.

## Backend Availability Boundary

`tool-portal.config.jsonc` requires an explicit backend kind for every managed
capability. Schema acceptance is not runtime availability proof. MCP-provider
composition and controller approval authority are covered here; later Tool VM
runner and other backend/process cutovers require their own implementation and
proof before deployment docs may treat them as available.

## Local E2E Verification

The managed Tool Portal/MCP-provider composition is covered by the package
integration suites, while the retained live framework boundary runs in the
Hermes E2E project:

```bash
pnpm vitest run packages/gateway-runtime/src/managed-tool-portal-composition.integration.test.ts
mise exec -- pnpm test:e2e:hermes
```

The integration proof uses deterministic upstream providers to verify discovery,
read-only calls, and approval-gated rejection. The Hermes lane proves the real
managed adapter and Gateway VM boundary; inventory-only skips are not live
proof.
