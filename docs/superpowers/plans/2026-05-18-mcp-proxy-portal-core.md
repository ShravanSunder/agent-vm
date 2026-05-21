# MCP Portal Native OpenClaw And External Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor MCP Portal into a shared `/core` runtime with three adapters: native OpenClaw tools for gateway agents, `/mcp-proxy` for external MCP clients and PI harness use, and one public `agent-vm-mcp-portal` CLI for operator workflows, while keeping 1Password resolution on the correct host-side process boundary.

**Architecture:** `@agent-vm/mcp-portal/core` owns policy, catalog/search, approval evaluation, redaction, streaming event normalization, and upstream MCP routing. `@agent-vm/openclaw-mcp-portal-plugin` is the primary OpenClaw adapter and registers native OpenClaw tools that call core directly with trusted `ctx.agentId`; it does not spawn the portal server or use loopback HTTP. `@agent-vm/mcp-portal/mcp-proxy` and `@agent-vm/mcp-portal/cli` are separate external adapters that authenticate callers before constructing trusted agent scope; `/mcp-proxy` is started through the single public `agent-vm-mcp-portal serve` command, not a second binary.

**Tech Stack:** TypeScript, pnpm monorepo, Zod, Hono, `@modelcontextprotocol/sdk`, Vitest, OXC, OpenClaw plugin SDK, Gondolin HTTP mediation, OpenClaw smoke harness.

---

## Decisions

- OpenClaw uses native-tool mode, not MCP-registry mode.
- Managed OpenClaw mode does not run `agent-vm-mcp-portal-server` inside the gateway VM.
- Managed OpenClaw mode does not generate `mcp.servers.mcp_portal_<agentId>` entries.
- Managed OpenClaw mode does not open the portal subprocess port `18790`.
- `/mcp-proxy` still exists, but only for external MCP clients, PI harness use, and standalone deployments.
- `agent-vm-mcp-portal` is the only public MCP Portal CLI binary.
- `agent-vm-mcp-portal serve` starts `/mcp-proxy`; there is no public `agent-vm-mcp-portal-server` binary.
- `/cli` calls `/core` directly for local operator commands; it does not call a local HTTP server by default.
- PI harness and generic external MCP clients outside OpenClaw use `/mcp-proxy`; managed OpenClaw does not preserve legacy portal entries in `cfg.mcp.servers`.
- Codex harness/app-server projection support is out of scope for this delivery. Do not preserve or add portal-specific Codex harness behavior in this refactor.
- Secret resolution is not a Gondolin responsibility. 1Password/env/composite resolver helpers live in a shared `@agent-vm/secrets` package so controller, gateway packages, MCP Portal, and tests do not depend on `@agent-vm/gondolin-adapter` just to resolve secrets.
- `/core` does not authenticate requests. Adapters authenticate and pass trusted `PortalAgentScope`.
- `PortalAgentScope` carries a source discriminator (`openclaw-trusted`, `mcp-proxy-bearer`, or `cli-operator`) plus both OpenClaw `sessionId` and `sessionKey` when present. The source is adapter-owned evidence about how the scope was established, not an authorization shortcut inside `/core`.
- All adapter-visible portal tool descriptors are config-derived after trusted agent scope is established.
- Portal tool execution is event-first. `/core` exposes streaming execution for upstream progress and for notification/partial-content events when a runtime can source them. Streaming is the primitive; collection is a derived helper for callers that only need the final response. Synthetic progress is allowed for local milestones, but it is not a substitute for plumbing real upstream MCP progress when the SDK/transport exposes it.
- Adapters decide how to present the same `/core` event stream: OpenClaw native tools forward updates through OpenClaw `onUpdate` and return one final tool result; `/mcp-proxy` forwards MCP notifications/progress to MCP clients; `/cli` writes progress to stderr and final output to stdout.
- The host/controller materializes config and secrets before gateway boot. At runtime, OpenClaw calls `/core` directly in the gateway VM.
- Credential export is an explicit secret-extraction operation. It must require a master-key fingerprint check before writing any per-agent bearer.
- Per-agent bearers must never be printed to stdout, stderr, diagnostics, debug logs, smoke logs, or doctor output. Commands may print only metadata: agent id, output path, key fingerprint, and rotation timestamp.
- Effective MCP Portal configs are rebuildable and live under `cacheDir`, not `stateDir`.
- The gateway VM and portal adapters never receive `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_TOKEN`, `OP_SESSION`, or other 1Password process credentials.
- Authored `source: "1password"` in MCP Portal configs is a host/controller instruction. The controller materializes it before gateway boot.
- Managed OpenClaw portal config loads during gateway startup. The controller derives MCP provider network needs before boot: HTTP/SSE upstream provider hosts, stdio provider `requiredEgressHosts`, and `http-mediation` secret hosts are folded into the effective gateway egress used to boot the VM. Authored `zone.egressHosts` remains deployment-owned input, but MCP Portal-required remote hosts are compiled into the runtime VM spec automatically. Loopback MCP provider URLs stay local and do not create external egress. Managed OpenClaw opens no MCP Portal-specific ingress route.
- HMAC bearer verification is stateless. Per-agent bearer revocation requires rotating `externalAuth.masterKey`, which invalidates all derived credentials that share that master-key fingerprint.
- `externalAuth.masterKey` values resolve to canonical base64url-encoded key material and must decode to at least 32 bytes before bearer or approval HMAC keys are derived. Do not interpret master-key secrets as arbitrary UTF-8 strings.
- `agent-vm-mcp-portal serve` is hard-cut to `/mcp-proxy` only. Legacy shared-header `server.accessHeader` startup, `serverAccess` HTTP auth, and `MCP_PORTAL_SERVER_SECRET` are removed from the external proxy path.
- Package root imports must not pull `/mcp-proxy` or Hono into the OpenClaw native plugin. OpenClaw plugin code imports from `@agent-vm/mcp-portal/core` only.

## Evidence Anchors

- OpenClaw native tools exist: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/types.ts:2541`
- OpenClaw native tool context includes `agentId`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/tool-types.ts:13`
- OpenClaw native tool execution accepts `onUpdate`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/tools/common.ts:21`
- OpenClaw preserves `onUpdate` through the tool adapter: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/pi-tool-definition-adapter.ts:236`
- OpenClaw requires registered tools in manifest `contracts.tools`: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/plugins/registry.ts:540`
- OpenClaw `before_tool_call` can block or require approval: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/pi-tools.before-tool-call.ts:505`
- Pre-refactor MCP Portal plugin is subprocess-based: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts:254`
- Pre-refactor controller generates per-agent portal MCP servers: `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts:27`
- Pre-refactor 1Password resolver lived in the Gondolin package: `packages/gondolin-adapter/src/secret-resolver.ts`.
- Pre-refactor composite resolver lived in controller code: `packages/agent-vm/src/controller/composite-secret-resolver.ts`.
- Pre-refactor `gateway-interface` imported secret types from Gondolin: `packages/gateway-interface/src/gateway-lifecycle.ts:1`.
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

Operator CLI
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
	- Owns trusted agent scope, provider runtime creation, policy maps, session/cache, approval evaluation, portal operation execution, and upstream MCP calls.
	- Owns scoped tool descriptors: names, descriptions, schemas, and catalog hints are computed from `mcp.config.jsonc`, `mcp-portal.config.jsonc`, and `PortalAgentScope`.
	- Owns the canonical `PortalCoreEvent` stream and `collectPortalCoreResult(...)` helper.
	- Must not import Hono, OpenClaw plugin APIs, process supervisor code, or CLI argument parsing.
	- Must not expose Promise-only upstream execution as the streaming implementation. `callStream(...)` drives upstream execution and `collectPortalCoreResult(...)` consumes that stream.
- `/mcp-proxy`
  - Owns Hono/Streamable HTTP MCP server, external request authentication, MCP protocol translation, and adapter-specific agent scope creation.
  - Asks `/core` for MCP tool descriptors only after request auth proves the requested agent scope.
  - Calls `/core` streaming execution and maps progress/events onto MCP notifications before returning the final MCP tool result.
  - Requires bearer authentication at the HTTP app boundary; there is no legacy shared-secret fallback.
- `/cli`
  - Owns CLI parsing, credential-file loading/writing, operator auth, command rendering, and `serve` command wiring for `/mcp-proxy`.
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
- Its package import closure must not include Hono or `/mcp-proxy`.

### `packages/agent-vm`

- Owns system config field `zones[].mcpPortal`.
- Owns host-side materialization from authored config to effective config.
- Writes effective config under `<cacheDir>/gateways/<zoneId>/mcp-portal-effective`.
- Passes the VM path `/home/openclaw/.openclaw/cache/mcp-portal-effective` to the OpenClaw plugin.
- Injects generated runtime env secrets and generated runtime mediated secrets into the gateway VM spec.
- Compiles required gateway egress hosts from MCP HTTP/SSE provider URLs, explicit stdio provider `requiredEgressHosts`, and `http-mediation` secret policies before boot.
- Does not ask Gondolin or the SDK to infer network access from MCP config. It compiles authored `zone.egressHosts` plus MCP Portal-required remote provider/secret hosts into Gondolin `allowedHosts`.
- Must not open portal-specific ingress for managed OpenClaw.

---

## Task 0: Inventory Prior Attempts And Add Cleanup Guards

**Files:**
- Modify: `docs/superpowers/plans/2026-05-18-mcp-proxy-portal-core.md`
- Modify tests that guard against stale attempt paths

- [ ] **Step 1: Inventory every prior MCP Portal attempt**

Run:

```bash
rg -n "mcp-portal|mcp_portal|MCP_PORTAL|agent-vm-mcp-portal-server|portal-server|portal subprocess|18790|source: \"1password\"|OP_SERVICE_ACCOUNT_TOKEN|runtimeMcpServers|mcp\\.servers\\.mcp_portal|mcpProxy|externalAuth" packages docs
```

If running against a deployment checkout that has a top-level `config/` directory, run the same search against `config/` separately. Do not include a missing `config/` path in this repo command; `rg` exits with an error for missing roots.

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
- `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/plugin-subprocess-wiring.test.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts`
- `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
- `packages/mcp-portal/package.json`
- `packages/mcp-portal/src/bin/portal-server.ts`
- `packages/mcp-portal/src/bin/portal-server.test.ts`
- `packages/mcp-portal/src/bin/portal-server.integration.test.ts`
- `packages/mcp-portal/src/mcp-server`
- `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`
- `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.test.ts`
- `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/config-contracts/src/mcp-portal-config.test.ts`
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

- [ ] **Step 4: Assign stale artifact cleanup owners**

Do not delete replacement-sensitive source files in Task 0. Assign each stale artifact to the task that builds its replacement so every stacked PR remains buildable:

- plugin subprocess artifacts -> Task 3, after native OpenClaw tool registration exists
- public portal server bin/tests -> Task 2 for package exports and Task 7 for `agent-vm-mcp-portal serve`
- OpenClaw MCP-registry materializer/tests -> Task 4, after `mcpPortal` zone wiring replacement exists
- reusable helper code -> Task 5 effective config materializer
- docs/manual references -> Task 10

Move reusable code instead of duplicating it:

- portal MCP protocol code -> `packages/mcp-portal/src/mcp-proxy`
- portal server integration coverage -> `packages/mcp-portal/src/mcp-proxy/portal-http-server.integration.test.ts`
- provider/policy/session code -> `packages/mcp-portal/src/core`
- server startup code -> `packages/mcp-portal/src/cli/serve-command.ts`
- materialization helpers -> `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts`

- [ ] **Step 5: Verify cleanup baseline**

Run:

```bash
rg -n "agent-vm-mcp-portal-server|portal subprocess|createPortalSubprocessSupervisor|mcp_portal_.*__|runtimeMcpServers|mcp\\.servers\\.mcp_portal|OP_SERVICE_ACCOUNT_TOKEN|OP_CONNECT_TOKEN|spawn op|source: \"1password\"" packages docs
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
| `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.ts` | Supervises in-VM portal server process | Delete in Task 3 after native tool registration replaces it | `rg createPortalSubprocessSupervisor` has no managed runtime hits |
| `packages/openclaw-mcp-portal-plugin/src/portal-subprocess-supervisor.test.ts` | Tests the in-VM portal subprocess supervisor | Delete in Task 3 with supervisor | `rg createPortalSubprocessSupervisor packages/openclaw-mcp-portal-plugin/src` is clean |
| `packages/openclaw-mcp-portal-plugin/src/plugin-subprocess-wiring.test.ts` | Tests plugin wiring into the portal subprocess | Replace with native tool registration tests | tests assert native tools call `/core` and no subprocess wiring remains |
| `packages/openclaw-mcp-portal-plugin/src/portal-plugin-runtime-state.ts` | Tracks subprocess availability/state | Delete or replace only if native tool diagnostics need a smaller state object | hook/tool tests do not depend on subprocess availability |
| `packages/openclaw-mcp-portal-plugin/src/portal-config.ts` | Carries default portal server binary path and old plugin config defaults | Rewrite to native adapter config only, removing `defaultPortalBinPath` | `rg defaultPortalBinPath packages/openclaw-mcp-portal-plugin` is clean |
| `packages/mcp-portal/package.json` | Exposes both public portal binaries | Remove `agent-vm-mcp-portal-server`; expose only `agent-vm-mcp-portal` and package subpath exports | package bin map test asserts one public binary |
| `packages/mcp-portal/src/bin/portal-server.ts` | Public standalone server binary | Remove public bin in Task 2; move server startup to `agent-vm-mcp-portal serve` in Task 7 | package bin map exposes only `agent-vm-mcp-portal` |
| `packages/mcp-portal/src/bin/portal-server.test.ts` | Tests the deleted standalone server binary | Rewrite relevant startup cases under `/cli/serve-command.test.ts`; delete server-bin-specific cases | `rg portal-server packages/mcp-portal/src/bin packages/mcp-portal/src/cli` only shows intentional serve-command tests |
| `packages/mcp-portal/src/bin/portal-server.integration.test.ts` | Tests end-to-end standalone server behavior | Move to `/mcp-proxy` integration coverage driven by `agent-vm-mcp-portal serve` or an imported proxy server helper | proxy integration test covers initialize, tools/list, streaming tools/call, auth rejection |
| `packages/mcp-portal/src/mcp-server` | MCP protocol server implementation | Move to `packages/mcp-portal/src/mcp-proxy` | imports use `mcp-proxy`; proxy integration test passes |
| `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts` | Generates OpenClaw `mcp.servers.mcp_portal_*` entries | Delete in Task 4 after `mcpPortal` wiring replacement exists; reusable config checks move to effective materializer | orchestrator tests assert no `runtimeMcpServers` portal entries |
| `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.test.ts` | Tests generated OpenClaw MCP registry entries | Delete in Task 4 with materializer; move any effective-config safety assertions to `mcp-portal-effective-config.test.ts` | `rg mcp-portal-openclaw-materialization packages/agent-vm/src/gateway` is clean |
| `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` | Wires zone MCP portal into OpenClaw gateway | Rewrite to call effective config materializer and pass plugin config only | gateway-zone-orchestrator tests assert cache-backed effective config and no portal MCP registry |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | Writes OpenClaw effective config and VM spec | Keep unrelated MCP merging; remove portal default config and merge runtime env/mediated secrets | lifecycle tests assert no default portal server config and runtime secret collision handling |
| `packages/config-contracts/src/mcp-portal-config.test.ts` | Tests portal server config defaults including port `18790` | Rewrite around agents/profiles/policy plus optional external proxy auth; no managed OpenClaw server port default | config-contract tests do not require port `18790` for native OpenClaw |
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
- Modify package imports that currently use `SecretRef`, `SecretResolver`, or the old `SecretSpec` name from `@agent-vm/gondolin-adapter`

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

Use `MediatedSecretSpec` as the single public name for `{ hosts, value }`. Do not create a second gateway-interface type for the same shape, and do not leave a `SecretSpec` compatibility alias after this hard cutover.

Do not leave downstream packages importing `SecretRef`, `SecretResolver`, old `SecretSpec`, or `MediatedSecretSpec` from `@agent-vm/gondolin-adapter`.

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
rg -n "SecretRef|SecretResolver|SecretSpec|MediatedSecretSpec|createSecretResolver|resolveServiceAccountToken" packages --glob '*.ts'
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
- Move: `packages/mcp-portal/src/mcp-server/portal-tools.ts` -> `packages/mcp-portal/src/core/portal-tools.ts`
- Move: `packages/mcp-portal/src/mcp-server/portal-call-validation.ts` -> `packages/mcp-portal/src/core/portal-call-validation.ts`
- Modify: `packages/mcp-portal/src/index.ts`
- Modify: `packages/mcp-portal/package.json`
- Modify: `packages/mcp-portal/tsdown.config.ts`
- Test: `packages/mcp-portal/src/core/*.test.ts`

- [ ] **Step 1: Add failing core boundary tests**

Create tests that prove:

- `createPortalAgentScope(...)` rejects empty/control-character identity fields.
- `createPortalCore(...)` accepts loaded `McpConfig`, loaded `McpPortalConfig`, and a caller-provided secret resolver.
- `createPortalCore(...)` exposes `callStream(...)` for all four portal operations without requiring HTTP, Hono, CLI args, or OpenClaw APIs.
- `createPortalCore(...).createAgentScope({ agentId, agentScopeId, source, sessionId, sessionKey })` requires an explicit `source`; there is no default source fallback. Agent existence is enforced by adapters before scope construction and by policy/session checks during calls.
- `createPortalCore(...).describeTools(scope)` returns the four portal tool descriptors with descriptions derived from the agent's configured profile, allowed namespaces, and provider metadata.
- descriptor text is helpful for the model, but execution authorization still happens inside `/core` on every call.
- batch `mcp_portal_call` is validated and approved as one batch before upstream contact; duplicate request ids or missing approval cannot be bypassed by streaming each item through `handlers.call(...)` separately.
- pre-aborted `AbortSignal` stops `callStream(...)` before upstream contact, and abort during streaming closes the active upstream call path before yielding a terminal `failed` event.
- `callStream(...)` can emit real upstream `upstream_notification` and `partial_content` events from a fake upstream runtime; the test must fail if only synthetic progress is emitted.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/mcp-portal/src/core
```

Expected: FAIL before `/core` exists.

- [ ] **Step 2: Promote trusted agent identity into `/core`**

Create `packages/mcp-portal/src/core/agent-scope.ts` with:

- `PortalAgentScopeSource = 'openclaw-trusted' | 'mcp-proxy-bearer' | 'cli-operator'`
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

Adapter source rules:

- OpenClaw native plugin creates scopes with `source: "openclaw-trusted"`, `agentId: ctx.agentId`, `agentScopeId: ctx.agentId`, and preserves both `ctx.sessionId` and `ctx.sessionKey` when OpenClaw supplies them.
- `/mcp-proxy` creates scopes with `source: "mcp-proxy-bearer"` only after bearer auth verifies the requested `agentId`.
- `/cli` creates scopes with `source: "cli-operator"` only after a credential file or explicit local operator trust proves the requested `agentId`.
- `/core` may log/audit the source but does not treat `source` as authentication. Authentication happened in the adapter.

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
- `describeTools(...)`
- `callStream(...)`
- `collectPortalCoreResult(...)`
- `approval.evaluateCalls(...)`
- `close()`
- `invalidateAgentScope(...)`
- `upstreamNamespaces`

The core execution contract must support both streaming and collection. Do not make upstream execution Promise-only. Promise-only handlers silently discard upstream MCP progress notifications and streaming output.

`createPortalCore(...)` must fail closed around approval. External adapters pass an explicit approval evaluator. Managed OpenClaw passes an explicit `approvalTrustBoundary: "openclaw-before-tool-call-hook"` marker, because OpenClaw already delivered post-policy params through the trusted hook path. Do not let a missing approval callback silently mean allow-all.

Add adapter-neutral result and event types:

```ts
export type PortalCoreToolName =
	| 'mcp_portal_list'
	| 'mcp_portal_search'
	| 'mcp_portal_describe'
	| 'mcp_portal_call';

export interface PortalCoreResult {
	readonly items: readonly PortalCoreItemResult[];
	readonly content: readonly PortalCoreContentBlock[];
	readonly structuredContent?: unknown;
	readonly auditEvents?: readonly PortalAuditEvent[];
}

export type PortalCoreItemResult =
	| {
			readonly content: readonly PortalCoreContentBlock[];
			readonly requestId: string;
			readonly status: 'success';
			readonly structuredContent?: unknown;
	  }
	| {
			readonly error: PortalCoreItemError;
			readonly requestId: string;
			readonly status: 'failed';
	  };

export interface PortalCoreItemError {
	readonly code: string;
	readonly message: string;
	readonly namespace?: string;
	readonly toolName?: string;
}

export type PortalCoreContentBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'json'; readonly value: unknown };

export type PortalCoreEvent =
	| {
			readonly kind: 'started';
			readonly toolName: PortalCoreToolName;
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
			readonly result: Extract<PortalCoreItemResult, { readonly status: 'success' }>;
			readonly requestId: string;
	  }
	| {
			readonly error: PortalCoreItemError;
			readonly kind: 'item_failed';
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
	readonly toolName: PortalCoreToolName;
}

export interface PortalCoreCollectOptions {
	readonly onEvent?: (event: PortalCoreEvent) => void | Promise<void>;
}
```

`callStream(call: PortalCoreStreamCall)` returns `AsyncIterable<PortalCoreEvent>`.
`collectPortalCoreResult(events: AsyncIterable<PortalCoreEvent>, options?: PortalCoreCollectOptions)` consumes that event stream and returns the final `PortalCoreResult`. When `options.onEvent` is provided, the helper must call it for each event before collecting the final result. Collection must not call upstream directly.

Event stream ordering is part of the `/core` API contract:

```text
stream = started (batch | scalar) (completed | failed)
batch  = item_event* completed
item_event =
	| item_started
	| progress
	| partial_content
	| upstream_notification
	| item_completed
	| item_failed
scalar = (progress | partial_content | upstream_notification)*
```

Rules:

- `mcp_portal_call` uses the `batch` form. Every requested upstream call emits exactly one `item_started` and exactly one terminal item event: `item_completed` or `item_failed`.
- Once `item_started { requestId: r }` has been emitted, later `progress`, `partial_content`, and `upstream_notification` events for that item must carry `requestId: r`.
- Batch item streams may interleave because `/core` can execute validated/approved batch items concurrently. Do not require item 1 to emit `item_completed` before item 2 emits `item_started`; use `requestId` to associate updates and terminal events with the correct item.
- A terminal `item_completed` or `item_failed` for request `r` must not appear before that request's `item_started`.
- Batch-level progress without `requestId` is allowed only before the first `item_started`.
- `partial_content` is a discriminated event variant, not a generic field. Emit it only when an upstream runtime/provider has real incremental content; never synthesize fake partial chunks just to exercise the type. The final collected content for each successful batch item must appear in the matching `item_completed.result.content`; adapters must not depend on replaying partial events to reconstruct the final result.
- `mcp_portal_list`, `mcp_portal_search`, and `mcp_portal_describe` use the `scalar` form. They do not emit synthetic item events; their final payload is `completed.result.content` and `completed.result.items` is empty.
- `mcp_portal_call` populates `completed.result.items`; `completed.result.content` is empty unless `/core` adds a human-readable aggregate summary in a later explicit change.

Tests must include a fake batch call with one successful item, one failed item, and at least one `progress` event carrying the correct `requestId`.

Batch execution invariants:

- Parse and validate the full `mcp_portal_call` input once.
- Reject duplicate request ids before any upstream contact.
- Evaluate approval for the complete batch once before any upstream contact.
- Do not implement streaming by calling the old collected `handlers.call(...)` once per item. That bypasses batch-level duplicate-id validation and batch-level approval.
- After validation and approval, start executable items in input order. Items may run concurrently; stream per-item updates as they arrive and use `requestId` for association.

Abort/cancellation invariants:

- Check `call.signal?.aborted` before yielding `started`, before each upstream item, after each upstream event, and before yielding `completed`.
- On abort, close the active upstream operation/client where the runtime exposes a close/cancel hook, yield one terminal `failed` event with an `AbortError`-shaped error, and return.
- Consumers may call `.return()` on the async iterator; `/core` must treat early iterator close as cancellation and release upstream resources.
- Adapters must pass their native abort/cancel signal into `callStream(...)`.

Upstream streaming invariants:

- The upstream runtime call contract accepts `signal` and an `onEvent` callback whose payload is itself a discriminated union: `progress`, `upstream_notification`, or `partial_content`.
- The stock MCP SDK `callTool(...)` path maps request-scoped `RequestOptions.onprogress` into upstream `progress` events. `upstream_notification` and `partial_content` remain `/core` event variants for custom runtimes, fake runtimes, or future SDK/transport paths that can source request-correlated notifications/chunks; the stock SDK bridge must not fabricate those variants when the SDK only exposes progress.
- `/core` may emit local synthetic progress before each upstream call, but tests must separately prove that real upstream `onEvent` progress/notification/partial-content events pass through when a runtime emits them.
- Whole-result redaction, schema validation, and size enforcement may buffer final results, but buffering must be a named policy/implementation decision and must not erase already-emitted progress events.

Adapters translate the same stream differently:

- native OpenClaw adapter forwards safe progress events through `onUpdate` on a best-effort basis and converts the final result to OpenClaw `AgentToolResult`. A failed `onUpdate` delivery is logged and dropped; it must not fail the tool call.
- `/mcp-proxy` maps progress/upstream notification events to MCP notifications and converts the final result to MCP server result content.
- `/cli` prints progress/upstream notification summaries to stderr and converts the final result to terminal stdout.

Use existing code from:

- `packages/mcp-portal/src/portal-session.ts`
- `packages/mcp-portal/src/core/portal-tools.ts`
- `packages/mcp-portal/src/core/portal-call-validation.ts`
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`

The core handler signatures must use `PortalAgentScope`, not HTTP request state or OpenClaw context.

Do not expose separate public `handlers.list/search/describe/call` entry points. Adapters call `callStream(...)` with a `PortalCoreToolName`; callers that need a final response call `collectPortalCoreResult(...)` over that stream. This keeps `/core` from growing parallel execution paths.

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

- [ ] **Step 6: Remove the public server bin mapping**

Remove the public `agent-vm-mcp-portal-server` entry from `packages/mcp-portal/package.json`.

Do not delete `packages/mcp-portal/src/bin/portal-server.ts` in this task. Task 7 moves the reusable startup logic into `packages/mcp-portal/src/cli/serve-command.ts`, invoked by:

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
- The native tool descriptions must be scoped to the current `ctx.agentId`. OpenClaw tool factories are synchronous, so the plugin may derive descriptor text from the already-loaded effective portal config/profile instead of awaiting `/core.describeTools(scope)` in the factory. If the config is not loaded yet, the factory may fall back to the static four tool contracts for names/schema, but tests must cover the warmed-config path where descriptions include the agent's allowed namespaces.

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
- register the four native tools from `/core`'s static portal wrapper descriptors
- use OpenClaw's tool factory form so execution can capture trusted `ctx.agentId`
- in each tool factory, require `ctx.agentId`
- construct `PortalAgentScope` from `ctx.agentId`, `ctx.sessionId`, and `ctx.sessionKey`
- call the matching core streaming execution path
- forward safe `progress`, `partial_content`, and `upstream_notification` summaries through the OpenClaw `onUpdate` callback when it is provided
- collect the `completed` event into the final OpenClaw tool result `{ content: JSON.stringify(result), details: result }`

Tool input schemas must come from the existing portal schemas in `portal-tools.ts` or the moved `/core` equivalent.

OpenClaw evidence: the native tool factory is synchronous. Do not require the factory to await config loading or per-agent catalog discovery while producing tool definitions. The registered native tools are the four stable portal wrapper tools; per-agent catalog and policy are enforced by `/core` when list/search/describe/call executes.

Do not rely on descriptor text as the security boundary; descriptors improve tool UX, while `/core` policy enforces every list/search/describe/call.

OpenClaw native tool execution receives `onUpdate` as the fourth argument. Use that callback for progress only; do not invent a loopback HTTP stream to carry progress.

- [ ] **Step 5: Replace subprocess availability checks**

Remove logic that blocks because a portal subprocess is unavailable.

Delete `portalServerNameForAgent` and `packages/openclaw-mcp-portal-plugin/src/portal-tool-policy.ts` if `rg portalServerNameForAgent packages/openclaw-mcp-portal-plugin packages/agent-vm/src` shows no remaining non-legacy consumer after Task 3 and Task 4 rewrites. This is a hard cutover; do not keep dead helpers for old server-prefixed tool names.

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
- construct `/core` with the explicit OpenClaw hook trust marker, not with a missing approval callback
- keep existing HMAC approval token helpers only for external adapter flows where the approval decision crosses a process/network boundary

Approval handoff rule:

- the `before_tool_call` hook returns post-policy `params`
- OpenClaw passes those params to the tool through `policyAdjustedParams`
- the native `mcp_portal_call` tool factory must execute exactly the `params.calls` it receives in `execute(toolCallId, params, context, onUpdate)`
- the native tool must not re-parse pre-hook event params, must not look up stale original params from runtime state, and must not re-run approval policy inside the tool

Evidence anchor: `/Users/shravansunder/Documents/dev/open-source/ai-harness/openclaw/src/agents/pi-tools.before-tool-call.ts:585`.

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
	        "networkAccess": "declared",
	        "requiredEgressHosts": ["api.tavily.com"],
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

- every provider secret in `transport.env` or `transport.headers`, whether authored as `source: "1password"` or `source: "environment"`, requires explicit `secretPolicies.<secretName>`.
- managed OpenClaw materialization rewrites every provider secret to a generated `source: "environment"` ref whose env name includes the provider namespace and the secret key, for example `AGENT_VM_MCP_LINEAR_AUTHORIZATION`. Do not key generated env names by secret key alone; two providers commonly use the same header name.
- stdio providers must declare `transport.networkAccess`.
- `transport.networkAccess: "declared"` requires non-empty `transport.requiredEgressHosts` covering every network host the child MCP process may contact. Stdio MCP providers do not have an MCP URL in config because `/core` starts a local process; `requiredEgressHosts` is the URL/host contract for the remote APIs that process talks to. The materializer cannot infer stdio egress from `command` or `args`.
- `transport.networkAccess: "none"` requires `transport.requiredEgressHosts` to be omitted or empty and is valid only for local-only stdio providers.
- HTTP/SSE providers derive required egress from `transport.url`; they may also declare extra `transport.requiredEgressHosts` when the provider contacts additional hosts.
- do not silently infer mediation hosts from provider URLs in the first implementation.
- `injection: "env"` is allowed only when explicitly configured.
- `http-mediation` requires at least one host.
- malformed, wildcard, empty, or dynamic hosts fail validation.

- [ ] **Step 2: Make external proxy config optional for OpenClaw and required for `serve`**

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
      "port": 18791
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
- `agent-vm-mcp-portal write-credential` also requires `mcpProxy` unless the operator passes an explicit `--proxy-url`; it must fail loudly rather than writing `proxyUrl: null` or inventing a default.
- External `/mcp-proxy` HTTP bearer mode is loopback-only. `mcpProxy.server.host` must be `127.0.0.1`, `localhost`, or `::1`; public exposure requires a future explicit TLS/public URL contract, not binding raw HTTP bearer auth to `0.0.0.0`.
- `/cli` may use a credential file generated from `externalAuth.masterKey`.
- Remove legacy `server` / shared-header config from the schema and the active `serve` path. A config containing `server.accessHeader` must fail validation rather than being accepted and stripped later.
- Do not default the external proxy port to `18790`; that literal belonged to the deleted gateway subprocess. Prefer an explicit port in config. If a default is kept for operator convenience, use a new external-proxy default and document that it is unrelated to managed OpenClaw.

- [ ] **Step 3: Add failing materializer tests**

Tests must create `authoredDir` and `effectiveDir` before writing files.

Prove:

- provider `source: "1password"` and `source: "environment"` secrets are resolved through `secretResolver.resolveAll(...)` once on the host/controller side.
- effective `mcp.config.jsonc` contains only `source: "environment"` secret refs.
- effective `mcp-portal.config.jsonc` contains no `source: "1password"` when `externalAuth.masterKey` is present.
- materializer outputs runtime env secrets for `injection: "env"`.
- materializer outputs runtime mediated secrets for `injection: "http-mediation"`.
- materializer fails loudly when `secretResolver.resolveAll(...)` omits an expected generated env name or returns an empty string; it must never inject `""` as a fallback secret value.
- materializer reports required gateway egress hosts for HTTP/SSE provider URLs, explicit provider `requiredEgressHosts`, and mediated-secret hosts without editing the authored `zone.egressHosts`.
- startup merges reported remote hosts into the effective lifecycle zone egress before building the OpenClaw VM spec.
- effective files are written under `<cacheDir>/gateways/<zoneId>/mcp-portal-effective`.

Add these concrete tests to `packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts` before implementing the materializer:

- `planMcpPortalEffectiveConfig reports HTTP provider URL hosts as required gateway egress`: authored `mcp.config.jsonc` has provider transport `{ kind: "streamable-http", url: "https://mcp.deepwiki.com/mcp" }`; expected `requiredGatewayEgressHosts` contains `mcp.deepwiki.com`.
- `planMcpPortalEffectiveConfig reports SSE provider URL hosts as required gateway egress`: authored transport `{ kind: "sse", url: "https://events.linear.app/sse" }`; expected `requiredGatewayEgressHosts` contains `events.linear.app`.
- `planMcpPortalEffectiveConfig reports stdio requiredEgressHosts`: authored transport `{ kind: "stdio", command: "npx", args: ["-y", "tavily-mcp"], networkAccess: "declared", requiredEgressHosts: ["api.tavily.com"], env: {} }`; expected `requiredGatewayEgressHosts` contains `api.tavily.com`.
- `planMcpPortalEffectiveConfig requires stdio networkAccess`: authored stdio provider without `networkAccess` fails with a message naming the provider namespace.
- `planMcpPortalEffectiveConfig requires stdio egress declaration for network-capable providers`: authored stdio provider with `networkAccess: "declared"` and missing or empty `requiredEgressHosts` fails.
- `planMcpPortalEffectiveConfig allows explicitly local-only stdio providers`: authored stdio provider with `networkAccess: "none"` and no `requiredEgressHosts` succeeds and adds no required gateway egress host.
- `planMcpPortalEffectiveConfig includes mediated secret hosts as required gateway egress`: authored stdio provider has `env.TAVILY_API_KEY.source = "1password"` and `secretPolicies.TAVILY_API_KEY = { injection: "http-mediation", hosts: ["api.tavily.com"] }`; expected `requiredGatewayEgressHosts` contains `api.tavily.com`.
- `planMcpPortalEffectiveConfig deduplicates required gateway egress hosts`: authored HTTP provider URL host and mediated secret host both use `api.linear.app`; expected `requiredGatewayEgressHosts` contains `api.linear.app` once.
- `planMcpPortalEffectiveConfig rejects wildcard, empty, or malformed provider or mediated hosts`: examples `*.example.com`, `""`, and `"https://api.example.com/path"` fail with a message naming the provider or secret policy and host.
- `planMcpPortalEffectiveConfig keeps authored network policy read-only`: mutate neither the authored MCP config object nor a supplied `zone.egressHosts` fixture; the materializer only reports `requiredGatewayEgressHosts`.
- `planMcpPortalEffectiveConfig ignores loopback provider URLs for external egress`: authored HTTP/SSE provider URLs on `127.0.0.1`, `localhost`, or `::1` add no `requiredGatewayEgressHosts`.
- `writeMcpPortalEffectiveConfig generates provider-scoped secret env names`: two providers with a header named `authorization` become distinct refs such as `AGENT_VM_MCP_LINEAR_AUTHORIZATION` and `AGENT_VM_MCP_NOTION_AUTHORIZATION`.
- `writeMcpPortalEffectiveConfig materializes authored environment provider secrets`: authored `{ source: "environment", name: "LINEAR_MCP_TOKEN" }` is resolved by the shared resolver and rewritten to a generated `AGENT_VM_MCP_LINEAR_AUTHORIZATION` ref in the effective MCP config.
- `writeMcpPortalEffectiveConfig rejects missing resolved secret values`: fake resolver returns `{}` for an expected `AGENT_VM_MCP_*` name; expected error names that env name and no effective file is treated as valid.
- `writeMcpPortalEffectiveConfig rejects empty resolved secret values`: fake resolver returns `""`; expected error names that env name.

Run:

```bash
pnpm vitest run --root . --config vitest.config.ts packages/agent-vm/src/gateway/mcp-portal-effective-config.test.ts
```

Expected: FAIL before materializer exists.

- [ ] **Step 4: Add runtime mediated secret plumbing**

Import `MediatedSecretSpec` from `@agent-vm/secrets` in `packages/gateway-interface/src/gateway-lifecycle.ts`. Do not define `RuntimeMediatedSecretBinding`; it is the same `{ hosts, value }` shape under a third name.

Extend `GatewayZoneConfig` with:

```ts
readonly runtimeMediatedSecrets?: Readonly<Record<string, MediatedSecretSpec>>;
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
- `requiredGatewayEgressHosts`
- `resolvedSecretNames`
- `effectiveConfigDir`

Implement two entrypoints:

```ts
export async function planMcpPortalEffectiveConfig(...): Promise<McpPortalEffectiveConfigPlan>;
export async function writeMcpPortalEffectiveConfig(...): Promise<McpPortalEffectiveConfigWriteResult>;
```

`planMcpPortalEffectiveConfig(...)` is the validate/doctor path. It computes effective config objects in memory, accepts a shape-only secret resolver, and never writes files.

`writeMcpPortalEffectiveConfig(...)` is the controller startup path. It calls the real secret resolver, writes files, and returns runtime env and mediated secret bindings.

`writeMcpPortalEffectiveConfig(...)` must write atomically:

- create the effective config directory with mode `0700`
- write each file as `<name>.tmp` with mode `0600`
- flush/fsync the file where the platform supports it
- `rename(2)` the temp file into place
- never leave partially written `mcp.config.jsonc` or `mcp-portal.config.jsonc` visible to the gateway plugin

Use the existing repo pattern in `packages/gondolin-adapter/src/write-file-atomically.ts` where practical.

The effective VM config must contain only environment references like:

```json
{ "source": "environment", "name": "AGENT_VM_MCP_TAVILY_TAVILY_API_KEY" }
```

For mediated secrets, the VM env value is the Gondolin placeholder generated by the mediation layer, not the raw token.

- [ ] **Step 6: Wire materializer into startup**

In `gateway-zone-orchestrator.ts`:

- add a passing test to `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts` named `adds MCP Portal upstream hosts to effective gateway egress`.
  - authored MCP config: HTTP provider URL `https://mcp.deepwiki.com/mcp`
  - zone `egressHosts`: does not include `mcp.deepwiki.com`
  - expected: startup reaches lifecycle `buildVmSpec(...)`
  - expected: `createManagedVm(...)` receives `allowedHosts` containing `mcp.deepwiki.com`.
- add a passing test named `does not duplicate MCP Portal upstream hosts declared for gateway egress`.
  - authored MCP config: HTTP provider URL `https://mcp.deepwiki.com/mcp`
  - zone `egressHosts`: includes `{ host: "mcp.deepwiki.com", audience: "gateway" }`
  - expected: `createManagedVm(...)` receives `allowedHosts` containing `mcp.deepwiki.com` only once.
- add a passing test named `keeps loopback MCP Portal provider URLs out of gateway egress`.
  - authored MCP config: HTTP provider URL `http://127.0.0.1:18791/mcp`
  - expected: startup reaches lifecycle `buildVmSpec(...)`
  - expected: `createManagedVm(...)` does not receive `127.0.0.1` or `localhost` as generated allowed hosts.
- if `zone.gateway.type === "openclaw"` and `zone.mcpPortal` exists, materialize configs before resolving the VM spec
- write effective configs under `path.join(systemConfig.cacheDir, 'gateways', zone.id, 'mcp-portal-effective')`
- use VM path `/home/openclaw/.openclaw/cache/mcp-portal-effective`
- merge every remote `requiredGatewayEgressHosts` entry missing from gateway/both `zone.egressHosts` into the lifecycle zone with `audience: "gateway"` before calling the OpenClaw lifecycle
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

External `/mcp-proxy` startup contract:

- `agent-vm-mcp-portal serve --config-dir <path>` loads authored MCP Portal configs, not managed OpenClaw effective configs.
- The `serve` command runs on the operator or proxy host and may resolve authored `source: "1password"` refs at process startup through `@agent-vm/secrets`.
- The `serve` command constructs a composite resolver from local env plus 1Password SDK/op CLI according to the same token-source rules as the controller. The external proxy process accepts explicit token-source env controls:
  - `AGENT_VM_MCP_PORTAL_OP_TOKEN_SOURCE=env|op-cli|keychain`
  - `AGENT_VM_MCP_PORTAL_OP_TOKEN_ENV_VAR=<env var>` for `env` token sources
  - `AGENT_VM_MCP_PORTAL_OP_TOKEN_REF=<op://...>` for `op-cli` token sources
  - `AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_SERVICE=<service>` and `AGENT_VM_MCP_PORTAL_OP_TOKEN_KEYCHAIN_ACCOUNT=<account>` for `keychain` token sources
  - when no explicit token source is configured, `OP_SERVICE_ACCOUNT_TOKEN` is used only if it is present; env-only configs must still work without a 1Password token
  - env-backed token bootstrap reads from the `env` snapshot supplied to `startPortalServer(...)` / `runAgentVmMcpPortal(...)`, not directly from ambient `process.env`
- The `serve` command must not implement its own raw `op read` subprocess path. It delegates 1Password resolution to `@agent-vm/secrets` so env allowlisting, token-source behavior, and redacted errors stay centralized.
- `externalAuth.masterKey` is resolved at serve startup through that resolver before HMAC bearer verification is enabled.
- The resolved master key must be canonical base64url without padding and must decode to at least 32 bytes. Startup fails closed for raw UTF-8 strings, padded base64, or short decoded keys.
- Security boundary: the `/mcp-proxy` host must have access to the configured secret source; gateway VMs still do not receive `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_TOKEN`, `OP_SESSION`, or other 1Password process credentials.
- Tests must cover authored config with a `source: "1password"` master key using a fake resolver, and authored config with `source: "environment"` using process env.
- `serve` fails closed unless both `mcpProxy` and `externalAuth.masterKey` are configured. It does not fall back to legacy `server.accessHeader`.

- [ ] **Step 1: Rename adapter directory**

Run:

```bash
git mv packages/mcp-portal/src/mcp-server packages/mcp-portal/src/mcp-proxy
rg -n "mcp-server|mcp-server/|src/mcp-server|@agent-vm/mcp-portal" packages docs
```

Replace import paths from `mcp-server` to `mcp-proxy`. The repo-wide grep is intentional: if a sibling package imports from `@agent-vm/mcp-portal` through a root barrel that re-exports server types, update that caller in the same change so build does not discover the rename late.

- [ ] **Step 2: Add HMAC bearer token helpers**

Create `auth/agent-bearer-token.ts`.

Token contract:

- bearer is base64url HMAC-SHA256
- message is `mcp-proxy:agent:<agentId>`
- key is `externalAuth.masterKey`
- `externalAuth.masterKey` is stored/resolved as canonical base64url and decoded before use
- master-key fingerprint is `sha256:<base64url sha256(masterKey)>`
- verification uses timing-safe comparison
- invalid tokens never reveal expected token or key material

HMAC purpose namespace:

- `mcp-proxy:agent:<agentId>`: external `/mcp-proxy` and CLI credential bearer
- `mcp-portal:approval:<...>`: external adapter approval token when an approval decision crosses a process/network boundary

Every future HMAC use must register a unique purpose prefix in this list before implementation. Never reuse an existing prefix with different semantics.

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
- core receives `source: "mcp-proxy-bearer"`
- MCP tool descriptors are built from `core.describeTools(scope)` after bearer verification

Remove shared access-header-only authorization entirely. `PortalHttpAppOptions.agentBearerAuth` is required, `authorizationHeaderName` is required by the resolved proxy config, and `serverAccess` is deleted rather than kept as a parallel auth path.

- [ ] **Step 4: Keep MCP protocol behavior**

`/mcp-proxy` still serves:

- `mcp_portal_list`
- `mcp_portal_search`
- `mcp_portal_describe`
- `mcp_portal_call`

but all tool handling delegates to `/core`.

The MCP server descriptor handshake must also delegate to `/core`; `/mcp-proxy` must not carry static descriptions for these tools except as a startup fallback that fails closed when scope is missing.

For every portal operation, `/mcp-proxy` must use `/core` streaming execution, not the collection helper directly. The MCP SDK request handler receives a `RequestHandlerExtra` object; use `extra.sendNotification(...)` for request-related notifications. For session-level logging outside a request handler, use `server.sendLoggingMessage(...)`.

Map `/core` events as follows:

- `progress` -> MCP `notifications/progress` via `extra.sendNotification({ method: "notifications/progress", ... })` when the inbound request has `_meta.progressToken`; otherwise send MCP `notifications/message` with `level: "info"` and the progress message as `data`.
- `upstream_notification` -> passthrough only for the explicit allowlist: `notifications/progress` and `notifications/message`. `notifications/progress` still requires the inbound progress token; when forwarding it, use the inbound progress token rather than blindly trusting upstream token params. Unsupported notification methods are dropped from the client stream and should be recorded as audit events when an audit sink is available.
- `partial_content` -> MCP progress/log notification, not final result content.
- no progress token -> do not fail the tool call. Use `notifications/message` for textual progress/partial summaries when the client supports logging. If the SDK reports logging/message notifications unsupported, drop that advisory progress event and continue to the final response; progress delivery is best-effort, not part of the tool result's success boundary.
- `completed` -> final MCP `tools/call` response.

This plan does not add a separate buffering policy schema. Streaming remains the execution primitive. If a future policy needs whole-result redaction, size enforcement, or schema validation, add an explicit config schema and tests in that change; do not hard-code buffering by tool name.

Approval fallback rule:

- External approval verification is strict by default. Do not allow a failed strict approval token to pass by re-verifying a smaller conservative call set.
- If policy-drift tolerance is ever needed, add an explicit config field such as `allowConservativeApprovalFallback: true` with tests and a documented security tradeoff. It is not part of this hard cutover.

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
  "authorizationHeaderName": "authorization",
  "authorizationHeaderValue": "Bearer <hmac bearer token>",
  "proxyUrl": "https://mcp-portal.example.com/agents/shravan/mcp",
  "masterKeyFingerprint": "sha256:..."
}
```

Tests must prove:

- CLI rejects unknown agents.
- CLI rejects credential bearer that does not verify for `agentId`.
- CLI creates `PortalAgentScope` with `source: "cli-operator"`.
- CLI help/catalog output is derived from `core.describeTools(scope)` after credential verification.
- CLI calls `/core` directly and does not require a running HTTP server.
- `write-credential` refuses to write unless `--master-key-fingerprint` exactly matches the resolved master-key fingerprint.
- `write-credential` refuses to write unless it can determine a concrete proxy URL from `mcpProxy` or an explicit operator flag.
- `write-credential --proxy-url <url>` writes that concrete URL after validating `http` or `https`. Use this when `serve --port` or an outer reverse proxy changes the reachable endpoint.
- `write-credential` writes configured `mcpProxy.auth.headerName` as `authorizationHeaderName` and the bearer as `authorizationHeaderValue`; it must not assume the header is always `authorization`.
- `write-credential` writes the credential file atomically with mode `0600`.
- `write-credential` stdout/stderr/log output never contains the bearer value.
- `write-credential` prints only redacted metadata: output path and non-secret status. It does not emit the bearer, the full credential JSON, or resolved secret values.
- `serve` starts `/mcp-proxy` through the same `agent-vm-mcp-portal` binary.
- `serve` installs `SIGINT`/`SIGTERM` shutdown handling and closes portal sessions, upstream clients, and the HTTP listener before exiting.
- `call` and `write-credential` use the same shared `@agent-vm/secrets` resolver path as `serve`; `source: "1password"` refs for `externalAuth.masterKey` or upstream provider secrets must work in all three CLI commands without a raw local `op read` implementation.

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
  --config-dir config/gateways/sunfam \
  --agent shravan \
  --proxy-url https://mcp-portal.example.com/agents/shravan/mcp \
  --out ~/.agent-vm/mcp-portal/shravan.json \
  --master-key-fingerprint sha256:...
```

The command must not support printing the bearer to stdout. If no `--out` path is supplied, it fails before deriving or logging the bearer.

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
- HTTP/SSE MCP provider URL hosts are reported by the materializer and added to effective gateway egress
- mediated-secret hosts are reported by the materializer and added to effective gateway egress

Validate must not require live 1Password access.

- [ ] **Step 2: Implement static validation**

Validation should:

- load authored configs
- validate agent/profile consistency
- call `planMcpPortalEffectiveConfig(...)`
- use a shape-only secret resolver that returns deterministic placeholders and never calls live 1Password
- avoid writing effective config files
- verify all effective secret refs become environment refs
- verify required provider and mediation egress hosts appear in the effective gateway egress plan
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
- required provider or mediation egress host is missing from gateway egress

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
- required provider egress hosts are present before startup succeeds
- generated effective OpenClaw config does not contain `mcp.servers.mcp_portal_`
- `tools.effective` or `/tools/invoke` can see the four native portal tools for the smoke session
- external MCP/PI-harness access is covered by the `/mcp-proxy` integration test with HMAC bearer auth
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

This test proves external MCP and PI-harness access without mixing it into OpenClaw gateway smoke.

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
- `/mcp-proxy` is for external MCP clients, PI harness use, and standalone deployments.
- `agent-vm-mcp-portal` is the only public MCP Portal CLI; `agent-vm-mcp-portal serve` starts `/mcp-proxy`.
- `/cli` is operator direct-to-core for local portal operations.
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
rg -n "mcp_portal_.*__|mcp-portal-subprocess|portal subprocess|agent-vm-mcp-portal-server|MCP_PORTAL_SERVER_SECRET|serverAccess|requireLegacyServerConfig|OP_SERVICE_ACCOUNT_TOKEN|OP_CONNECT_TOKEN|spawn op|source: \"1password\"" packages --glob '!**/*.test.ts'
rg -n "from '@agent-vm/mcp-portal'|mcp-proxy|hono" packages/openclaw-mcp-portal-plugin/src packages/mcp-portal/src/core --glob '!**/*.test.ts'
```

Expected:

- no unrelated files changed
- no old per-agent portal server names remain in managed OpenClaw code
- no subprocess supervisor remains in the OpenClaw adapter path
- no legacy shared-header proxy auth remains
- no `OP_*` forwarding remains
- no OpenClaw plugin or `/core` import path pulls in Hono or `/mcp-proxy`
- tests may contain old `server.accessHeader`, `MCP_PORTAL_SERVER_SECRET`, or `18790` literals only as explicit rejection fixtures
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
