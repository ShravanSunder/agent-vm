# MCP Portal Native OpenClaw And External Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor MCP Portal into a shared `/core` runtime with three adapters: native OpenClaw tools for gateway agents, `/mcp-proxy` for external MCP clients, and one public `agent-vm-mcp-portal` CLI for operator/harness use, while keeping 1Password resolution on the host/controller side.

**Architecture:** `@agent-vm/mcp-portal/core` owns policy, catalog/search, approval evaluation, redaction, streaming event normalization, and upstream MCP routing. `@agent-vm/openclaw-mcp-portal-plugin` is the primary OpenClaw adapter and registers native OpenClaw tools that call core directly with trusted `ctx.agentId`; it does not spawn the portal server or use loopback HTTP. `@agent-vm/mcp-portal/mcp-proxy` and `@agent-vm/mcp-portal/cli` are separate external adapters that authenticate callers before constructing trusted agent scope; `/mcp-proxy` is started through the single public `agent-vm-mcp-portal serve` command, not a second binary.

**Tech Stack:** TypeScript, pnpm monorepo, Zod, Hono, `@modelcontextprotocol/sdk`, Vitest, OXC, OpenClaw plugin SDK, Gondolin HTTP mediation, OpenClaw smoke harness.

---

## Decisions

- OpenClaw uses native-tool mode, not MCP-registry mode.
- Managed OpenClaw mode does not run `agent-vm-mcp-portal-server` inside the gateway VM.
- Managed OpenClaw mode does not generate `mcp.servers.mcp_portal_<agentId>` entries.
- Managed OpenClaw mode does not open the portal subprocess port `18790`.
- `/mcp-proxy` still exists, but only for external MCP clients and standalone deployments.
- `agent-vm-mcp-portal` is the only public MCP Portal CLI binary.
- `agent-vm-mcp-portal serve` starts `/mcp-proxy`; there is no public `agent-vm-mcp-portal-server` binary.
- `/cli` calls `/core` directly for local operator commands; it does not call a local HTTP server by default.
- Codex/Claude Code/harness clients outside OpenClaw use `/mcp-proxy`; managed OpenClaw does not preserve legacy portal entries in `cfg.mcp.servers`.
- Secret resolution is not a Gondolin responsibility. 1Password/env/composite resolver helpers live in a shared `@agent-vm/secrets` package so controller, gateway packages, MCP Portal, and tests do not depend on `@agent-vm/gondolin-adapter` just to resolve secrets.
- `/core` does not authenticate requests. Adapters authenticate and pass trusted `PortalAgentScope`.
- All adapter-visible portal tool descriptors are config-derived after trusted agent scope is established.
- Portal tool execution is event-first. `/core` exposes streaming execution for upstream MCP notifications/progress/partial output and a collection helper for callers that only need the final response.
- Adapters decide how to present the same `/core` event stream: OpenClaw native tools forward updates through OpenClaw `onUpdate` and return one final tool result; `/mcp-proxy` forwards MCP notifications/progress to MCP clients; `/cli` writes progress to stderr and final output to stdout.
- The host/controller materializes config and secrets before gateway boot. At runtime, OpenClaw calls `/core` directly in the gateway VM.
- Credential export is an explicit secret-extraction operation. It must require a master-key fingerprint check before writing any per-agent bearer.
- Per-agent bearers must never be printed to stdout, stderr, diagnostics, debug logs, smoke logs, or doctor output. Commands may print only metadata: agent id, output path, key fingerprint, and rotation timestamp.
- Effective MCP Portal configs are rebuildable and live under `cacheDir`, not `stateDir`.
- The gateway VM and portal adapters never receive `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_TOKEN`, `OP_SESSION`, or other 1Password process credentials.
- Authored `source: "1password"` in MCP Portal configs is a host/controller instruction. The controller materializes it before gateway boot.

## Evidence Anchors

- OpenClaw native tools exist: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/types.ts:2541`
- OpenClaw native tool context includes `agentId`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/tool-types.ts:13`
- OpenClaw native tool execution accepts `onUpdate`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/tools/common.ts:21`
- OpenClaw preserves `onUpdate` through the tool adapter: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/pi-tool-definition-adapter.ts:236`
- OpenClaw requires registered tools in manifest `contracts.tools`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/registry.ts:540`
- OpenClaw `before_tool_call` can block or require approval: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/pi-tools.before-tool-call.ts:505`
- Current MCP Portal plugin is subprocess-based: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts:254`
- Current controller generates per-agent portal MCP servers: `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts:27`
- OpenClaw Codex app-server projection only projects user-configured `cfg.mcp.servers`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/cli-runner/bundle-mcp-codex.ts:69`
- Current 1Password resolver lives in the Gondolin package: `packages/gondolin-adapter/src/secret-resolver.ts`.
- Current composite resolver lives in controller code: `packages/agent-vm/src/controller/composite-secret-resolver.ts`.
- `gateway-interface` currently imports secret types from Gondolin: `packages/gateway-interface/src/gateway-lifecycle.ts:1`.
- Current validate only checks authored config/profile coherence: `packages/agent-vm/src/operations/config-validation.ts:434`
- Current doctor checks old portal endpoint topology: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts:347`
- Existing HMAC approval primitives are under `packages/mcp-portal/src/auth/hmac-token.ts`.
- Existing per-agent HMAC env parsing is under `packages/mcp-portal/src/auth/hmac-env.ts`.
- Current portal runtime is Promise-only at the upstream call boundary: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts:439`.
- MCP Portal already uses Streamable HTTP and SSE client transports: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts:1`.
- MCP Portal already serves Streamable HTTP for the proxy path: `packages/mcp-portal/src/mcp-server/portal-http-server.ts:3`.
- Rebuildable cache belongs under `cacheDir`: `docs/architecture/storage-model.md:125`.

## Target Runtime Shape

```text
OpenClaw agent tool call
  -> native mcp_portal_* plugin tool
  -> OpenClaw trusted ctx.agentId/sessionId
  -> core.describeTools(scope) derives descriptors from config
  -> @agent-vm/mcp-portal/core callStream(scope, input)
  -> upstream MCP runtime
  -> stdio / streamable-http / sse upstream provider
  -> progress events forwarded to OpenClaw onUpdate
  -> final event collected into one OpenClaw AgentToolResult

External MCP client
  -> @agent-vm/mcp-portal/mcp-proxy
  -> HMAC bearer proves agent scope
  -> core.describeTools(scope) derives MCP tool descriptors from config
  -> @agent-vm/mcp-portal/core callStream(scope, input)
  -> upstream MCP runtime
  -> events mapped to MCP notifications/progress
  -> final event mapped to tools/call response

Operator CLI / harness
  -> @agent-vm/mcp-portal/cli
  -> credential file or explicit local operator trust proves agent scope
  -> core.describeTools(scope) derives help/catalog text from config
  -> @agent-vm/mcp-portal/core callStream(scope, input)
  -> upstream MCP runtime
  -> progress/events to stderr
  -> final result to stdout
```

## File Ownership

### `packages/mcp-portal`

- `/core`
	- Owns trusted agent scope, provider runtime creation, policy maps, session/cache, approval evaluation, portal tool handlers, and upstream MCP calls.
	- Owns scoped tool descriptors: names, descriptions, schemas, and catalog hints are computed from `mcp.config.jsonc`, `mcp-portal.config.jsonc`, and `PortalAgentScope`.
	- Owns the canonical `PortalCoreEvent` stream and `collectPortalCoreResult(...)` helper.
	- Must not import Hono, OpenClaw plugin APIs, process supervisor code, or CLI argument parsing.
- `/mcp-proxy`
  - Owns Hono/Streamable HTTP MCP server, external request authentication, MCP protocol translation, and adapter-specific agent scope creation.
  - Asks `/core` for MCP tool descriptors only after request auth proves the requested agent scope.
  - Calls `/core` streaming execution and maps progress/events onto MCP notifications before returning the final MCP tool result.
- `/cli`
  - Owns CLI parsing, credential-file loading/writing, operator/harness auth, command rendering, and `serve` command wiring for `/mcp-proxy`.
  - Asks `/core` for command help/catalog text only after credential or operator trust establishes agent scope.
  - Never prints or logs per-agent bearer values.
  - Calls `/core` streaming execution; interactive commands print progress to stderr and final output to stdout.
- `/auth`
  - Keeps existing approval-token helpers.
  - Adds external agent-scope bearer helpers for `/mcp-proxy` and `/cli`.
  - Adds master-key fingerprint helpers for credential-file generation and rotation checks.

### `packages/secrets`

- Owns `SecretRef`, `SecretResolver`, `MediatedSecretSpec`, token-source helpers, environment resolver, composite resolver, and 1Password SDK/op CLI resolver.
- Does not import Gondolin, gateway lifecycle packages, MCP Portal, OpenClaw, controller runtime, or CLI packages.
- May depend on `@1password/sdk`, `zod`, and Node built-ins only.
- Provides subpath exports for contracts and test helpers so packages can import narrow surfaces without reaching through Gondolin.

### `packages/openclaw-mcp-portal-plugin`

- Owns only the OpenClaw adapter.
- Registers native tools via `api.registerTool(...)`.
- Registers prompt and tool hooks via `api.on(...)`.
- Loads effective configs from the controller-supplied config dir.
- Constructs trusted OpenClaw agent scope from `ctx.agentId`, `ctx.sessionId`, and `ctx.sessionKey`.
- Asks `/core` for descriptors for the current `ctx.agentId`; it does not hard-code per-agent catalog text in the plugin.
- For tool calls, consumes `/core` streaming events, forwards safe progress through OpenClaw `onUpdate`, and collects the final event into one `AgentToolResult`.
- Does not spawn `agent-vm-mcp-portal-server`.
- Does not forward `OP_*`.

### `packages/agent-vm`

- Owns system config field `zones[].mcpPortal`.
- Owns host-side materialization from authored config to effective config.
- Writes effective config under `<cacheDir>/gateways/<zoneId>/mcp-portal-effective`.
- Passes the VM path `/home/openclaw/.openclaw/cache/mcp-portal-effective` to the OpenClaw plugin.
- Injects generated runtime env secrets and generated runtime mediated secrets into the gateway VM spec.

---

## Task 0: Inventory And Clean Up Prior Attempts

**Files:**
- Modify: `docs/superpowers/plans/2026-05-18-mcp-proxy-portal-core.md`
- Delete or modify stale attempt files discovered by the inventory

- [ ] **Step 1: Inventory every prior MCP Portal attempt**

Run:

```bash
rg -n "mcp-portal|mcp_portal|MCP_PORTAL|agent-vm-mcp-portal-server|portal-server|portal subprocess|18790|source: \"1password\"|OP_SERVICE_ACCOUNT_TOKEN|runtimeMcpServers|mcp\\.servers\\.mcp_portal|mcpProxy|externalAuth" packages docs config
```

Classify each hit into one of these buckets:

- `keep`: part of the new design
- `move`: useful code that must move into `/core`, `/mcp-proxy`, `/cli`, or the materializer
- `delete`: old subprocess/MCP-registry implementation
- `rewrite`: same responsibility, wrong boundary
- `unknown`: needs local code review before implementation continues

- [ ] **Step 2: Inscribe the inventory into this plan**

Add a `Prior Attempt Inventory` section below this task with one row per stale/active implementation area.

Required rows:

- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
- `packages/mcp-portal/src/bin/portal-server.ts`
- `packages/mcp-portal/src/mcp-server`
- `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`
- generated config/manual references to `agent-vm-mcp-portal-server`, `18790`, or `mcp.servers.mcp_portal_*`

For each row, record:

- current purpose
- new destination or deletion decision
- tests that prove cleanup happened

Do not begin Task 1 until there are no `unknown` rows.

- [ ] **Step 3: Add cleanup tests before deleting old paths**

Add or update tests that fail while stale paths remain:

- plugin registration does not call `registerService`
- plugin registration does not import or create `createPortalSubprocessSupervisor`
- package bin map has only `agent-vm-mcp-portal`
- OpenClaw effective config contains no generated `mcp.servers.mcp_portal_*`
- docs/manual generated output contains no `agent-vm-mcp-portal-server`
- managed OpenClaw smoke does not open guest port `18790`

- [ ] **Step 4: Remove stale artifacts deliberately**

Delete old artifacts only after Step 3 tests exist:

- `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts`
- `packages/mcp-portal/src/bin/portal-server.ts`
- `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`

Move reusable code instead of duplicating it:

- portal MCP protocol code -> `packages/mcp-portal/src/mcp-proxy`
- provider/policy/session code -> `packages/mcp-portal/src/core`
- server startup code -> `packages/mcp-portal/src/cli/serve-command.ts`
- materialization helpers -> `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts`

- [ ] **Step 5: Verify cleanup baseline**

Run:

```bash
rg -n "agent-vm-mcp-portal-server|portal subprocess|createPortalSubprocessSupervisor|mcp_portal_.*__|runtimeMcpServers|mcp\\.servers\\.mcp_portal|OP_SERVICE_ACCOUNT_TOKEN|OP_CONNECT_TOKEN|spawn op|source: \"1password\"" packages docs config
```

Expected:

- only intentional test fixtures or historical evidence comments remain
- no managed OpenClaw runtime path depends on the subprocess server
- no managed OpenClaw config generation creates `mcp.servers.mcp_portal_*`
- no OP credential forwarding remains
- no effective config fixture contains `source: "1password"`

## Prior Attempt Inventory

Task 0 must refresh this section from the current checkout before implementation begins. The rows below are the known stale/new boundaries from the plan-writing pass.

| Area | Current Purpose | Decision | Proof |
| --- | --- | --- | --- |
| `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts` | Starts subprocess/service and wires hooks | Rewrite as native OpenClaw tool registration | plugin registration tests assert `registerTool` is used and `registerService` is not |
| `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts` | Supervises in-VM portal server process | Delete | `rg createPortalSubprocessSupervisor` has no managed runtime hits |
| `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts` | Tracks subprocess availability/state | Delete or replace only if native tool diagnostics need a smaller state object | hook/tool tests do not depend on subprocess availability |
| `packages/mcp-portal/src/bin/portal-server.ts` | Public standalone server binary | Delete; server startup moves to `agent-vm-mcp-portal serve` | package bin map exposes only `agent-vm-mcp-portal` |
| `packages/mcp-portal/src/mcp-server` | MCP protocol server implementation | Move to `packages/mcp-portal/src/mcp-proxy` | imports use `mcp-proxy`; proxy integration test passes |
| `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts` | Generates OpenClaw `mcp.servers.mcp_portal_*` entries | Delete; reusable config checks move to effective materializer | orchestrator tests assert no `runtimeMcpServers` portal entries |
| `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` | Wires zone MCP portal into OpenClaw gateway | Rewrite to call effective config materializer and pass plugin config only | gateway-zone-orchestrator tests assert cache-backed effective config and no portal MCP registry |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | Writes OpenClaw effective config and VM spec | Keep unrelated MCP merging; remove portal default config and merge runtime env/mediated secrets | lifecycle tests assert no default portal server config and runtime secret collision handling |
| `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts` | Current direct-ingress portal smoke | Rewrite to invoke native tools through OpenClaw `/tools/invoke` or `tools.effective` | smoke has no port `18790` ingress and no `spawn op` logs |
| generated config/manual references | Currently may mention server binary, port, or MCP registry entries | Rewrite docs/manuals to native-tool plus `agent-vm-mcp-portal serve` external mode | manual tests and `rg agent-vm-mcp-portal-server docs packages` are clean |

---

## Task 1: Extract Shared Secrets Package

**Files:**
- Create: `packages/secrets/package.json`
- Create: `packages/secrets/tsconfig.json`
- Create: `packages/secrets/tsconfig.build.json`
- Create: `packages/secrets/tsdown.config.ts`
- Create: `packages/secrets/src/contracts.ts`
- Create: `packages/secrets/src/environment-secret-resolver.ts`
- Create: `packages/secrets/src/composite-secret-resolver.ts`
- Create: `packages/secrets/src/onepassword-secret-resolver.ts`
- Create: `packages/secrets/src/service-account-token.ts`
- Create: `packages/secrets/src/testing.ts`
- Create: `packages/secrets/src/index.ts`
- Move tests from `packages/gondolin-adapter/src/secret-resolver.test.ts`
- Move smoke from `packages/gondolin-adapter/src/secret-resolver.smoke.test.ts`
- Move tests from `packages/agent-vm/src/controller/composite-secret-resolver.test.ts`
- Modify: `packages/gondolin-adapter/src/index.ts`
- Modify: `packages/gondolin-adapter/package.json`
- Modify: `packages/gateway-interface/package.json`
- Modify: `packages/agent-vm/package.json`
- Modify package imports that currently use `SecretRef`, `SecretResolver`, or `SecretSpec` from `@agent-vm/gondolin-adapter`

- [ ] **Step 1: Add package shell**

Create `@agent-vm/secrets`.

Package requirements:

- package name is `@agent-vm/secrets`
- exports only ESM
- build script uses `tsdown`
- no dependency on `@agent-vm/gondolin-adapter`
- no dependency on `@agent-vm/agent-vm`
- no dependency on gateway packages
- dependencies may include `@1password/sdk` and `zod`

Export map:

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./contracts": {
    "types": "./dist/contracts.d.ts",
    "import": "./dist/contracts.js"
  },
  "./testing": {
    "types": "./dist/testing.d.ts",
    "import": "./dist/testing.js"
  }
}
```

- [ ] **Step 2: Move contracts**

Move these contracts out of `packages/gondolin-adapter/src/types.ts`:

```ts
export interface MediatedSecretSpec {
	readonly hosts: readonly string[];
	readonly value: string;
}

export type SecretRef =
	| { readonly source: '1password'; readonly ref: string }
	| { readonly source: 'environment'; readonly ref: string };

export interface SecretResolver {
	resolve(ref: SecretRef): Promise<string>;
	resolveAll(refs: Readonly<Record<string, SecretRef>>): Promise<Record<string, string>>;
}
```

Keep a temporary export alias only if needed inside the same PR:

```ts
export type SecretSpec = MediatedSecretSpec;
```

Do not leave downstream packages importing `SecretRef`, `SecretResolver`, or `SecretSpec` from `@agent-vm/gondolin-adapter`.

- [ ] **Step 3: Move environment and composite resolver**

Move `packages/agent-vm/src/controller/composite-secret-resolver.ts` into:

```text
packages/secrets/src/composite-secret-resolver.ts
```

The exported function remains:

```ts
export function createCompositeSecretResolver(
	onePasswordResolver: SecretResolver | null,
	env?: NodeJS.ProcessEnv,
): SecretResolver;
```

It must preserve the batching behavior:

- environment refs are resolved locally
- all 1Password refs are forwarded once to `onePasswordResolver.resolveAll(...)`
- `resolveAll(...)` never loops over 1Password refs by calling `resolve(...)`

- [ ] **Step 4: Move 1Password implementation**

Move `packages/gondolin-adapter/src/secret-resolver.ts` into:

```text
packages/secrets/src/onepassword-secret-resolver.ts
packages/secrets/src/service-account-token.ts
```

Keep the current behavior:

- SDK `client.secrets.resolveAll(...)` first
- fallback to one `op inject` batch over stdin/stdout
- final fallback to serial `op read`
- no temp files for secret values
- allowlisted subprocess env only
- no ambient `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN`, `OP_SESSION`, `OP_SERVICE_ACCOUNT_TOKEN`, `GITHUB_TOKEN`, or cloud tokens forwarded
- failing subprocess stderr is redacted
- secret whitespace bytes are preserved except the final CLI stdout terminator from `op read`

- [ ] **Step 5: Update package dependencies and imports**

Update imports:

- packages that need secret contracts import from `@agent-vm/secrets`
- controller startup imports `createCompositeSecretResolver`, `createSecretResolver`, and `resolveServiceAccountToken` from `@agent-vm/secrets`
- MCP Portal CLI uses `@agent-vm/secrets` to resolve `externalAuth.masterKey`
- `@agent-vm/gondolin-adapter` no longer exports `secret-resolver.js`
- `@agent-vm/gondolin-adapter` no longer depends on `@1password/sdk`

Do not make `@agent-vm/secrets` depend on:

- `@agent-vm/gondolin-adapter`
- `@agent-vm/gateway-interface`
- `@agent-vm/agent-vm`
- `@agent-vm/mcp-portal`

- [ ] **Step 6: Move tests and smoke**

Move tests to:

```text
packages/secrets/src/onepassword-secret-resolver.test.ts
packages/secrets/src/composite-secret-resolver.test.ts
packages/secrets/src/onepassword-secret-resolver.smoke.test.ts
```

The live smoke still uses:

- `TEST_OP_SERVICE_ACCOUNT_TOKEN`
- `AGENT_VM_1PASSWORD_SMOKE=1`
- optional `AGENT_VM_1PASSWORD_SMOKE_REFS`

Default refs stay:

```text
op://agent-vm-testing/smoke-test-item1/ref1
op://agent-vm-testing/smoke-test-item1/ref2
op://agent-vm-testing/smoke-test-item1/password
op://agent-vm-testing/smoke-test-item2/password
```

- [ ] **Step 7: Verify extraction**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/secrets/src
AGENT_VM_1PASSWORD_SMOKE=1 pnpm vitest run --root . --config vitest.smoke.config.ts packages/secrets/src/onepassword-secret-resolver.smoke.test.ts
pnpm --filter @agent-vm/secrets build
pnpm --filter @agent-vm/gondolin-adapter build
pnpm --filter @agent-vm/gateway-interface build
pnpm --filter @agent-vm/agent-vm build
```

Expected: exit 0.

- [ ] **Step 8: Dependency guard**

Run:

```bash
rg -n "SecretRef|SecretResolver|SecretSpec|createSecretResolver|resolveServiceAccountToken" packages --glob '*.ts'
rg -n "@1password/sdk|secret-resolver" packages/gondolin-adapter package.json packages/*/package.json
```

Expected:

- secret contracts come from `@agent-vm/secrets`
- `@1password/sdk` appears only in `packages/secrets/package.json` and `packages/secrets/src`
- `@agent-vm/gondolin-adapter` has no 1Password resolver exports
- no package imports secrets through Gondolin

---

## Task 2: Split MCP Portal Core From Protocol Adapters

**Files:**
- Create: `packages/mcp-portal/src/core/agent-scope.ts`
- Create: `packages/mcp-portal/src/core/provider-runtime.ts`
- Create: `packages/mcp-portal/src/core/portal-core.ts`
- Create: `packages/mcp-portal/src/core/index.ts`
- Modify: `packages/mcp-portal/src/portal-access-policy.ts`
- Modify: `packages/mcp-portal/src/portal-session.ts`
- Modify: `packages/mcp-portal/src/mcp-server/portal-tools.ts`
- Delete: `packages/mcp-portal/src/bin/portal-server.ts`
- Modify: `packages/mcp-portal/src/index.ts`
- Modify: `packages/mcp-portal/package.json`
- Modify: `packages/mcp-portal/tsdown.config.ts`
- Test: `packages/mcp-portal/src/core/*.test.ts`

- [ ] **Step 1: Add failing core boundary tests**

Create tests that prove:

- `createPortalAgentScope(...)` rejects empty/control-character identity fields.
- `createPortalCore(...)` accepts loaded `McpConfig`, loaded `McpPortalConfig`, and a caller-provided secret resolver.
- `createPortalCore(...)` returns the four portal tool handlers without requiring HTTP, Hono, CLI args, or OpenClaw APIs.
- `createPortalCore(...).createAgentScope({ agentId, source, sessionId })` returns `null` for unknown agents.
- `createPortalCore(...).describeTools(scope)` returns the four portal tool descriptors with descriptions derived from the agent's configured profile, allowed namespaces, and provider metadata.
- descriptor text is helpful for the model, but execution authorization still happens inside `/core` on every call.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/mcp-portal/src/core
```

Expected: FAIL before `/core` exists.

- [ ] **Step 2: Promote trusted agent identity into `/core`**

Create `packages/mcp-portal/src/core/agent-scope.ts` with:

- `PortalAgentScopeSource = 'openclaw' | 'mcp-proxy' | 'cli'`
- `PortalAgentScope`
  - `agentId`
  - `agentScopeId`
  - `source`
  - optional `sessionId`
  - optional `sessionKey`
  - optional `authSubject`
- `createPortalAgentScope(...)`
- `portalAgentScopeKey(...)`

Move or re-export the existing branded identity helpers from `portal-access-policy.ts` so there is one trusted identity model, not two competing types.

- [ ] **Step 3: Move provider resolution into `/core`**

Move these responsibilities out of the current standalone server bin:

- `resolveProviderSecretRecord`
- `resolveUpstreamServer`
- `resolveUpstreamServers`

New file:

```text
packages/mcp-portal/src/core/provider-runtime.ts
```

The exported function must accept:

```ts
{
  config: McpConfig;
  resolveSecret: (secret: SecretValue) => Promise<string>;
}
```

and return `readonly NormalizedUpstreamMcpServer[]`.

- [ ] **Step 4: Build `createPortalCore(...)`**

Create `packages/mcp-portal/src/core/portal-core.ts` with a factory that returns:

- `createAgentScope(...)`
- `handlers.list/search/describe/call`
- `callStream(...)`
- `collectPortalCoreResult(...)`
- `approval.evaluateCalls(...)`
- `close()`
- `invalidateAgentScope(...)`
- `upstreamNamespaces`

The core execution contract must support both streaming and collection. Do not make upstream execution Promise-only. Promise-only handlers silently discard upstream MCP progress notifications and streaming output.

Add adapter-neutral result and event types:

```ts
export interface PortalCoreResult {
	readonly content: readonly PortalCoreContentBlock[];
	readonly structuredContent?: unknown;
	readonly auditEvents?: readonly PortalAuditEvent[];
}

export type PortalCoreContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'json'; readonly value: unknown };

export type PortalCoreEvent =
	| {
			readonly kind: 'started';
			readonly toolName: 'mcp_portal_list' | 'mcp_portal_search' | 'mcp_portal_describe' | 'mcp_portal_call';
	  }
	| {
			readonly kind: 'item_started';
			readonly requestId: string;
			readonly namespace?: string;
			readonly toolName?: string;
	  }
	| {
			readonly kind: 'progress';
			readonly message?: string;
			readonly progress?: number;
			readonly requestId?: string;
			readonly total?: number;
	  }
	| {
			readonly kind: 'upstream_notification';
			readonly method: string;
			readonly params: unknown;
			readonly requestId?: string;
	  }
	| {
			readonly kind: 'partial_content';
			readonly content: PortalCoreContentBlock;
			readonly requestId?: string;
	  }
	| {
			readonly kind: 'item_completed';
			readonly requestId: string;
	  }
	| {
			readonly kind: 'completed';
			readonly result: PortalCoreResult;
	  }
	| {
			readonly error: unknown;
			readonly kind: 'failed';
	  };

export interface PortalCoreStreamCall {
	readonly input: unknown;
	readonly scope: PortalAgentScope;
	readonly signal?: AbortSignal;
}

export interface PortalCoreCollectedCall extends PortalCoreStreamCall {
	readonly collectEvents?: boolean;
}
```

`callStream(...)` returns `AsyncIterable<PortalCoreEvent>`.
`collectPortalCoreResult(...)` consumes that event stream and returns the final `PortalCoreResult`.

Adapters translate the same stream differently:

- native OpenClaw adapter forwards safe progress events through `onUpdate` and converts the final result to OpenClaw `AgentToolResult`.
- `/mcp-proxy` maps progress/upstream notification events to MCP notifications and converts the final result to MCP server result content.
- `/cli` prints progress/upstream notification summaries to stderr and converts the final result to terminal stdout.

Use existing code from:

- `packages/mcp-portal/src/portal-session.ts`
- `packages/mcp-portal/src/mcp-server/portal-tools.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`

The core handler signatures must use `PortalAgentScope`, not HTTP request state or OpenClaw context.

`handlers.list/search/describe/call` may remain as collection helpers for adapters that do not need streaming, but the implementation must route through `callStream(...)` and `collectPortalCoreResult(...)` so the streaming and collected paths cannot diverge.

- [ ] **Step 5: Add package path exports**

Update `packages/mcp-portal/package.json`:

```json
"./core": {
  "types": "./dist/core/index.d.ts",
  "import": "./dist/core/index.js"
},
"./mcp-proxy": {
  "types": "./dist/mcp-proxy/index.d.ts",
  "import": "./dist/mcp-proxy/index.js"
},
"./cli": {
  "types": "./dist/cli/index.d.ts",
  "import": "./dist/cli/index.js"
}
```

Update `packages/mcp-portal/tsdown.config.ts` entries for:

- `src/core/index.ts`
- `src/mcp-proxy/index.ts`
- `src/cli/index.ts`

- Update the package `"bin"` map so the only public binary is:

```json
{
  "agent-vm-mcp-portal": "./dist/bin/agent-vm-mcp-portal.js"
}
```

- [ ] **Step 6: Remove the public server bin**

Delete `packages/mcp-portal/src/bin/portal-server.ts`.

Move server startup into `packages/mcp-portal/src/cli/serve-command.ts`, invoked by:

```bash
agent-vm-mcp-portal serve
```

The serve command must:

- load configs
- create core
- create MCP proxy HTTP app
- start Hono server
- close core on shutdown

It must not own policy-map construction or upstream provider resolution after this task. It must not create a second public CLI binary.

- [ ] **Step 7: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/mcp-portal/src/core packages/mcp-portal/src/cli packages/mcp-portal/src/mcp-proxy
pnpm --filter @agent-vm/mcp-portal test
```

Expected: exit 0.

---

## Task 3: Make OpenClaw Plugin Native-Tool Primary

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/openclaw.plugin.json`
- Modify: `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/before-tool-call-handler.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/before-prompt-build-handler.ts`
- Modify or delete: `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts`
- Modify or delete: `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
- Modify tests under `packages/openclaw-mcp-portal-plugin/src`

- [ ] **Step 1: Add failing native tool registration tests**

In `plugin-registration.test.ts`, assert:

- `registerMcpPortalPlugin(api)` requires `api.registerTool`.
- It registers exactly:
  - `mcp_portal_list`
  - `mcp_portal_search`
  - `mcp_portal_describe`
  - `mcp_portal_call`
- It does not call `api.registerService`.
- It does not create or start `createPortalSubprocessSupervisor`.
- It still registers `before_prompt_build`.
- It still registers `before_tool_call`.
- Each registered tool factory gets `ctx.agentId` from OpenClaw and passes a trusted scope to core.
- The native tool descriptions come from `/core.describeTools(scope)` for the current agent scope, not from plugin-level constants.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/openclaw-mcp-portal-plugin/src/plugin-registration.test.ts
```

Expected: FAIL against current subprocess implementation.

- [ ] **Step 2: Update plugin API shim**

Add native tool registration types to `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`:

- `OpenClawToolRegistration`
- `OpenClawToolRegistrationResult`
- `OpenClawPluginToolContext`
- `registerTool(...)`

The context must include at least:

- `agentId?: string`
- `sessionId?: string`
- `sessionKey?: string`

Keep the shim narrow and aligned with OpenClaw evidence:

- `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/types.ts`
- `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/tool-types.ts`

- [ ] **Step 3: Add manifest tool contracts**

Modify `packages/openclaw-mcp-portal-plugin/openclaw.plugin.json`:

```json
{
  "contracts": {
    "tools": [
      "mcp_portal_list",
      "mcp_portal_search",
      "mcp_portal_describe",
      "mcp_portal_call"
    ]
  },
  "toolMetadata": {
    "mcp_portal_list": { "optional": true },
    "mcp_portal_search": { "optional": true },
    "mcp_portal_describe": { "optional": true },
    "mcp_portal_call": { "optional": true }
  }
}
```

Keep existing activation and config schema, but replace the description so it says native OpenClaw tool adapter, not subprocess supervisor.

- [ ] **Step 4: Register native tools**

Refactor `registerMcpPortalPlugin(...)`:

- load effective MCP Portal configs from `api.pluginConfig.configDir`
- create one `PortalCore` instance for the plugin runtime
- register the four native tools from core descriptors
- use OpenClaw's tool factory form so descriptor generation can see `ctx.agentId`
- in each tool factory, require `ctx.agentId`
- construct `PortalAgentScope` from `ctx.agentId`, `ctx.sessionId`, and `ctx.sessionKey`
- call the matching core streaming execution path
- forward safe `progress`, `partial_content`, and `upstream_notification` summaries through the OpenClaw `onUpdate` callback when it is provided
- collect the `completed` event into the final OpenClaw tool result `{ content: JSON.stringify(result), details: result }`

Tool input schemas must come from the existing portal schemas in `portal-tools.ts` or the moved `/core` equivalent.

OpenClaw evidence: the upstream plugin descriptor cache key includes `ctx.agentId`, so per-agent descriptors are supported. Do not rely on descriptor text as the security boundary; cached descriptors improve tool UX, while `/core` policy enforces every list/search/describe/call.

OpenClaw native tool execution receives `onUpdate` as the fourth argument. Use that callback for progress only; do not invent a loopback HTTP stream to carry progress.

- [ ] **Step 5: Replace subprocess availability checks**

Remove logic that blocks because a portal subprocess is unavailable.

The native failure modes are now:

- missing `ctx.agentId`
- unknown portal agent
- core failed to load effective config
- upstream provider call failed
- policy denied the call

Tests must assert these failures are returned as blocked hook results or tool errors with clear `mcp-portal:` messages.

- [ ] **Step 6: Keep OpenClaw approval through `before_tool_call`**

Refactor `before-tool-call-handler.ts` for native names:

- match `event.toolName === 'mcp_portal_call'`
- use `context.agentId`
- parse `event.params.calls`
- check the agent profile allows each call
- return `block` for denied calls
- return `requireApproval` for calls requiring approval
- for native OpenClaw mode, do not mint or verify HMAC approval tokens; the trusted hook decision is the in-process approval boundary
- keep existing HMAC approval token helpers only for external adapter flows where the approval decision crosses a process/network boundary

Do not check old server-prefixed names like `mcp_portal_<agentId>__mcp_portal_call`.

- [ ] **Step 7: Keep prompt context**

Update `before-prompt-build-handler.ts` to load profile policy from the effective config and append context for the current `context.agentId`.

It must not depend on `PortalPluginRuntimeState` if that state only existed to track subprocess availability.

- [ ] **Step 8: Verify**

Run:

```bash
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin test
pnpm typecheck --filter @agent-vm/openclaw-mcp-portal-plugin
```

Expected: exit 0.

---

## Task 4: Rename Zone Wiring To `mcpPortal` And Remove OpenClaw MCP-Registry Materialization

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-support.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Delete: `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/migrate-commands.ts`
- Modify tests that reference `zone.mcp`
- Modify docs/manual templates that reference `zones[].mcp`

- [ ] **Step 1: Add failing config tests**

Add tests proving:

- `zones[].mcpPortal.configDir` loads.
- legacy `zones[].mcp` is rejected.
- generated init config uses `mcpPortal`.
- migrate command rewrites `mcp` to `mcpPortal`.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/config packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/migrate-commands.test.ts
```

Expected: FAIL before rename.

- [ ] **Step 2: Hard rename the field**

Rename only the zone-level managed portal field:

- `zone.mcp` -> `zone.mcpPortal`
- `zones[].mcp` -> `zones[].mcpPortal`
- `GatewayZoneConfig.mcp` -> `GatewayZoneConfig.mcpPortal`

Do not rename:

- `mcp.config.jsonc`
- OpenClaw `mcp.servers`
- provider `kind: "mcp"`
- package names
- `mcp_portal_*` native tool names

- [ ] **Step 3: Remove runtime MCP server generation for OpenClaw**

Delete `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts` and its tests. Its only job was generating OpenClaw MCP-registry portal entries, and managed OpenClaw no longer uses that path.

Move any still-useful helper logic into `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts` in Task 5.

After this task, managed OpenClaw startup must not add:

```ts
runtimeMcpServers: {
  mcp_portal_<agentId>: ...
}
```

`gateway-zone-orchestrator.ts` should only pass runtime plugin config and runtime secret bindings needed by the native OpenClaw plugin.

- [ ] **Step 4: Update OpenClaw effective config writer**

In `openclaw-lifecycle.ts`:

- stop adding default `mcp-portal` plugin config from `zone.mcpPortal`
- keep merging `zone.runtimePluginConfigs`
- keep OpenClaw `mcp.servers` merging for unrelated MCP servers
- ensure no generated portal `mcp.servers` entries are added by agent-vm

- [ ] **Step 5: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/config packages/agent-vm/src/gateway packages/openclaw-gateway/src/openclaw-lifecycle.test.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/migrate-commands.test.ts
```

Expected: exit 0.

---

## Task 5: Add Managed MCP Portal Effective Config Materialization

**Files:**
- Create: `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts`
- Create: `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts`
- Modify: `packages/config-contracts/src/mcp-config.ts`
- Modify: `packages/config-contracts/src/mcp-portal-config.ts`
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/gateway-interface/src/split-resolved-gateway-secrets.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`

- [ ] **Step 1: Add secret policy schema**

Extend `mcp.config.jsonc` provider schema with per-secret policy.

Use this shape:

```jsonc
{
  "providers": {
    "tavily": {
      "kind": "mcp",
      "namespace": "tavily",
      "transport": {
        "kind": "stdio",
        "command": "npx",
        "args": ["-y", "tavily-mcp"],
        "env": {
          "TAVILY_API_KEY": {
            "source": "1password",
            "ref": "op://agent-vm/sunfam-tavily/credential"
          }
        }
      },
      "secretPolicies": {
        "TAVILY_API_KEY": {
          "injection": "http-mediation",
          "hosts": ["api.tavily.com"]
        }
      }
    }
  }
}
```

Rules:

- every provider secret with `source: "1password"` requires explicit `secretPolicies.<secretName>`.
- do not silently infer mediation hosts from provider URLs in the first implementation.
- `injection: "env"` is allowed only when explicitly configured.
- `http-mediation` requires at least one host.
- malformed, wildcard, empty, or dynamic hosts fail validation.

- [ ] **Step 2: Make proxy auth optional and explicit**

Refactor `mcp-portal.config.jsonc` schema so OpenClaw-native mode does not require proxy server auth.

Use this target shape:

```jsonc
{
  "schemaVersion": 1,
  "externalAuth": {
    "masterKey": {
      "source": "1password",
      "ref": "op://agent-vm/sunfam-mcp-portal-external-auth/credential"
    }
  },
  "mcpProxy": {
    "server": {
      "host": "127.0.0.1",
      "port": 18790
    },
    "auth": {
      "headerName": "authorization"
    }
  },
  "agents": {
    "shravan": { "profile": "builder" }
  },
  "profiles": {
    "builder": { "enabledNamespaces": ["tavily"] }
  }
}
```

Rules:

- `/core` ignores `mcpProxy`.
- OpenClaw native adapter does not require `mcpProxy`.
- `/mcp-proxy` requires `mcpProxy` and `externalAuth.masterKey`.
- `agent-vm-mcp-portal write-credential` requires `externalAuth.masterKey`.
- `/cli` may use a credential file generated from `externalAuth.masterKey`.

- [ ] **Step 3: Add failing materializer tests**

Tests must create `authoredDir` and `effectiveDir` before writing files.

Prove:

- provider `source: "1password"` is resolved through `secretResolver.resolveAll(...)` once.
- effective `mcp.config.jsonc` contains only `source: "environment"` secret refs.
- effective `mcp-portal.config.jsonc` contains no `source: "1password"` when `externalAuth.masterKey` is present.
- materializer outputs runtime env secrets for `injection: "env"`.
- materializer outputs runtime mediated secrets for `injection: "http-mediation"`.
- effective files are written under `<cacheDir>/gateways/<zoneId>/mcp-portal-effective`.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts
```

Expected: FAIL before materializer exists.

- [ ] **Step 4: Add runtime mediated secret plumbing**

Create `RuntimeMediatedSecretBinding` in `packages/gateway-interface/src/gateway-lifecycle.ts`:

```ts
export interface RuntimeMediatedSecretBinding {
	readonly value: string;
	readonly hosts: readonly string[];
}
```

Then extend `GatewayZoneConfig` with:

```ts
readonly runtimeMediatedSecrets?: Readonly<Record<string, RuntimeMediatedSecretBinding>>;
```

Update `openclaw-lifecycle.ts` so `buildVmSpec(...)` merges:

- regular `mediatedSecrets` from `zone.secrets`
- generated `zone.runtimeMediatedSecrets`

Runtime mediated secrets must win only for generated `AGENT_VM_MCP_*` names. If a runtime secret collides with authored `zone.secrets`, throw.

- [ ] **Step 5: Implement materializer**

Create `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts`.

Inputs:

- authored config dir
- effective host config dir
- effective VM config dir
- zone id
- controller secret resolver
- MCP secret policies

Outputs:

- `pluginConfig: { configDir: effectiveVmConfigDir }`
- `runtimeEnvironment`
- `runtimeMediatedSecrets`
- `resolvedSecretNames`
- `effectiveConfigDir`

Implement two entrypoints:

```ts
export async function planMcpPortalEffectiveConfig(...): Promise<McpPortalEffectiveConfigPlan>;
export async function writeMcpPortalEffectiveConfig(...): Promise<McpPortalEffectiveConfigWriteResult>;
```

`planMcpPortalEffectiveConfig(...)` is the validate/doctor path. It computes effective config objects in memory, accepts a shape-only secret resolver, and never writes files.

`writeMcpPortalEffectiveConfig(...)` is the controller startup path. It calls the real secret resolver, writes files, and returns runtime env and mediated secret bindings.

The effective VM config must contain only environment references like:

```json
{ "source": "environment", "name": "AGENT_VM_MCP_TAVILY_API_KEY" }
```

For mediated secrets, the VM env value is the Gondolin placeholder generated by the mediation layer, not the raw token.

- [ ] **Step 6: Wire materializer into startup**

In `gateway-zone-orchestrator.ts`:

- if `zone.gateway.type === "openclaw"` and `zone.mcpPortal` exists, materialize configs before resolving the VM spec
- write effective configs under `path.join(systemConfig.cacheDir, 'gateways', zone.id, 'mcp-portal-effective')`
- use VM path `/home/openclaw/.openclaw/cache/mcp-portal-effective`
- merge runtime environment and mediated secrets into lifecycle zone
- pass `runtimePluginConfigs['mcp-portal'].configDir` to OpenClaw
- do not create `runtimeMcpServers`

- [ ] **Step 7: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/config-contracts/src/mcp-config.test.ts packages/config-contracts/src/mcp-portal-config.test.ts packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: exit 0.

---

## Task 6: Build External `/mcp-proxy` Auth Adapter

**Files:**
- Move: `packages/mcp-portal/src/mcp-server` -> `packages/mcp-portal/src/mcp-proxy`
- Create: `packages/mcp-portal/src/auth/agent-bearer-token.ts`
- Create: `packages/mcp-portal/src/mcp-proxy/agent-bearer-auth.ts`
- Modify: `packages/mcp-portal/src/mcp-proxy/resolve-agent-identity.ts`
- Modify: `packages/mcp-portal/src/mcp-proxy/portal-http-server.ts`
- Modify: `packages/mcp-portal/src/cli/serve-command.ts`
- Modify tests under `packages/mcp-portal/src/mcp-proxy`

- [ ] **Step 1: Rename adapter directory**

Run:

```bash
git mv packages/mcp-portal/src/mcp-server packages/mcp-portal/src/mcp-proxy
rg -n "mcp-server" packages/mcp-portal/src
```

Replace import paths from `mcp-server` to `mcp-proxy`.

- [ ] **Step 2: Add HMAC bearer token helpers**

Create `auth/agent-bearer-token.ts`.

Token contract:

- bearer is base64url HMAC-SHA256
- message is `mcp-proxy:agent:<agentId>`
- key is `externalAuth.masterKey`
- master-key fingerprint is `sha256:<base64url sha256(masterKey)>`
- verification uses timing-safe comparison
- invalid tokens never reveal expected token or key material

Tests:

- valid token verifies for the same agent
- token does not verify for a different agent
- malformed token fails
- empty agent id fails
- fingerprint is stable for the same master key and never includes the raw key

- [ ] **Step 3: Make `/mcp-proxy` derive agent from auth**

For HTTP path `/agents/:agentId/mcp`:

- path agent id selects the requested scope
- bearer token must verify for the same agent id
- request body cannot override agent id
- core receives `source: "mcp-proxy"`
- MCP tool descriptors are built from `core.describeTools(scope)` after bearer verification

Remove shared access-header-only authorization as the sole proof of identity.

- [ ] **Step 4: Keep MCP protocol behavior**

`/mcp-proxy` still serves:

- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`

but all tool handling delegates to `/core`.

The MCP server descriptor handshake must also delegate to `/core`; `/mcp-proxy` must not carry static descriptions for these tools except as a startup fallback that fails closed when scope is missing.

For `mcp_portal_call`, `/mcp-proxy` must use `/core` streaming execution, not the collection helper directly. Map `/core` events as follows:

- `progress` -> MCP progress notification when the inbound call has a progress token; otherwise an MCP log/message notification if supported by the SDK transport.
- `upstream_notification` -> MCP notification passthrough only for notification kinds the proxy explicitly supports; unsupported notification methods are recorded as audit events and not emitted blindly.
- `partial_content` -> MCP progress/log notification, not final result content.
- `completed` -> final MCP `tools/call` response.

Buffering is allowed only when a tool policy requires whole-result redaction, size enforcement, or schema validation. The default path is streaming passthrough plus final result collection.

- [ ] **Step 5: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/mcp-portal/src/auth packages/mcp-portal/src/mcp-proxy packages/mcp-portal/src/cli/serve-command.test.ts
```

Expected: exit 0.

---

## Task 7: Build CLI Adapter Directly On Core

**Files:**
- Create: `packages/mcp-portal/src/cli/credential-file.ts`
- Create: `packages/mcp-portal/src/cli/write-credential-command.ts`
- Create: `packages/mcp-portal/src/cli/serve-command.ts`
- Create: `packages/mcp-portal/src/cli/portal-cli.ts`
- Create: `packages/mcp-portal/src/cli/index.ts`
- Modify: `packages/mcp-portal/src/bin/agent-vm-mcp-portal.ts`
- Modify tests under `packages/mcp-portal/src/cli`

- [ ] **Step 1: Add CLI credential tests**

Credential file shape:

```json
{
  "schemaVersion": 1,
  "agentId": "shravan",
  "bearer": "<hmac bearer token>",
  "proxyUrl": "https://mcp-portal.example.com",
  "masterKeyFingerprint": "sha256:...",
  "issuedAt": "2026-05-18T12:00:00.000Z"
}
```

Tests must prove:

- CLI rejects unknown agents.
- CLI rejects credential bearer that does not verify for `agentId`.
- CLI creates `PortalAgentScope` with `source: "cli"`.
- CLI help/catalog output is derived from `core.describeTools(scope)` after credential verification.
- CLI calls `/core` directly and does not require a running HTTP server.
- `write-credential` refuses to write unless `--expected-master-key-fingerprint` exactly matches the resolved master-key fingerprint.
- `write-credential` writes the credential file atomically with mode `0600`.
- `write-credential` stdout/stderr/log output never contains the bearer value.
- `write-credential` prints only redacted metadata: agent id, output path, master-key fingerprint, and issued-at timestamp.
- `serve` starts `/mcp-proxy` through the same `agent-vm-mcp-portal` binary.

- [ ] **Step 2: Move CLI orchestration out of bin**

`packages/mcp-portal/src/bin/agent-vm-mcp-portal.ts` becomes a thin wrapper around `/cli`.

Keep operator-facing commands, but route execution through `/core`:

- load config
- verify credential or explicit local operator trust
- create core
- derive command help/catalog text from `core.describeTools(scope)`
- call requested portal operation
- print progress/upstream notification summaries to stderr for interactive mode
- print final result to stdout
- close core

CLI execution must use `/core` streaming execution by default. JSON/script mode still writes only the final result to stdout; it may suppress progress or write event JSONL to stderr behind an explicit flag, but it must never mix progress with stdout final output.

Credential-writing command shape:

```bash
agent-vm-mcp-portal write-credential \
  --agent shravan \
  --proxy-url https://mcp-portal.example.com \
  --output ~/.agent-vm/mcp-portal/shravan.json \
  --expected-master-key-fingerprint sha256:...
```

The command must not support printing the bearer to stdout. If no `--output` path is supplied, it fails before deriving or logging the bearer.

Proxy server command shape:

```bash
agent-vm-mcp-portal serve --config-dir config/gateways/sunfam
```

This is the only public command that starts `/mcp-proxy`.

- [ ] **Step 3: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/mcp-portal/src/cli packages/mcp-portal/src/bin/agent-vm-mcp-portal.test.ts
```

Expected: exit 0.

---

## Task 8: Add Validate And Doctor Enforcement

**Files:**
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.test.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `docs/reference/validate-and-doctor.md`

- [ ] **Step 1: Extend validate tests**

Add tests proving validate fails for:

- legacy `zones[].mcp`
- missing `mcp.config.jsonc`
- missing `mcp-portal.config.jsonc`
- missing portal profile binding for a configured zone agent
- stdio provider `1password` env secret without explicit `secretPolicies`
- `http-mediation` secret policy without hosts when host cannot be inferred
- effective materialization that would leave `source: "1password"` in either effective config

Validate must not require live 1Password access.

- [ ] **Step 2: Implement static validation**

Validation should:

- load authored configs
- validate agent/profile consistency
- call `planMcpPortalEffectiveConfig(...)`
- use a shape-only secret resolver that returns deterministic placeholders and never calls live 1Password
- avoid writing effective config files
- verify all effective secret refs become environment refs
- verify no OpenClaw portal MCP-registry entries are authored or required for managed native mode

Add named checks:

- `mcp-portal-config-dir-<zoneId>`
- `mcp-portal-authored-mcp-config-<zoneId>`
- `mcp-portal-authored-portal-config-<zoneId>`
- `mcp-portal-agent-bindings-<zoneId>`
- `mcp-portal-secret-policy-<zoneId>`
- `mcp-portal-effective-config-safe-<zoneId>`

- [ ] **Step 3: Extend doctor tests**

Add tests proving doctor reports:

- plugin missing from load paths
- plugin not allowed/enabled
- plugin manifest missing `contracts.tools` for the four portal tools
- runtime plugin config missing effective `configDir`
- effective config dir missing
- effective config contains `source: "1password"`
- generated OpenClaw config still contains `mcp.servers.mcp_portal_*`
- gateway path does not require `op`

- [ ] **Step 4: Implement doctor checks**

Doctor must:

- check native plugin tool contract, not old per-agent endpoint topology
- check effective config safety
- check host-side secret resolver availability for authored 1Password refs when doctor is allowed to resolve live refs
- print operator guidance that the fix is controller materialization, not installing `op` inside the VM

- [ ] **Step 5: Verify**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/operations/config-validation.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts
```

Expected: exit 0.

---

## Task 9: Add Integration And OpenClaw Smoke Coverage

**Files:**
- Modify: `packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts`
- Modify: `packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts`
- Modify: `packages/agent-vm/src/integration-tests/smoke-harness.ts`
- Modify: `packages/mcp-portal/src/testing/fake-upstream-mcp-server.ts`

- [ ] **Step 1: Prove host-side secret batching**

Extend `gateway-secret-resolution.smoke.test.ts`:

- authored `mcp.config.jsonc` contains multiple `source: "1password"` provider secrets
- fake resolver expects one `resolveAll(...)` batch
- fake resolver `resolve(...)` must not be called for those provider refs
- materializer outputs effective env refs

Run:

```bash
pnpm vitest run --root . --config vitest.integration.config.ts packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
```

Expected: exit 0.

- [ ] **Step 2: Refactor OpenClaw smoke to native tool path**

The smoke must prove:

- gateway boots
- `mcp-portal` plugin loads
- no portal ingress route is opened
- no guest port `18790` is required
- generated effective OpenClaw config does not contain `mcp.servers.mcp_portal_`
- `tools.effective` or `/tools/invoke` can see the four native portal tools for the smoke session
- Codex app-server projection does not receive deleted `mcp.servers.mcp_portal_*` entries
- external Codex/Claude Code/harness access is covered by the `/mcp-proxy` integration test with HMAC bearer auth
- invoking `mcp_portal_list` returns the fake upstream namespace
- invoking a read upstream call reaches fake upstream
- invoking a streaming fake upstream call produces at least one OpenClaw native tool update before the final result when the gateway tool invocation surface exposes updates
- invoking a write upstream call requires or fails approval before upstream contact
- gateway logs do not contain `spawn op ENOENT` or `op read`

Use `GatewayApiClient.invokeTool(...)` against `/tools/invoke` where possible. If `tools.invoke` policy requires allowlisting, update the smoke OpenClaw config to allow the four native portal tools.

If the current OpenClaw gateway invocation helper returns only the final tool result and does not expose native `onUpdate` events, add a focused plugin-level integration test for the OpenClaw adapter that calls the registered tool directly with an `onUpdate` spy. The smoke must still prove the final gateway path; the adapter test proves the streaming bridge.

- [ ] **Step 3: Add proxy integration test**

Add a separate `/mcp-proxy` integration test that does not boot OpenClaw:

- starts fake upstream
- starts `/mcp-proxy` via `agent-vm-mcp-portal serve` or the imported `createMcpProxyHttpServer(...)` test helper
- authenticates with valid agent bearer
- rejects invalid bearer
- lists tools
- calls upstream through `/core`
- observes a fake upstream progress notification through the MCP client before the final `tools/call` response

This test proves external MCP clients without mixing it into OpenClaw gateway smoke.

- [ ] **Step 4: Add CLI streaming integration coverage**

Add a CLI-level integration test that:

- starts fake upstream
- invokes `agent-vm-mcp-portal call ...` through `/core`
- makes the fake upstream emit at least one progress notification before its final result
- asserts progress appears on stderr
- asserts stdout contains only the final result payload
- asserts no bearer or raw secret value appears in stdout, stderr, or captured logs

- [ ] **Step 5: Verify smoke**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected: exit 0.

---

## Task 10: Update Docs, Manuals, And Generated Config

**Files:**
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/reference/validate-and-doctor.md`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Document the three adapters**

Docs must say:

- OpenClaw uses native tools and calls `/core` directly.
- `/mcp-proxy` is for external MCP clients and standalone deployments.
- `agent-vm-mcp-portal` is the only public MCP Portal CLI; `agent-vm-mcp-portal serve` starts `/mcp-proxy`.
- `/cli` is operator/harness direct-to-core for local portal operations.
- `mcp.config.jsonc` owns upstream providers.
- `mcp-portal.config.jsonc` owns agents/profiles and optional proxy auth.
- `system.jsonc zones[].mcpPortal.configDir` points to the authored config folder.
- credential files are secret material; credential-writing requires an expected master-key fingerprint and never prints bearer values.
- `@agent-vm/secrets` owns 1Password/env/composite secret resolution; Gondolin remains a VM adapter and does not own secret resolver helpers.

- [ ] **Step 2: Document secret boundary**

Docs/manuals must say:

- host/controller resolves `source: "1password"`
- gateway VM does not need `op`
- OpenClaw plugin does not receive `OP_*`
- effective configs are generated under `cacheDir`
- mediated provider secrets are preferred for remote API tokens
- raw env injection is explicit and exceptional

- [ ] **Step 3: Update generated init comments**

Generated `system.jsonc` should include:

```jsonc
"mcpPortal": {
  // Managed MCP Portal for this OpenClaw zone.
  // The controller reads mcp.config.jsonc and mcp-portal.config.jsonc,
  // resolves host-side secrets, and writes VM-safe effective configs
  // under cacheDir before gateway boot.
  "configDir": "config/gateways/<zoneId>"
}
```

- [ ] **Step 4: Verify docs/manual tests**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/cli/manual-templates.test.ts packages/agent-vm/src/cli/init-command.test.ts
```

Expected: exit 0.

---

## Task 11: Full Validation Gate

**Files:**
- No source files changed in this task unless validation exposes fixes.

- [ ] **Step 1: Run targeted package tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test
pnpm --filter @agent-vm/openclaw-mcp-portal-plugin test
```

Expected: exit 0.

- [ ] **Step 2: Run controller/gateway tests**

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/gateway packages/agent-vm/src/operations packages/openclaw-gateway/src packages/gateway-interface/src packages/config-contracts/src
```

Expected: exit 0.

- [ ] **Step 3: Run integration tests**

Run:

```bash
pnpm vitest run --root . --config vitest.integration.config.ts packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
```

Expected: exit 0.

- [ ] **Step 4: Run OpenClaw smoke**

Run:

```bash
AGENT_VM_OPENCLAW_SMOKE=1 pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/openclaw-mcp-portal.smoke.test.ts
```

Expected: exit 0.

- [ ] **Step 5: Run repo gate sequentially**

Run:

```bash
pnpm fmt:check
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:smoke
pnpm check
```

Expected: every command exits 0.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
rg -n "mcp_portal_.*__|mcp-portal-subprocess|portal subprocess|OP_SERVICE_ACCOUNT_TOKEN|OP_CONNECT_TOKEN|spawn op|source: \"1password\"" packages docs config
```

Expected:

- no unrelated files changed
- no old per-agent portal server names remain in managed OpenClaw code
- no subprocess supervisor remains in the OpenClaw adapter path
- no `OP_*` forwarding remains
- effective-config tests contain no `source: "1password"` in generated output
- docs clearly separate `/core`, native OpenClaw, `/mcp-proxy`, and `/cli`

---

## Stacked Delivery Recommendation

Ship as stacked PRs unless the branch owner explicitly asks for one large PR:

1. PR1: shared `@agent-vm/secrets` extraction and dependency cleanup.
2. PR2: `/core` extraction and path exports.
3. PR3: native OpenClaw plugin adapter and old subprocess removal.
4. PR4: `mcpPortal` rename and managed materialization with cache-backed effective configs.
5. PR5: `/mcp-proxy` auth and CLI adapter.
6. PR6: validate/doctor/integration/smoke/docs.

Each PR must leave the repo buildable and must include the tests for its own boundary.

## Self-Review

- OpenClaw direction is no longer unresolved: native-tool is the primary path.
- `/mcp-proxy` remains, but only as an external adapter.
- `/cli` is direct-to-core.
- Manifest `contracts.tools` is explicitly covered.
- `before_prompt_build` and `before_tool_call` responsibilities are separated.
- `mcpPortal` rename includes controller, lifecycle, plugin, docs, and migration surfaces.
- Effective configs are cache-backed, not state-backed.
- Materialization covers both `mcp.config.jsonc` and `mcp-portal.config.jsonc`.
- Runtime mediated secrets are first-class, not smuggled through raw env.
- validate/doctor no longer checks old per-agent portal endpoints.
- OpenClaw smoke targets native tools through gateway tool invocation/effective tools, not direct portal MCP ingress.
