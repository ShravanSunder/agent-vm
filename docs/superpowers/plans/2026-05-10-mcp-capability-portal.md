# MCP Capability Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not run git commit, merge, rebase,
> tag, or push commands unless the user explicitly asks for git writes.

**Goal:** Build a managed, TypeScript-first OpenClaw MCP capability portal that
turns per-agent MCP server access into a linked progressive-disclosure catalog,
schema/code artifacts, and safe gateway-owned execution.

**Architecture:** The OpenClaw gateway is the MCP client and owns upstream MCP
auth, headers, stdio env, transport sessions, and per-agent catalog caches. The
agent sees only portal tools and compact prompt context; the Tool VM gets
TypeScript/Zod catalog helpers in its base image but never receives raw MCP auth
or direct server credentials. MCP JSON Schema is the canonical wire/catalog
format; Zod schemas and TypeScript helpers are derived artifacts for agent code
composition.

**Tech Stack:** TypeScript, Node 24, pnpm, OpenClaw plugin
`api.registerTool`/`api.registerHook`, MCP TypeScript SDK `Client` transports,
Zod 4.4.x JSON Schema conversion/metadata, Vitest, OXC/Oxfmt, managed
OpenClaw gateway and Tool VM Dockerfiles.

---

## Current Evidence To Preserve

- OpenClaw plugin tools are registered with `api.registerTool(...)`.
- OpenClaw hooks include `before_tool_call`, `before_prompt_build`, and
  `agent_turn_prepare`; prompt hooks can inject compact portal context, while
  `before_tool_call` can return `requireApproval`.
- OpenClaw `before_tool_call` context carries `agentId`, `sessionKey`,
  `sessionId`, and `runId`; portal caches must be keyed by agent/session where
  those values are available and must not be a global cross-agent cache.
- OpenClaw tool handlers receive `toolCallId` but do not reliably receive full
  agent/session identity directly. The portal must bridge tool calls to
  `before_tool_call` context by `toolCallId` before choosing a per-agent view.
- OpenClaw already supports `mcp.servers`; the portal must read that registry
  and must not introduce a second plugin-owned MCP server surface.
- MCP TypeScript SDK `Client.listTools()` returns `tools` plus `nextCursor`;
  the portal must page until `nextCursor` is absent.
- MCP tool contracts are JSON Schema: `inputSchema`, optional `outputSchema`,
  annotations, execution metadata, and `_meta`. Keep JSON Schema canonical.
- Zod 4 supports `z.toJSONSchema()` and experimental `z.fromJSONSchema()`.
  Use this to derive local Tool VM validators/helpers, not as the MCP wire
  format.
- For remote SSE MCP servers, headers must apply to both the initial SSE stream
  request and recurring POST requests. `requestInit` alone is insufficient.
- Gateway images must not bake auth tokens, token env names, registry auth
  files, `.npmrc`, `.netrc`, or other credential material into image layers.

## Non-Goals

- Do not register every upstream MCP tool directly as a model-visible tool.
  The visible model surface is the small portal tool set.
- Do not implement arbitrary portal-hosted JavaScript execution.
- Do not put upstream MCP auth headers or stdio env secrets into Tool VMs.
- Do not share MCP client sessions or capability caches across agents.
- Do not replace OpenClaw's native MCP support; this is a progressive
  disclosure layer over configured OpenClaw MCP servers.
- Do not make `z.fromJSONSchema()` required for correctness. It is a derived
  TypeScript convenience and remains optional because the API is experimental.

## File Structure

Create a shared TypeScript package:

- `packages/mcp-capability-portal-core/package.json`
  - Shared catalog, search, schema, and Tool VM helper package.
- `packages/mcp-capability-portal-core/tsconfig.json`
- `packages/mcp-capability-portal-core/tsconfig.build.json`
- `packages/mcp-capability-portal-core/tsdown.config.ts`
- `packages/mcp-capability-portal-core/src/index.ts`
- `packages/mcp-capability-portal-core/src/json-schema.ts`
  - JSON-compatible schema/value types used by catalog objects.
- `packages/mcp-capability-portal-core/src/capability-id.ts`
  - Encodes/decodes stable capability IDs without `:` ambiguity.
- `packages/mcp-capability-portal-core/src/catalog-types.ts`
  - Zod 4 schemas and TypeScript types for namespaces, capabilities,
    relationships, schema artifacts, and catalog snapshots.
- `packages/mcp-capability-portal-core/src/capability-graph.ts`
  - Builds namespace, schema, skill, and workflow links.
- `packages/mcp-capability-portal-core/src/search-index.ts`
  - Progressive search across capability metadata, schema fields, and links.
- `packages/mcp-capability-portal-core/src/tool-vm/zod-schema-loader.ts`
  - Optional `z.fromJSONSchema()` helper for Tool VM code.
- `packages/mcp-capability-portal-core/src/tool-vm/typescript-artifact.ts`
  - Emits TypeScript catalog helper source from selected schema artifacts.
- `packages/mcp-capability-portal-core/src/bin/agent-vm-mcp-portal.ts`
  - Tool VM CLI for validating catalogs and writing TypeScript helpers.

Create a managed OpenClaw plugin package:

- `packages/openclaw-mcp-capability-portal-plugin/package.json`
- `packages/openclaw-mcp-capability-portal-plugin/tsconfig.json`
- `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json`
- `packages/openclaw-mcp-capability-portal-plugin/tsdown.config.ts`
- `packages/openclaw-mcp-capability-portal-plugin/openclaw.plugin.json`
- `packages/openclaw-mcp-capability-portal-plugin/src/index.ts`
- `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-plugin-api.ts`
  - Narrow local OpenClaw API types used by this plugin.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts`
  - Portal plugin config and per-agent exposure policy.
- `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts`
  - Normalizes OpenClaw `api.config.mcp.servers`.
- `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts`
  - Creates MCP clients and transports with correct stdio/HTTP/SSE behavior.
- `packages/openclaw-mcp-capability-portal-plugin/src/mcp-tool-catalog-loader.ts`
  - Calls `listTools()` with pagination and converts tools to catalog nodes.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-session-store.ts`
  - Per-agent/session TTL caches for clients and linked catalog snapshots.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-tool-context-bridge.ts`
  - Captures OpenClaw hook context by `toolCallId` so portal tools can resolve
    the active `agentId`, `sessionKey`, `sessionId`, and `runId`.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-prompt-context.ts`
  - Injects compact progressive-disclosure guidance into agent context.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts`
  - Registers `mcp_portal_list`, `mcp_portal_search`,
    `mcp_portal_describe`, `mcp_portal_execute`, and
    `mcp_portal_materialize`.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts`
  - Applies approval policy to execution and materialization.
- `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts`
  - Wires config, runtime, prompt hooks, tools, and approval hook.

Modify agent-vm integration:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
  - Install/symlink the managed portal plugin into OpenClaw gateway images.
  - Install the Tool VM TypeScript helper package into managed Tool VM images.
- `packages/agent-vm/package.json`
  - Depends on both portal packages so managed image generation can resolve
    their installed package metadata.
- `tsconfig.base.json`
  - Adds path aliases for both portal packages.
- `packages/agent-vm/tsconfig.build.json`
  - Adds build-time paths for both portal packages.
- `packages/agent-vm/src/cli/init-command.ts`
  - Generated OpenClaw config loads/allows the portal plugin and allows portal
    tools.
- `packages/agent-vm/src/cli/build-command.test.ts`
  - Managed Dockerfile tests cover gateway plugin and Tool VM helper installs.
- `packages/agent-vm/src/cli/init-command.test.ts`
  - Generated OpenClaw config contains portal plugin defaults.
- `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
  - Validates portal plugin load path, entry, and tool allowlist.
- `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
  - Covers missing/broken portal deployment diagnostics.
- `docker/base-images/tool-vm/Dockerfile`
  - Prepare pnpm global install support for the Tool VM helper package.
- `docs/subsystems/mcp-capability-portal.md`
- `docs/architecture/openclaw-gateway.md`
- `docs/subsystems/secrets-and-credentials.md`
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.test.ts`

---

## Portal Tool Contract

The agent receives a small, stable tool surface:

- `mcp_portal_list`
  - Progressive overview of namespaces, MCP servers, skill groups, counts, and
    representative capabilities.
  - Does not return every schema.
- `mcp_portal_search`
  - Search capability names, descriptions, namespaces, skill text, input schema
    property names/descriptions, output schema property names/descriptions, and
    relationships.
  - Returns compact ranked hits.
- `mcp_portal_describe`
  - Batch exact capability IDs.
  - Returns canonical MCP JSON Schema, annotations, execution metadata,
    relationships, examples, and Tool VM code-generation hints.
- `mcp_portal_execute`
  - Executes one exact MCP tool capability by ID through the gateway MCP client.
- `mcp_portal_materialize`
  - Returns TypeScript helper source for selected capabilities.
  - It does not execute arbitrary code and does not write files by itself.

The Tool VM base image contains `agent-vm-mcp-portal`, a TypeScript/Zod helper
CLI that can validate catalog JSON and write local helper files when the agent
chooses to materialize portal output into its workspace.

## Capability ID Rules

Do not use ambiguous raw IDs like `mcp:${serverId}:${toolName}`. Encode
components so server IDs and tool names can contain punctuation.

Use:

```text
mcp:<base64url(serverId)>:<base64url(toolName)>
skill:<base64url(skillName)>
```

Display fields must keep human-readable names separately:

```ts
{
	serverId: "linear",
	toolName: "create_issue",
	id: "mcp:bGluZWFy:Y3JlYXRlX2lzc3Vl"
}
```

---

### Task 1: Create Shared TypeScript Catalog Core

**Files:**
- Create: `packages/mcp-capability-portal-core/package.json`
- Create: `packages/mcp-capability-portal-core/tsconfig.json`
- Create: `packages/mcp-capability-portal-core/tsconfig.build.json`
- Create: `packages/mcp-capability-portal-core/tsdown.config.ts`
- Create: `packages/mcp-capability-portal-core/src/index.ts`
- Create: `packages/mcp-capability-portal-core/src/json-schema.ts`
- Create: `packages/mcp-capability-portal-core/src/capability-id.ts`
- Create: `packages/mcp-capability-portal-core/src/catalog-types.ts`
- Create: `packages/mcp-capability-portal-core/src/*.test.ts`

- [ ] **Step 1: Add package metadata**

Create package metadata matching existing repo package conventions:

```json
{
	"name": "@agent-vm/mcp-capability-portal-core",
	"version": "0.0.58",
	"description": "Shared TypeScript catalog, schema, and Tool VM helpers for the agent-vm MCP capability portal.",
	"homepage": "https://github.com/ShravanSunder/agent-vm#readme",
	"bugs": {
		"url": "https://github.com/ShravanSunder/agent-vm/issues"
	},
	"license": "MIT",
	"author": "Shravan Sunder <ShravanSunder@users.noreply.github.com>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ShravanSunder/agent-vm.git",
		"directory": "packages/mcp-capability-portal-core"
	},
	"files": ["dist"],
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"bin": {
		"agent-vm-mcp-portal": "./dist/bin/agent-vm-mcp-portal.js"
	},
	"publishConfig": {
		"access": "public"
	},
	"scripts": {
		"build": "tsdown",
		"prepack": "pnpm -C ../.. build",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"zod": "^4.4.3"
	}
}
```

- [ ] **Step 2: Add build config**

Use the same tsconfig shape as `openclaw-agent-vm-plugin`: rootDir, outDir,
declarations, declaration maps, source maps, and test exclusion.

- [ ] **Step 3: Define JSON-compatible schema types**

`json-schema.ts` must expose JSON value types and a conservative object-schema
type for MCP `inputSchema`/`outputSchema`.

Acceptance tests:

- A schema with `type: "object"`, `properties`, `required`, `$defs`, and `$ref`
  parses through the catalog Zod schema.
- A schema value containing a function is rejected because catalog artifacts are
  JSON-compatible only.

- [ ] **Step 4: Implement encoded capability IDs**

Acceptance tests:

- `encodeMcpCapabilityId("linear", "create_issue")` round-trips through
  `decodeCapabilityId`.
- IDs round-trip when server/tool names contain `:`, `/`, spaces, and `_`.
- `decodeCapabilityId("mcp:linear:create_issue")` rejects legacy ambiguous IDs.

- [ ] **Step 5: Define catalog Zod schemas**

Catalog schemas must include:

- namespaces
- capabilities
- schema artifacts
- relationships
- safety/approval hints
- code-generation hints
- catalog metadata with `agentId`, `generatedAt`, and `sourceHash`

Acceptance tests:

- A catalog containing one namespace, one MCP capability, input/output JSON
  Schema, annotations, and relationships parses successfully.
- Portal wrapper metadata containing raw transport config fields such as `env`,
  `headers`, or `authorization` is rejected.
- MCP `inputSchema` and `outputSchema` are preserved verbatim even when a real
  tool schema legitimately contains properties named `headers`,
  `authorization`, or `apiKey`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-capability-portal-core/src
```

Expected: PASS with all new core tests.

---

### Task 2: Build Linked Capability Search And Graph

**Files:**
- Create: `packages/mcp-capability-portal-core/src/capability-graph.ts`
- Create: `packages/mcp-capability-portal-core/src/search-index.ts`
- Create: `packages/mcp-capability-portal-core/src/capability-graph.test.ts`
- Create: `packages/mcp-capability-portal-core/src/search-index.test.ts`

- [ ] **Step 1: Build relationship graph**

Implement deterministic links:

- namespace links: same MCP server
- schema links: output field names matching input field names
- entity links: matching schema `title`, `$id`, or metadata entity name
- skill links: capability IDs referenced in skill metadata or matching skill
  tags
- safety links: read/write/destructive groupings

Acceptance tests:

- `search_issues` links to `get_issue` and `create_comment` when output and
  input schemas share `issueId`.
- Tools from different servers do not link through generic names like `id`
  unless a stronger entity/title match exists.
- Relationship output is stable-sorted by relation type and capability ID.

- [ ] **Step 2: Build progressive search**

Search must index:

- namespace name and description
- tool name, title, and description
- input schema property names and descriptions
- output schema property names and descriptions
- relationship target names
- skill title and description

Acceptance tests:

- Searching `linear issue comment` ranks a comment-writing tool above unrelated
  issue readers.
- Searching for an input property name returns tools that accept that property.
- Search results are compact and do not include full schemas.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-capability-portal-core/src/capability-graph.test.ts packages/mcp-capability-portal-core/src/search-index.test.ts
```

Expected: PASS.

---

### Task 3: Add Tool VM TypeScript/Zod Helper Package Surface

**Files:**
- Create: `packages/mcp-capability-portal-core/src/tool-vm/zod-schema-loader.ts`
- Create: `packages/mcp-capability-portal-core/src/tool-vm/typescript-artifact.ts`
- Create: `packages/mcp-capability-portal-core/src/bin/agent-vm-mcp-portal.ts`
- Create: `packages/mcp-capability-portal-core/src/tool-vm/*.test.ts`
- Create: `packages/mcp-capability-portal-core/src/bin/*.test.ts`

- [ ] **Step 1: Add optional Zod reconstruction helper**

`zod-schema-loader.ts` must:

- accept canonical JSON Schema
- call `z.fromJSONSchema(...)` when available
- return a typed success/failure result
- report that conversion is experimental
- never mutate the original schema object

Acceptance tests:

- A simple object JSON Schema converts to a Zod schema that parses valid input.
- Unsupported/cyclic schemas return a failure result rather than throwing out of
  the public helper.

- [ ] **Step 2: Add TypeScript materializer**

`typescript-artifact.ts` must emit a TypeScript module that contains:

- a catalog constant
- selected capability constants
- `createInputValidator(capabilityId)` using Zod 4 `fromJSONSchema`
- type-safe helper names derived from stable capability IDs
- a top-level comment that states JSON Schema is canonical and Zod is derived

Acceptance tests:

- Generated source contains no auth headers/env values.
- Generated source references `z.fromJSONSchema`.
- Generated names are deterministic for the same catalog.

- [ ] **Step 3: Add CLI**

`agent-vm-mcp-portal` commands:

```text
agent-vm-mcp-portal validate <catalog.json>
agent-vm-mcp-portal materialize <catalog.json> --out <directory>
```

Acceptance tests:

- `validate` exits 0 for a valid catalog.
- `validate` exits non-zero for a catalog with a forbidden secret-shaped field.
- `materialize` writes `catalog.ts` and `catalog.json` under the output
  directory.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-capability-portal-core/src/tool-vm packages/mcp-capability-portal-core/src/bin
```

Expected: PASS.

---

### Task 4: Scaffold Managed OpenClaw Portal Plugin

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/package.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsconfig.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsdown.config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/openclaw.plugin.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/index.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-plugin-api.ts`
- Modify: `packages/agent-vm/package.json`
- Modify: `tsconfig.base.json`
- Modify: `packages/agent-vm/tsconfig.build.json`

- [ ] **Step 1: Add package metadata**

Use dependencies:

```json
{
	"@agent-vm/mcp-capability-portal-core": "workspace:*",
	"@modelcontextprotocol/sdk": "^1.29.0",
	"zod": "^4.4.3"
}
```

- [ ] **Step 2: Add OpenClaw manifest**

`openclaw.plugin.json` must declare:

```json
{
	"id": "mcp-capability-portal",
	"name": "MCP Capability Portal",
	"description": "Gateway-owned linked MCP capability catalog with progressive disclosure and safe execution.",
	"activation": { "onStartup": true },
	"contracts": {
		"tools": [
			"mcp_portal_list",
			"mcp_portal_search",
			"mcp_portal_describe",
			"mcp_portal_execute",
			"mcp_portal_materialize"
		]
	}
}
```

The config schema must allow portal metadata only: enabled server IDs, skill
directories, prompt context settings, cache TTL, and approval policy. It must
reject `mcpServers` because OpenClaw `mcp.servers` is the source of truth.

- [ ] **Step 3: Add local OpenClaw API types**

Type the exact API surface this plugin uses:

- `config`
- `pluginConfig`
- `logger`
- `registerTool`
- `registerHook`
- optional `registerRuntimeLifecycle`

Acceptance tests:

- Plugin registration throws a useful error if `registerTool` is missing.
- Plugin registration throws a useful error if `registerHook` is missing.

- [ ] **Step 4: Wire workspace package resolution**

Update repo package wiring:

- `packages/agent-vm/package.json` depends on
  `@agent-vm/mcp-capability-portal-core` and
  `@agent-vm/openclaw-mcp-capability-portal-plugin` with `workspace:*`.
- `tsconfig.base.json` adds path aliases for both packages.
- `packages/agent-vm/tsconfig.build.json` adds build-time path aliases for both
  packages.
- `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json` maps
  `@agent-vm/mcp-capability-portal-core` to the core package declarations.

Acceptance tests:

- `pnpm --filter @agent-vm/openclaw-mcp-capability-portal-plugin typecheck`
  resolves the core package import.
- `pnpm --filter @agent-vm/agent-vm typecheck` resolves both portal packages
  for managed image package-spec discovery.

---

### Task 5: Normalize OpenClaw MCP Servers And Connect With Proper Protocol

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts`
- Create: matching `*.test.ts`

- [ ] **Step 1: Parse portal config**

Config defaults:

- `enabledServerIds: []` means all configured OpenClaw MCP servers.
- `enabledServerIdsByAgent: {}` lets specific agents receive narrower or
  different namespace views.
- `hiddenCapabilityIdsByAgent: {}` hides specific capabilities for specific
  agents after namespace selection.
- `skillsDirs: []`
- `promptContext.enabled: true`
- `promptContext.maxNamespaces: 12`
- `cache.catalogTtlMs: 60_000`
- `approval.alwaysAskCapabilityIds: []`
- `approval.writeCapabilityIds: []`
- `approval.annotationPolicy: "destructive-requires-approval"`

Acceptance tests:

- Empty config produces defaults.
- `mcpServers` in plugin config is rejected.
- Invalid approval policy is rejected.
- Agent-specific exposure config can make Agent A see `linear` while Agent B
  sees `readwise`.

- [ ] **Step 2: Normalize OpenClaw MCP server records**

Mirror OpenClaw semantics for:

- stdio: `command`, `args`, `env`, `cwd`, `workingDirectory`
- remote: `url`, `transport`, `type`, `headers`
- `connectionTimeoutMs`
- env sanitization
- header value coercion to strings
- skipping malformed servers with redacted diagnostics

Implementation preference: import OpenClaw's public MCP normalization/runtime
helpers if OpenClaw exposes them. If no public helper exists, keep the adapter
small and add conformance fixtures copied from the installed OpenClaw version
used by `managed-images.json`.

Acceptance tests:

- stdio and streamable-http normalize correctly.
- SSE normalizes headers correctly.
- `LD_PRELOAD` and other dangerous env keys are dropped from stdio env.
- malformed servers are skipped without exposing raw header/env values.
- `type: "sse"` and `transport: "sse"` resolve the same way OpenClaw resolves
  them.
- config-change disposal closes clients and rebuilds normalized server records.

- [ ] **Step 3: Implement MCP client runtime**

Runtime must:

- use `StdioClientTransport` for stdio
- use `StreamableHTTPClientTransport` for streamable-http
- use `SSEClientTransport` for SSE
- pass SSE headers to both `requestInit` and `eventSourceInit`
- connect with timeout
- call `listTools()` until `nextCursor` is absent
- call `callTool({ name, arguments })`
- cache clients per agent/session/server
- evict failed or closed clients deterministically
- close clients on runtime lifecycle stop

Acceptance tests:

- paginated `listTools` returns all pages.
- SSE transport receives both request and initial stream header handling.
- failed client creation does not poison the cache forever.
- concurrent calls to the same server serialize.
- calls for different agents do not share clients.

---

### Task 6: Build Per-Agent Linked Catalogs And Prompt Context

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/mcp-tool-catalog-loader.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-session-store.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-tool-context-bridge.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-prompt-context.ts`
- Create: matching `*.test.ts`

- [ ] **Step 1: Convert MCP tools to catalog nodes**

Catalog conversion must preserve:

- MCP server ID
- safe server display name
- MCP tool name
- title
- description
- inputSchema
- outputSchema
- annotations
- execution metadata
- scrubbed `_meta` only when explicitly safe

Acceptance tests:

- input and output schemas are preserved exactly.
- `annotations.destructiveHint` and `readOnlyHint` are preserved.
- raw headers/env values never appear in catalog JSON.

- [ ] **Step 2: Add tool-call context bridge**

`portal-tool-context-bridge.ts` must:

- record `agentId`, `sessionKey`, `sessionId`, `runId`, and `toolCallId` from
  OpenClaw `before_tool_call` context
- resolve the active portal context inside tool handlers from `toolCallId`
- fall back to explicit `"unknown-agent"`/`"unknown-session"` only when
  OpenClaw truly provides no context
- clean context on `after_tool_call`, TTL expiry, and runtime lifecycle stop

Acceptance tests:

- `toolCallId` recorded in `before_tool_call` resolves inside a portal tool
  execute handler.
- Two concurrent tool calls for two agents resolve different agent IDs.
- Context entries are removed after `after_tool_call`.

- [ ] **Step 3: Add per-agent/session store**

Cache key shape:

```text
agentId || "unknown-agent"
sessionKey || sessionId || "unknown-session"
serverId
```

Acceptance tests:

- Agent A and Agent B get separate catalog snapshots.
- Agent-specific exposure policy makes Agent A and Agent B see different
  namespaces from the same gateway config.
- Session cache expires after TTL.
- Cache clear closes clients for that agent/session only.

- [ ] **Step 4: Inject compact prompt context**

Register a prompt hook using `before_prompt_build` or `agent_turn_prepare`.
The injected context must be compact and stable:

```text
MCP capability portal is available.
Use mcp_portal_list for namespaces, mcp_portal_search for discovery,
mcp_portal_describe for batch schemas/code hints, and mcp_portal_execute
for exact execution. Gateway owns MCP auth. Tool VM helpers are available
through agent-vm-mcp-portal.
Namespaces: linear(18 tools), readwise(9 tools), calendar(6 tools)
```

Acceptance tests:

- Prompt context appears when enabled.
- Prompt context omits raw schemas and secrets.
- Prompt context degrades gracefully when no MCP servers are configured.

---

### Task 7: Register Progressive Disclosure Portal Tools

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts`

- [ ] **Step 1: Register `mcp_portal_list`**

Input:

```json
{
	"namespace": "optional namespace filter",
	"limit": 20,
	"cursor": "optional cursor"
}
```

Output:

- namespaces
- counts
- representative capability IDs
- next cursor

Acceptance tests:

- list returns namespace summaries without full schemas.
- pagination is stable.

- [ ] **Step 2: Register `mcp_portal_search`**

Input:

```json
{
	"query": "linear issue comment",
	"kind": "optional mcp-tool or skill",
	"limit": 10
}
```

Output:

- compact ranked hits
- relationship hints
- schema field matches
- no full schemas

Acceptance tests:

- search finds matches through schema property names.
- search results omit full schema bodies.

- [ ] **Step 3: Register `mcp_portal_describe`**

Input:

```json
{
	"ids": ["mcp:..."],
	"includeSchemas": true,
	"includeRelated": true,
	"includeMaterializationHints": true
}
```

Output:

- full canonical JSON Schemas
- output schemas
- annotations
- related capabilities
- TypeScript/Zod materialization hints

Acceptance tests:

- describe accepts multiple IDs.
- describe returns input/output schemas and annotations.
- describe rejects unknown IDs with a clear, secret-free error.

- [ ] **Step 4: Register `mcp_portal_materialize`**

Input:

```json
{
	"ids": ["mcp:..."],
	"format": "typescript-zod",
	"moduleName": "linearPortal"
}
```

Output:

- generated TypeScript source as text
- catalog JSON fragment
- instructions for using Tool VM `agent-vm-mcp-portal`

Acceptance tests:

- materialize emits deterministic TypeScript source.
- materialize does not write files.
- materialize output contains no raw headers/env values.

- [ ] **Step 5: Register `mcp_portal_execute`**

Input:

```json
{
	"id": "mcp:...",
	"arguments": {}
}
```

Acceptance tests:

- execute calls MCP SDK `callTool({ name, arguments })`.
- execute only allows MCP tool capabilities, not skill capabilities.
- execute returns MCP result content and structured content unchanged except
  for secret redaction in thrown errors.

---

### Task 8: Approval, Redaction, And Safety Policy

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/redaction.ts`
- Create: matching `*.test.ts`

- [ ] **Step 1: Implement redaction**

Redact:

- authorization headers
- token-like query params
- env values
- `*_TOKEN`, `*_KEY`, `*_SECRET`, `PASSWORD`
- bearer/basic auth strings

Acceptance tests:

- Errors containing `Bearer secret-value` are reported without the secret.
- Search/list/describe/materialize outputs never contain configured env/header
  values.
- A legitimate MCP tool schema with input properties named `headers`,
  `authorization`, or `apiKey` remains intact in `mcp_portal_describe`.

- [ ] **Step 2: Implement approval hook**

Use `api.registerHook("before_tool_call", handler, { priority: 50 })`.
The hook must also write the active tool-call context into
`portal-tool-context-bridge.ts` before any approval decision returns.

Approval rules:

- `alwaysAskCapabilityIds` always require approval.
- `writeCapabilityIds` always require critical approval.
- `annotationPolicy: "destructive-requires-approval"` requires approval when
  the described capability has `annotations.destructiveHint === true`.
- `mcp_portal_materialize` does not require approval by default because it only
  returns code artifacts; it must be configurable through `alwaysAskCapabilityIds`.

Acceptance tests:

- read-only execute does not require approval by default.
- destructive annotated execute requires approval.
- configured write capability returns critical approval.
- search/list/describe do not require approval.

---

### Task 9: Wire Plugin Registration

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts`

- [ ] **Step 1: Register all portal systems**

Registration must:

- parse portal config
- normalize OpenClaw `mcp.servers`
- create per-agent/session store
- create tool-call context bridge
- register prompt context hook
- register portal tools
- register approval hook and after-tool cleanup hook
- register runtime lifecycle cleanup when OpenClaw provides it

Acceptance tests:

- all five tools are registered as optional tools.
- `before_tool_call` hook is registered.
- `after_tool_call` hook is registered for context cleanup.
- prompt context hook is registered.
- runtime lifecycle cleanup is registered when available.
- registration fails if OpenClaw MCP servers are provided in plugin config
  instead of `api.config.mcp.servers`.

---

### Task 10: Install Portal Into Managed Gateway And Tool VM Images

**Files:**
- Modify: `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- Modify: `packages/agent-vm/src/cli/build-command.test.ts`
- Modify: `docker/base-images/tool-vm/Dockerfile`

- [ ] **Step 1: Managed OpenClaw gateway image installs portal plugin**

Extend managed Dockerfile generation:

- resolve `@agent-vm/openclaw-mcp-capability-portal-plugin` package spec from
  installed package metadata, same as the gondolin plugin
- install it globally in OpenClaw gateway images
- symlink its `dist` directory to:
  `/home/openclaw/.openclaw/extensions/mcp-capability-portal`
- include the package in the generated Dockerfile plan

Acceptance tests:

- generated OpenClaw gateway Dockerfile installs both gondolin and portal
  packages.
- generated Dockerfile symlinks both extension directories.
- overlay `extraOpenClawPackages` cannot override the managed portal plugin
  package by accident.

- [ ] **Step 2: Managed Tool VM image installs TypeScript helper**

Update Tool VM base/Dockerfile generation so managed Tool VM images have:

- pnpm available for global package installation
- `@agent-vm/mcp-capability-portal-core` installed globally
- `agent-vm-mcp-portal` available on PATH
- no auth config, no MCP server config, no token names

Acceptance tests:

- generated Tool VM Dockerfile contains the portal helper package install.
- generated Tool VM Dockerfile does not contain `TOKEN`, `Authorization`,
  `.npmrc`, `.netrc`, or `_authToken`.

---

### Task 11: Update Init Defaults And Deployment Manuals

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Create: `docs/subsystems/mcp-capability-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Generated OpenClaw config loads portal plugin**

Default OpenClaw config must:

- include both extension load paths:
  - `/home/openclaw/.openclaw/extensions/gondolin`
  - `/home/openclaw/.openclaw/extensions/mcp-capability-portal`
- allow `gondolin`, `memory-core`, and `mcp-capability-portal`
- enable `mcp-capability-portal`
- allow the five portal tools
- keep `mcp.servers` empty unless user config adds servers

Acceptance tests:

- `agent-vm init` output contains the portal plugin entry.
- generated config allows portal tools.
- generated config does not add fake MCP servers or secret placeholders.

- [ ] **Step 2: Add deployment doctor coverage**

Doctor must validate:

- portal extension load path exists in generated/configured OpenClaw config
- portal plugin is allowed
- portal plugin entry is enabled when managed portal tools are allowed
- the five portal tools are in `tools.allow`
- missing/broken portal config reports redacted diagnostics

Acceptance tests:

- valid generated OpenClaw config passes portal doctor checks.
- missing portal extension path produces an actionable doctor warning.
- tool allowlist drift is reported.
- diagnostics do not include raw MCP header/env values.

- [ ] **Step 3: Document the model**

Docs must state:

- Each agent/gateway gets its own portal view and cache.
- Gateway owns MCP auth and connections.
- Tool VM receives TypeScript/Zod helpers only.
- MCP JSON Schema is canonical.
- Zod reconstruction is optional and experimental.
- Portal materialization returns code artifacts but does not execute code.
- `gondolin-secret-source` remains separate and owns Tool VM HTTP-mediated
  secrets.

- [ ] **Step 4: Regenerate manuals**

Run:

```bash
pnpm --filter @agent-vm/agent-vm build
pnpm agent-vm manual update
```

Expected: generated manuals mention progressive disclosure, portal tools,
gateway-owned MCP auth, and Tool VM helper availability.

---

### Task 12: Verification

**Files:**
- No planned source edits except fixes found by verification.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm vitest run packages/mcp-capability-portal-core/src packages/openclaw-mcp-capability-portal-plugin/src
```

Expected: PASS.

- [ ] **Step 2: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS with exit code 0.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS, including the two new portal packages.

- [ ] **Step 4: Run full checks**

Run:

```bash
pnpm check
```

Expected: PASS, including package-version sync, Zod version check,
type-aware lint, format check, and typecheck.

- [ ] **Step 5: Run managed-image smoke checks**

Create a temporary deployment directory, run `agent-vm init`, build generated
managed Dockerfiles, and inspect them.

Expected:

- OpenClaw gateway Dockerfile installs and symlinks the portal plugin.
- Tool VM Dockerfile installs the TypeScript helper CLI.
- Generated OpenClaw config loads/allows the portal plugin and tools.
- No generated Dockerfile or config contains raw auth header values or token
  literals except user-authored MCP server config supplied by the operator.

- [ ] **Step 6: Run portal runtime smoke checks**

Add a smoke test that boots the plugin against controlled MCP test servers:

- one paginated stdio MCP server
- one remote SSE or streamable-http MCP server with auth headers
- two OpenClaw agents with different portal exposure policies

Expected:

- `mcp_portal_list` shows only each agent's allowed namespaces.
- `mcp_portal_search` finds tools through schema field names.
- `mcp_portal_describe` returns full input/output schemas and annotations.
- `mcp_portal_materialize` returns deterministic TypeScript/Zod helper source.
- `mcp_portal_execute` calls the selected MCP tool.
- Agent A cannot see or execute Agent B-only capabilities.
- SSE/HTTP auth headers are used by the gateway and never appear in portal
  outputs, Tool VM helper artifacts, logs, or thrown errors.

---

## Self-Review

- Spec coverage: The plan covers managed built-in plugin installation, per-agent
  gateway scoping, progressive disclosure, linked capability catalog, MCP
  schema preservation, TypeScript/Zod Tool VM helpers, code-artifact
  materialization, approval, redaction, docs, and verification.
- Placeholder scan: The plan avoids placeholder implementation steps and names
  exact files, tools, commands, and acceptance tests.
- Type consistency: `PortalCatalog`, encoded capability IDs,
  `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`,
  `mcp_portal_execute`, and `mcp_portal_materialize` are used consistently.
