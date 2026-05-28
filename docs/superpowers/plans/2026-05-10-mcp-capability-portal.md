# MCP Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not run git commit, merge, rebase,
> tag, or push commands unless the user explicitly asks for git writes.

**Goal:** Build a managed, TypeScript-first MCP Portal that gives each agent a
scoped MCP server for progressive discovery, schema inspection, validated calls,
and composition over upstream MCP servers.

**Architecture:** MCP Portal is an MCP server on the agent-facing side and an
MCP client aggregator on the upstream side. The OpenClaw gateway/plugin manages a
separate portal binding per agent, where each binding has its own allowed
namespace policy, upstream MCP clients, catalog, and search index. The agent does
not pass `agentId`; the portal server is already bound to that agent before any
portal tool call is possible.

**Tech Stack:** TypeScript, Node 24, pnpm, Hono-hosted MCP Streamable HTTP for
the agent-facing portal, MCP TypeScript SDK server/client transports, OpenClaw
plugin lifecycle/prompt hooks, Zod 4.4.x JSON Schema conversion/metadata, Vitest,
OXC/Oxfmt, managed OpenClaw gateway and Tool VM Dockerfiles.

---

## Current Evidence To Preserve

- Existing repo code already hosts a local MCP server with
  `@modelcontextprotocol/sdk/server/index.js`,
  `WebStandardStreamableHTTPServerTransport`, and Hono in
  `packages/agent-vm-worker/src/work-executor/local-tool-mcp-server.ts`.
- The MCP TypeScript SDK supports server-side tool exposure and client-side
  upstream calls. Use MCP server APIs for the front side and `Client.listTools()`
  / `Client.callTool()` for upstream MCP servers.
- OpenClaw-managed MCP server definitions live under `mcp.servers`; those remain
  the source of truth for operator-configured upstream MCP servers.
- OpenClaw has MCP bridge/configuration surfaces for agent runtimes. Task 0
  proved the safe pinned-version shape: generate one `mcp.servers` entry per
  portal binding and restrict each agent with `agents.list[].tools.allow` to the
  four materialized portal tools from its own server entry. The portal must
  remain an agent-facing MCP server, not direct model-visible OpenClaw plugin
  tools.
- MCP Streamable HTTP is the current remote HTTP transport. HTTP+SSE remains a
  legacy remote transport that the upstream client runtime must support for
  compatibility. Stdio remains supported for local/gateway-owned MCP servers.
- OpenClaw prompt hooks such as `before_prompt_build` or `agent_turn_prepare`
  can inject compact portal context. The generated plugin entry must keep
  `hooks.allowPromptInjection: true`; OpenClaw can block prompt-mutating hooks
  when that permission is disabled.
- MCP tool contracts are JSON Schema: `inputSchema`, optional `outputSchema`,
  annotations, execution metadata, and `_meta`. Keep JSON Schema canonical.
- MCP TypeScript SDK `Client.listTools()` returns `tools` plus `nextCursor`; the
  portal must page until `nextCursor` is absent.
- Zod 4 supports `z.toJSONSchema()` and experimental `z.fromJSONSchema()`. Use
  this to derive validators and Tool VM helpers, not as the MCP wire format.
- For remote SSE MCP servers, headers must apply to both the initial SSE stream
  request and recurring POST requests. With the current MCP TypeScript SDK,
  gateway-owned auth headers belong in `requestInit.headers`; the SDK folds
  those headers into both the EventSource GET and recurring POST sends while
  preserving caller-provided `eventSourceInit`.
- Gateway images must not bake auth tokens, token env names, registry auth files,
  `.npmrc`, `.netrc`, or other credential material into image layers.

## Non-Goals

- Do not register every upstream MCP tool directly as a model-visible tool.
  The agent-facing MCP Portal server exposes only the small portal tool set.
- Do not add `agentId`, `sessionId`, `runId`, `authProfile`, headers, env, or
  upstream server config to model-visible MCP tool inputs.
- Do not build one global catalog/index and post-filter search results. Denied
  namespaces/tools must never enter the agent-scoped catalog or search index.
- Do not put upstream MCP auth headers or stdio env secrets into Tool VMs.
- Do not share upstream MCP client sessions, catalog snapshots, search indexes,
  or mutable call state across agents.
- Do not replace operator-authored upstream MCP servers. The portal is a managed
  front-door server over configured upstream MCP servers.
- Do not ship a separate `mcp_portal_materialize` tool in v1. TypeScript/Zod
  helper material is returned by `mcp_portal_describe` when requested.
- Do not implement general PII minimization or semantic response filtering in
  v1. Credential redaction is required; broader response-content policy gets a
  reserved middleware seam and explicit docs.
- Do not add model-visible `commitToken`, approval token, or draft/commit auth
  fields in v1. Future intent verification must remain server-side.

## Hard Prerequisites

Task 0 must run before implementation tasks that wire the OpenClaw plugin. The
corrected architecture depends on a concrete OpenClaw path for giving each agent
one scoped MCP Portal server binding. If the pinned OpenClaw version cannot
support that path, stop and reconverge instead of quietly falling back to a
global portal server.

The acceptable binding mechanisms are:

- Preferred: one Hono-hosted MCP Streamable HTTP endpoint per portal binding,
  owned by the OpenClaw gateway process. Trusted gateway/plugin code writes one
  OpenClaw `mcp.servers.<portalServerName>` entry per agent binding and adds the
  four materialized names
  `<portalServerName>__mcp_portal_list/search/describe/call` to that agent's
  `agents.list[].tools.allow`.
- Optional: `InMemoryTransport` per portal binding when the pinned OpenClaw
  version can attach an in-process MCP server transport directly to an agent.
- Fallback: one stdio `mcp-portal-server` process per agent when OpenClaw only
  supports process-backed MCP server injection.

The unacceptable mechanisms are:

- model-supplied `agentId`
- one global portal server with post-filtered search
- shared catalog/search index across agents
- approval tokens or auth material passed through model-visible tool inputs

## Terminology

- `namespace`: the upstream MCP server name visible to the agent, for example
  `linear`, `github`, or `readwise`.
- `toolName`: the MCP tool name inside one upstream namespace.
- `toolRef`: an encoded stable reference for links, cursors, caches, and exact
  lookup. The agent always also sees `namespace` and `toolName`.
- `tool summary`: a typed preview used by list/search. It includes names,
  descriptions, required/optional top-level fields, output shape preview, and
  safety hints. It is not a full schema dump.
- `portal binding`: one agent-scoped MCP Portal server binding. The preferred
  shape is one Hono Streamable HTTP route/session inside the gateway process,
  referenced by a generated OpenClaw `mcp.servers` entry and isolated with the
  target agent's `agents.list[].tools.allow`. It may also be an in-memory
  transport or stdio process when OpenClaw requires that shape, but it is always
  server-side bound to exactly one agent scope.

## Public Portal API

The agent sees one MCP server named `mcp-portal` with four tools:

- `mcp_portal_list`
  - Lists authorized namespaces and compact tool summaries.
  - Accepts optional namespace filters, exact tool pairs, or `toolRef`s.
  - Does not return full schemas.
- `mcp_portal_search`
  - Searches only the caller's agent-scoped index.
  - Returns ranked summaries, relationship hints, and schema field matches.
  - Defaults to schema summaries; full schemas are opt-in for narrow searches.
- `mcp_portal_describe`
  - Returns the exact contract for selected tools.
  - Includes canonical JSON Schema, output schemas, annotations, examples,
    related tools, and optional Zod/TypeScript helper source.
- `mcp_portal_call`
  - Validates arguments against the selected tool's input schema.
  - Returns a Zod-style validation error without calling upstream when invalid.
  - Calls `Client.callTool({ name: toolName, arguments })` only after namespace,
    tool visibility, approval, and argument validation pass.

All portal tools are batch-shaped. List, search, and describe accept
`requests: [{ id, ... }]`; call accepts
`calls: [{ id, namespace, toolName, arguments }]`. Every response is
`{ ok, results, errors, diagnostics }`, with `results` keyed by request/call
`id`; each item is a discriminated union of `{ ok: true, input, output }` or
`{ ok: false, input, error }`. `diagnostics` carries batch-level discovery
warnings so transient upstream failures do not silently look like denied tools.

`mcp_portal_call` accepts `namespace + toolName`, not only an opaque ID:

```json
{
	"calls": [
		{
			"id": "create-deploy-issue",
			"namespace": "linear",
			"toolName": "create_issue",
			"arguments": {
				"team": "ENG",
				"title": "Fix deploy"
			}
		}
	]
}
```

Every `list`, `search`, and `describe` response that refers to a tool includes
all three identity fields:

```json
{
	"namespace": "linear",
	"toolName": "create_issue",
	"toolRef": "mcp:bGluZWFy:Y3JlYXRlX2lzc3Vl"
}
```

## Agent Binding And Filtering Invariant

The portal must be scoped before tool discovery/search happens.

Correct flow:

```text
OpenClaw agent identity / session bootstrap
  -> portal binding for that agent
  -> allowed namespace/tool policy
  -> scoped upstream MCP clients
  -> scoped catalog
  -> scoped search index
  -> list/search/describe/call
```

Incorrect flow:

```text
global upstream catalog
  -> global search
  -> post-filter denied hits
```

That incorrect flow is rejected by design. It leaks shape through ranking,
counts, scores, and timing, and it makes search quality worse because ranking
considers tools the agent cannot use.

## File Structure

Create the shared TypeScript package:

- `packages/mcp-portal/package.json`
  - Shared catalog, search, MCP server, upstream MCP client, schema, and Tool VM
    helper package.
- `packages/mcp-portal/tsconfig.json`
- `packages/mcp-portal/tsconfig.build.json`
- `packages/mcp-portal/tsdown.config.ts`
- `packages/mcp-portal/src/index.ts`
- `packages/mcp-portal/src/json-schema.ts`
  - JSON-compatible schema/value types used by catalog objects.
- `packages/mcp-portal/src/tool-ref.ts`
  - Encodes/decodes stable `toolRef` values without `:` ambiguity.
- `packages/mcp-portal/src/catalog-types.ts`
  - Zod 4 schemas and TypeScript types for namespaces, tool records, summaries,
    schema artifacts, relationships, and catalog snapshots.
- `packages/mcp-portal/src/tool-summary.ts`
  - Computes compact summaries from canonical JSON Schemas.
- `packages/mcp-portal/src/tool-graph.ts`
  - Builds namespace, schema, entity, skill, and workflow links.
- `packages/mcp-portal/src/search-index.ts`
  - Builds scoped search indexes over one agent's allowed tool catalog.
- `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
  - Creates upstream MCP clients/transports and pages `listTools()`.
- `packages/mcp-portal/src/upstream-response-middleware.ts`
  - Reserved middleware seam for future response-content filtering. V1 only
    applies credential redaction and passes non-secret content through.
- `packages/mcp-portal/src/portal-access-policy.ts`
  - Resolves allowed namespaces/tools for one portal binding.
- `packages/mcp-portal/src/portal-session.ts`
  - Owns one agent-scoped catalog, clients, search index, TTL, and cleanup.
- `packages/mcp-portal/src/mcp-server/portal-mcp-server.ts`
  - Creates the agent-facing MCP Portal server.
- `packages/mcp-portal/src/mcp-server/portal-http-server.ts`
  - Mounts agent-facing MCP Streamable HTTP routes in Hono and resolves
    server-side portal bindings.
- `packages/mcp-portal/src/mcp-server/portal-tools.ts`
  - Implements `mcp_portal_list`, `mcp_portal_search`,
    `mcp_portal_describe`, and `mcp_portal_call`.
- `packages/mcp-portal/src/mcp-server/portal-call-validation.ts`
  - Builds Zod validators from canonical JSON Schema and formats validation
    failures.
- `packages/mcp-portal/src/tool-vm/zod-schema-loader.ts`
  - Optional `z.fromJSONSchema()` helper for Tool VM code.
- `packages/mcp-portal/src/tool-vm/typescript-artifact.ts`
  - Emits TypeScript catalog helper source from selected schema artifacts.
- `packages/mcp-portal/src/bin/agent-vm-mcp-portal.ts`
  - Tool VM CLI for validating catalogs and writing TypeScript helpers.
- `packages/mcp-portal/src/bin/mcp-portal-server.ts`
  - Gateway Hono/Streamable HTTP MCP server entrypoint for agent-scoped portal
    bindings.

Create the managed OpenClaw plugin package:

- `packages/openclaw-mcp-portal-plugin/package.json`
- `packages/openclaw-mcp-portal-plugin/tsconfig.json`
- `packages/openclaw-mcp-portal-plugin/tsconfig.build.json`
- `packages/openclaw-mcp-portal-plugin/tsdown.config.ts`
- `packages/openclaw-mcp-portal-plugin/openclaw.plugin.json`
- `packages/openclaw-mcp-portal-plugin/src/index.ts`
- `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`
  - Narrow local OpenClaw API types used by this plugin.
- `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
  - Portal plugin config and per-agent exposure policy.
- `packages/openclaw-mcp-portal-plugin/src/openclaw-mcp-server-config.ts`
  - Normalizes upstream OpenClaw `mcp.servers`.
- `packages/openclaw-mcp-portal-plugin/src/portal-agent-registry.ts`
  - Resolves configured OpenClaw agents and their portal binding config.
- `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts`
  - Creates/stops one managed Hono Streamable HTTP portal binding per agent,
    with in-memory or stdio fallback only when required by OpenClaw.
- `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts`
  - Injects compact allowed namespace directory into agent context.
- `packages/openclaw-mcp-portal-plugin/src/portal-approval-policy.ts`
  - Applies call approval policy from tool annotations and config.
- `packages/openclaw-mcp-portal-plugin/src/portal-approval-bridge.ts`
  - Bridges approval-required calls to OpenClaw server-side approval state.
- `packages/openclaw-mcp-portal-plugin/src/portal-config-watcher.ts`
  - Invalidates portal bindings immediately when upstream MCP server config or
    portal exposure policy changes.
- `packages/openclaw-mcp-portal-plugin/src/redaction.ts`
  - Redacts headers, env, tokens, and credential-shaped values.
- `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
  - Wires config, upstream server normalization, per-agent portal bindings,
    prompt hooks, approval policy, and cleanup.

Modify agent-vm integration:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
  - Install/symlink the managed portal plugin into OpenClaw gateway images.
  - Install the MCP Portal package into gateway images for the stdio server
    entrypoint.
  - Install the Tool VM TypeScript helper package into managed Tool VM images.
- `packages/agent-vm/package.json`
  - Depends on both portal packages so managed image generation can resolve their
    installed package metadata.
- `tsconfig.base.json`
  - Adds path aliases for both portal packages.
- `packages/agent-vm/tsconfig.build.json`
  - Adds build-time paths for both portal packages.
- `packages/agent-vm/src/cli/init-command.ts`
  - Generated OpenClaw config loads/allows the portal plugin and enables managed
    per-agent MCP Portal bindings.
- `packages/agent-vm/src/cli/build-command.test.ts`
  - Managed Dockerfile tests cover gateway plugin, portal server entrypoint, and
    Tool VM helper installs.
- `packages/agent-vm/src/cli/init-command.test.ts`
  - Generated OpenClaw config contains portal defaults without fake upstream MCP
    servers.
- `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
  - Validates portal plugin load path, portal server entrypoint, per-agent binding
    config, and prompt-injection permission.
- `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
  - Covers missing/broken portal deployment diagnostics.
- `docker/base-images/tool-vm/Dockerfile`
  - Prepare pnpm global install support for the Tool VM helper package.
- `docs/subsystems/mcp-portal.md`
- `docs/architecture/openclaw-gateway.md`
- `docs/subsystems/secrets-and-credentials.md`
- `docs/reference/configuration/system-json.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.test.ts`

---

### Task 0: Prove OpenClaw Binding And Approval Surfaces

**Files:**
- Create: `docs/wip/debugging/2026-05-10-mcp-portal-openclaw-api-spike.md`
- No production source edits.

- [x] **Step 1: Prove the per-agent MCP binding API**

Inspect the pinned OpenClaw package used by `managed-images.json` and record the
exact public API that can inject an MCP server into one agent runtime.

The spike document must record one of these exact outcomes:

```text
Outcome A: Hono Streamable HTTP portal binding supported
- API name:
- config path:
- route shape:
- per-agent secret header source:
- cleanup hook:

Outcome B: InMemoryTransport portal binding supported
- API name:
- transport attach point:
- sessionId source:
- cleanup hook:

Outcome C: stdio portal binding supported
- API name:
- config path:
- caller identity source:
- cleanup hook:

Outcome D: no safe binding API found
- evidence searched:
- blocker:
- implementation must stop here
```

Acceptance tests:

- The document cites exact OpenClaw files/docs and line references.
- The selected binding path does not require model-supplied `agentId`.
- The selected binding path can bind different portal server configs for Agent A
  and Agent B.
- If the result is Outcome D, later plugin wiring tasks must not proceed.

- [x] **Step 2: Prove the approval bridge**

Inspect the same OpenClaw version and record whether MCP-facade tool calls can
participate in gateway approval UI/policy.

The spike document must record:

```text
Approval bridge:
- native approval API available? yes/no
- API name or event shape:
- how approval request is surfaced:
- how approval result is delivered back to the portal:
- fallback behavior when unavailable:
```

Fallback behavior is fail-closed for tools requiring approval: return
`approval_required` without calling upstream. Do not invent model-visible
approval tokens.

Acceptance tests:

- The document cites the exact OpenClaw approval API or states that none exists.
- If no approval API exists, `writeTools`, `alwaysAskTools`, and destructive tools
  are specified to return `approval_required` and never call upstream.
- Approval state is keyed server-side by portal binding, namespace, tool name, and
  argument hash; it is never supplied by the model.

- [x] **Step 3: Prove prompt hook permissions**

Verify that the pinned OpenClaw version supports `agent_turn_prepare`,
`before_prompt_build`, and `plugins.entries.<id>.hooks.allowPromptInjection`.

Acceptance tests:

- The document cites exact OpenClaw docs/source for both hook names.
- The document cites the config path that enables prompt mutation.
- If either hook is unavailable in the pinned version, the plan is updated to use
  only the verified hook.

---

### Task 1: Create `@agent-vm/mcp-portal`

**Files:**
- Create: `packages/mcp-portal/package.json`
- Create: `packages/mcp-portal/tsconfig.json`
- Create: `packages/mcp-portal/tsconfig.build.json`
- Create: `packages/mcp-portal/tsdown.config.ts`
- Create: `packages/mcp-portal/src/index.ts`
- Create: `packages/mcp-portal/src/json-schema.ts`
- Create: `packages/mcp-portal/src/tool-ref.ts`
- Create: `packages/mcp-portal/src/catalog-types.ts`
- Create: `packages/mcp-portal/src/tool-summary.ts`
- Create: matching `*.test.ts`

- [x] **Step 1: Add package metadata**

Create package metadata matching existing repo package conventions:

```json
{
	"name": "@agent-vm/mcp-portal",
	"version": "0.0.58",
	"description": "Managed MCP Portal server, catalog, schema, and Tool VM helpers for agent-vm.",
	"homepage": "https://github.com/ShravanSunder/agent-vm#readme",
	"bugs": {
		"url": "https://github.com/ShravanSunder/agent-vm/issues"
	},
	"license": "MIT",
	"author": "Shravan Sunder <ShravanSunder@users.noreply.github.com>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ShravanSunder/agent-vm.git",
		"directory": "packages/mcp-portal"
	},
	"files": ["dist"],
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		},
		"./tool-vm": {
			"types": "./dist/tool-vm/index.d.ts",
			"import": "./dist/tool-vm/index.js"
		}
	},
	"bin": {
		"agent-vm-mcp-portal": "./dist/bin/agent-vm-mcp-portal.js",
		"mcp-portal-server": "./dist/bin/mcp-portal-server.js"
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
		"@hono/node-server": "^2.0.2",
		"@modelcontextprotocol/sdk": "^1.29.0",
		"hono": "^4.12.18",
		"zod": "^4.4.3"
	}
}
```

- [x] **Step 2: Define JSON-compatible schema types**

`json-schema.ts` must expose JSON value types and a conservative object-schema
type for MCP `inputSchema`/`outputSchema`.

Acceptance tests:

- A schema with `type: "object"`, `properties`, `required`, `$defs`, and `$ref`
  parses through the catalog Zod schema.
- A schema value containing a function is rejected because catalog artifacts are
  JSON-compatible only.

- [x] **Step 3: Implement encoded tool refs**

Use:

```text
mcp:<base64url(namespace)>:<base64url(toolName)>
```

Acceptance tests:

- `encodeMcpToolRef("linear", "create_issue")` round-trips through
  `decodeToolRef`.
- Refs round-trip when namespace/tool names contain `:`, `/`, spaces, and `_`.
- `decodeToolRef("mcp:linear:create_issue")` rejects legacy ambiguous refs.
- Responses keep human-readable `namespace` and `toolName` alongside `toolRef`.

- [x] **Step 4: Define catalog and summary schemas**

Catalog schemas must include:

- namespaces
- tool records
- tool summaries
- schema artifacts
- relationships
- safety/approval hints
- code-generation hints
- catalog metadata with server-side `bindingId`, `generatedAt`, and
  `sourceHash`; agent IDs are not part of model-visible catalog outputs

`tool-summary.ts` must compute summaries from schema artifacts:

- top-level required input fields
- top-level optional input fields
- short output shape preview
- safety hints
- no full schema body

Acceptance tests:

- A catalog containing one namespace, one MCP tool, input/output JSON Schema,
  annotations, and relationships parses successfully.
- Summary generation returns required/optional fields without full schema bodies.
- Portal wrapper metadata containing raw transport config fields such as `env`,
  `headers`, or `authorization` is rejected.
- MCP `inputSchema` and `outputSchema` are preserved verbatim even when a real
  tool schema legitimately contains properties named `headers`, `authorization`,
  or `apiKey`.

- [x] **Step 5: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/json-schema.test.ts packages/mcp-portal/src/tool-ref.test.ts packages/mcp-portal/src/catalog-types.test.ts packages/mcp-portal/src/tool-summary.test.ts
```

Expected: PASS with all new core tests.

---

### Task 2: Build Scoped Tool Graph And Search

**Files:**
- Create: `packages/mcp-portal/src/tool-graph.ts`
- Create: `packages/mcp-portal/src/search-index.ts`
- Create: `packages/mcp-portal/src/tool-graph.test.ts`
- Create: `packages/mcp-portal/src/search-index.test.ts`

- [x] **Step 1: Build relationship graph**

Implement deterministic links:

- namespace links: same upstream MCP server namespace
- schema links: output field names matching input field names
- entity links: matching schema `title`, `$id`, or metadata entity name
- skill links: tool refs referenced in skill metadata or matching skill tags
- safety links: read/write/destructive groupings

Skill metadata must be filtered before graph construction. Only index skill
titles, descriptions, tags, and relation hints when every referenced `toolRef`
survives the portal binding's namespace/tool policy. If a skill references a
denied tool, drop that relation; if the skill has no remaining allowed tool refs,
drop the skill from the scoped graph/search input.

Acceptance tests:

- `search_issues` links to `get_issue` and `create_comment` when output and
  input schemas share `issueId`.
- Tools from different namespaces do not link through generic names like `id`
  unless a stronger entity/title match exists.
- Relationship output is stable-sorted by relation type and `toolRef`.
- A skill that references both `linear` and denied `readwise` tools contributes
  only the `linear` relations to Agent A's scoped graph.
- A skill that references only denied tools is absent from Agent A's graph and
  search index.

- [x] **Step 2: Build scoped search indexes**

Search must index only the already-scoped catalog for one portal binding:

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
- Search results are compact and do not include full schemas by default.
- If the source catalog does not contain `readwise`, searching `highlight` never
  ranks or times work over `readwise` tools.
- A denied namespace cannot affect result scores, counts, or cursor output.
- Denied skill titles/descriptions cannot appear in search hits, relationship
  hints, debug payloads, or cursor state.

- [x] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/tool-graph.test.ts packages/mcp-portal/src/search-index.test.ts
```

Expected: PASS.

---

### Task 3: Add Zod, TypeScript Artifact, And CLI Helpers

**Files:**
- Create: `packages/mcp-portal/src/tool-vm/index.ts`
- Create: `packages/mcp-portal/src/tool-vm/zod-schema-loader.ts`
- Create: `packages/mcp-portal/src/tool-vm/typescript-artifact.ts`
- Create: `packages/mcp-portal/src/bin/agent-vm-mcp-portal.ts`
- Create: matching `*.test.ts`

- [x] **Step 1: Add Zod reconstruction helper**

`zod-schema-loader.ts` must:

- accept canonical JSON Schema
- call `z.fromJSONSchema(...)` when available
- return a typed success/failure result
- report that conversion is experimental
- never mutate the original schema object
- format validation failures as Zod-style issues with `path`, `code`, and
  `message`

Acceptance tests:

- A simple object JSON Schema converts to a Zod schema that parses valid input.
- Invalid input returns issues with stable paths and messages.
- Unsupported/cyclic schemas return a failure result rather than throwing out of
  the public helper.
- Fixture matrix covers recursive `$ref` through `$defs`, `allOf`, `oneOf`,
  `anyOf`, tuple `items` arrays, `prefixItems`, and `patternProperties`.
- Unsupported fixture matrix covers `not`, `unevaluatedProperties`,
  `if`/`then`/`else`, `dependentSchemas`, `contains`, and `uniqueItems`.
- `schema_validation_unavailable` names the unsupported JSON Schema feature and
  schema path so operators can identify which upstream tools need manual policy.

- [x] **Step 2: Add TypeScript helper artifact generation**

`typescript-artifact.ts` must emit a TypeScript module that contains:

- a catalog constant
- selected tool constants
- `createInputValidator(toolRef)` using Zod 4 `fromJSONSchema`
- type-safe helper names derived from stable `toolRef`s
- a top-level comment stating JSON Schema is canonical and Zod is derived

Acceptance tests:

- Generated source contains no auth headers/env values.
- Generated source references `z.fromJSONSchema`.
- Generated names are deterministic for the same catalog.

- [x] **Step 3: Add CLI**

`agent-vm-mcp-portal` commands:

```text
agent-vm-mcp-portal validate <catalog.json>
agent-vm-mcp-portal generate-helper <catalog.json> --out <directory>
```

Acceptance tests:

- `validate` exits 0 for a valid catalog.
- `validate` exits non-zero for a catalog with a forbidden secret-shaped wrapper
  field.
- `generate-helper` writes `catalog.ts` and `catalog.json` under the output
  directory.

- [x] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/tool-vm packages/mcp-portal/src/bin
```

Expected: PASS.

---

### Task 4: Build Upstream MCP Client Runtime

**Files:**
- Create: `packages/mcp-portal/src/upstream-mcp-client-runtime.ts`
- Create: `packages/mcp-portal/src/upstream-response-middleware.ts`
- Create: `packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/openclaw-mcp-server-config.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/openclaw-mcp-server-config.test.ts`

- [x] **Step 1: Normalize upstream OpenClaw MCP server records**

The upstream client runtime must support all configured OpenClaw MCP server
transports. Remote MCP is the expected common path:

- preferred remote transport: Streamable HTTP
- legacy remote transport: HTTP+SSE
- local/gateway-owned transport: stdio

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
- Unspecified remote transport attempts Streamable HTTP first and falls back to
  HTTP+SSE only when the server behaves like a legacy SSE server.
- `LD_PRELOAD` and other dangerous env keys are dropped from stdio env.
- malformed servers are skipped without exposing raw header/env values.
- `type: "sse"` and `transport: "sse"` resolve the same way OpenClaw resolves
  them.
- config-change disposal closes clients and rebuilds normalized server records.

- [x] **Step 2: Implement upstream MCP client runtime**

Runtime must:

- use `StreamableHTTPClientTransport` for streamable-http
- use `SSEClientTransport` for SSE
- use `StdioClientTransport` for stdio
- pass SSE headers through `requestInit.headers`; the current MCP SDK applies
  them to both the EventSource GET and recurring POST sends
- preserve all upstream auth in the gateway process; never emit upstream headers
  or env into Tool VM helper artifacts or agent-visible portal results
- pass every upstream response through `upstream-response-middleware.ts`. In v1
  this middleware performs credential redaction only; it exists so future PII or
  content-policy filtering can be inserted without changing the public portal API.
- connect with timeout
- call `listTools()` until `nextCursor` is absent
- call `callTool({ name: toolName, arguments })`
- cache clients per portal binding and namespace
- evict failed or closed clients deterministically
- close clients on portal binding cleanup

Acceptance tests:

- paginated `listTools` returns all pages.
- Streamable HTTP is tried before HTTP+SSE when the remote transport is
  unspecified.
- SSE transport receives both request and initial stream header handling.
- failed client creation does not poison the cache forever.
- concurrent calls to the same namespace serialize when required.
- calls for different portal bindings do not share clients.
- response middleware is invoked for success, non-throwing `isError`, and thrown
  error paths.

- [x] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/upstream-mcp-client-runtime.test.ts packages/openclaw-mcp-portal-plugin/src/openclaw-mcp-server-config.test.ts
```

Expected: PASS.

---

### Task 5: Build Agent-Scoped Portal Sessions

**Files:**
- Create: `packages/mcp-portal/src/portal-access-policy.ts`
- Create: `packages/mcp-portal/src/portal-session.ts`
- Create: `packages/mcp-portal/src/portal-session.test.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-config-watcher.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts`

- [x] **Step 1: Parse portal access config**

Config defaults:

- `enabledNamespaces: []` means all configured upstream OpenClaw MCP servers.
- `enabledNamespacesByAgent: {}` lets specific agents receive narrower or
  different namespace views.
- `hiddenToolsByAgent: {}` hides specific namespace/tool pairs for specific
  agents after namespace selection.
- `skillsDirs: []`
- `promptContext.enabled: true`
- `promptContext.maxNamespaces: 12`
- `cache.catalogTtlMs: 60_000`
- `approval.alwaysAskTools: []`
- `approval.writeTools: []`
- `approval.allowWithoutApprovalTools: []`
- `approval.trustedAnnotationNamespaces: []`
- `approval.annotationPolicy: "destructive-requires-approval"`

Acceptance tests:

- Empty config produces defaults.
- Upstream `mcpServers` in plugin config is rejected; upstream servers come from
  OpenClaw `mcp.servers`.
- Invalid approval policy is rejected.
- Annotation trust config defaults to no trusted upstream namespaces.
- Agent-specific exposure config can make Agent A see `linear` while Agent B sees
  `readwise`.

- [x] **Step 2: Resolve one portal binding scope**

`portal-access-policy.ts` must expose a resolver that accepts server-side binding
props, not model input:

```ts
interface PortalBindingIdentity {
	// Server-side OpenClaw identity only; never accepted from MCP tool input.
	readonly agentId: string;
	readonly bindingId: string;
}
```

Acceptance tests:

- The resolver returns allowed namespaces for the bound agent.
- Hidden tools are removed before catalog construction.
- The resolver has no API that accepts model-supplied `agentId`.

- [x] **Step 3: Build scoped session**

`portal-session.ts` must:

- create upstream MCP clients only for allowed namespaces
- build catalog snapshots only from allowed namespaces/tools
- build the search index from that scoped catalog
- cache by portal binding, not by model-provided input
- invalidate immediately when upstream `mcp.servers`, namespace exposure policy,
  hidden tool policy, skill directories, or approval policy changes
- close only that binding's upstream clients during cleanup

Acceptance tests:

- Agent A and Agent B get separate catalog snapshots.
- Agent A's search index does not contain Agent B-only tools.
- Session cache expires after TTL.
- Removing a namespace from policy removes it from list/search/describe/call
  immediately without waiting for `catalogTtlMs`.
- Removing an upstream MCP server closes that namespace client and prevents calls
  immediately.
- Cache clear closes clients for that portal binding only.

- [x] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/portal-session.test.ts packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts
```

Expected: PASS.

---

### Task 6: Implement The MCP Portal Server Tools

**Files:**
- Create: `packages/mcp-portal/src/mcp-server/portal-mcp-server.ts`
- Create: `packages/mcp-portal/src/mcp-server/portal-http-server.ts`
- Create: `packages/mcp-portal/src/mcp-server/portal-tools.ts`
- Create: `packages/mcp-portal/src/mcp-server/portal-call-validation.ts`
- Create: `packages/mcp-portal/src/bin/mcp-portal-server.ts`
- Create: matching `*.test.ts`

- [x] **Step 1: Create agent-facing MCP server**

The server must expose exactly these MCP tools:

```text
mcp_portal_list
mcp_portal_search
mcp_portal_describe
mcp_portal_call
```

The default entrypoint must host Hono Streamable HTTP MCP routes for
agent-scoped portal bindings:

```text
/mcp-portal/bindings/:bindingId/mcp
```

The gateway plugin must write one generated OpenClaw MCP server entry per
binding:

```text
mcp.servers.<portalServerName>.url = /mcp-portal/bindings/:bindingId/mcp
mcp.servers.<portalServerName>.transport = "streamable-http"
mcp.servers.<portalServerName>.headers.<secretHeader> = <server-generated secret>
```

It must also restrict the bound agent to the four materialized tool names from
that server entry through `agents.list[].tools.allow`. The agent must not choose
`bindingId`, `agentId`, upstream headers, or upstream server config through MCP
tool arguments.

Acceptance tests:

- MCP `tools/list` returns only the four portal tools.
- Hono Streamable HTTP route handles MCP initialize and `tools/list`.
- The HTTP route requires bound portal identity from server-side
  `portal-server-manager` state.
- Generated OpenClaw config uses one portal `mcp.servers` entry per binding and
  per-agent `agents.list[].tools.allow` restrictions for the four prefixed
  portal tools.
- Passing `agentId` in a tool input is rejected as an unknown field.
- Passing `bindingId`, upstream headers, or upstream server config in a tool
  input is rejected as an unknown field.

- [x] **Step 2: Implement `mcp_portal_list`**

Input:

```json
{
	"requests": [
		{
			"id": "linear-list",
			"namespaces": ["optional namespace filter"],
			"tools": [{ "namespace": "linear", "toolName": "create_issue" }],
			"refs": ["mcp:..."],
			"limit": 20,
			"cursor": "optional cursor"
		}
	]
}
```

Output:

- allowed namespace summaries
- compact tool summaries
- `namespace`, `toolName`, and `toolRef` for every tool
- next cursor
- no full schemas

Acceptance tests:

- list returns allowed namespace summaries without full schemas.
- list with exact namespace/tool pairs returns compact summaries.
- denied namespaces return no list results and do not leak counts.
- pagination is stable.

- [x] **Step 3: Implement `mcp_portal_search`**

Input:

```json
{
	"requests": [
		{
			"id": "linear-comments",
			"query": "linear issue comment",
			"namespaces": ["linear"],
			"limit": 10,
			"schemaDetail": "summary"
		}
	]
}
```

`schemaDetail` values:

- `"none"`
- `"summary"` default
- `"full"` for narrow searches only

Output:

- compact ranked hits
- relationship hints
- schema field matches
- `namespace`, `toolName`, and `toolRef`
- full schemas only when `schemaDetail: "full"`

Acceptance tests:

- search finds matches through schema property names.
- default search results omit full schema bodies.
- search runs against the scoped index, not a global index.
- a denied namespace filter returns no hits without revealing whether the
  namespace exists globally.

- [x] **Step 4: Implement `mcp_portal_describe`**

Input:

```json
{
	"requests": [
		{
			"id": "linear-create-schema",
			"tools": [{ "namespace": "linear", "toolName": "create_issue" }],
			"refs": ["mcp:..."],
			"includeJsonSchema": true,
			"includeZod": true,
			"includeTypescriptHelper": false,
			"includeRelated": true
		}
	]
}
```

Output:

- full canonical input JSON Schemas
- full canonical output JSON Schemas
- annotations
- related tools
- examples
- optional Zod reconstruction metadata
- optional generated TypeScript helper source

Acceptance tests:

- describe accepts multiple exact namespace/tool pairs.
- describe returns input/output schemas and annotations.
- describe can include Zod metadata without making Zod the canonical format.
- describe can include deterministic TypeScript helper source.
- describe rejects denied or unknown tools with a clear, secret-free error.

- [x] **Step 5: Implement `mcp_portal_call`**

Input:

```json
{
	"calls": [
		{
			"id": "create-issue",
			"namespace": "linear",
			"toolName": "create_issue",
			"arguments": {}
		}
	]
}
```

Behavior:

- verify namespace/tool is present in this portal binding's scoped catalog
- build a Zod validator from the canonical input JSON Schema
- validate arguments before calling upstream
- return Zod-style validation issues when invalid
- return `schema_validation_unavailable` and do not call upstream when the
  schema cannot be converted to a validator
- return `approval_required` and do not call upstream when policy requires
  operator approval and no server-side approval grant exists
- call upstream MCP with `Client.callTool({ name: toolName, arguments })` only
  after validation passes
- return upstream MCP result content and structured content after applying
  configured redaction to every text, structured, and error surface

Validation error output:

```json
{
	"ok": false,
	"results": {
		"create-issue": {
			"ok": false,
			"input": {
				"id": "create-issue",
				"namespace": "linear",
				"toolName": "create_issue",
				"arguments": {}
			},
			"error": {
				"kind": "input_validation",
				"namespace": "linear",
				"toolName": "create_issue",
				"issues": [
					{
						"path": ["title"],
						"code": "invalid_type",
						"message": "Expected string"
					}
				]
			}
		}
	},
	"errors": []
}
```

Approval-required output:

```json
{
	"ok": false,
	"results": {
		"create-issue": {
			"ok": false,
			"input": {
				"id": "create-issue",
				"namespace": "linear",
				"toolName": "create_issue",
				"arguments": { "title": "Fix deploy" }
			},
			"error": {
				"kind": "approval_required",
				"namespace": "linear",
				"toolName": "create_issue",
				"level": "critical",
				"message": "Operator approval is required before this batch can run."
			}
		}
	},
	"errors": []
}
```

Acceptance tests:

- call invokes upstream MCP only after validation succeeds.
- invalid arguments return Zod-style issues and do not call upstream.
- validator construction failure returns `schema_validation_unavailable` and does
  not call upstream.
- approval-required calls return `approval_required` and do not call upstream
  until the server-side approval bridge grants the exact request.
- call rejects denied namespace/tool pairs.
- call redacts configured secrets from thrown errors, non-throwing `isError`
  results, text content, and `structuredContent`.
- call should be preceded by `mcp_portal_describe` unless the caller already saw
  the full schema for that tool in the current portal session; prompt context and
  tests should reinforce this progressive-disclosure rule.

- [x] **Step 6: Run focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src/mcp-server
```

Expected: PASS.

---

### Task 7: Wire OpenClaw Managed Portal Bindings

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/package.json`
- Create: `packages/openclaw-mcp-portal-plugin/tsconfig.json`
- Create: `packages/openclaw-mcp-portal-plugin/tsconfig.build.json`
- Create: `packages/openclaw-mcp-portal-plugin/tsdown.config.ts`
- Create: `packages/openclaw-mcp-portal-plugin/openclaw.plugin.json`
- Create: `packages/openclaw-mcp-portal-plugin/src/index.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/openclaw-plugin-api.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-agent-registry.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-server-manager.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-config-watcher.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-prompt-context.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Create: matching `*.test.ts`
- Modify: `packages/agent-vm/package.json`
- Modify: `tsconfig.base.json`
- Modify: `packages/agent-vm/tsconfig.build.json`

- [x] **Step 1: Add package metadata**

Use dependencies:

```json
{
	"@agent-vm/mcp-portal": "workspace:*",
	"zod": "^4.4.3"
}
```

Use scripts matching the existing OpenClaw plugin packaging pattern:

```json
{
	"scripts": {
		"build": "tsdown && cp openclaw.plugin.json dist/",
		"typecheck": "tsc --noEmit -p tsconfig.json",
		"test": "vitest run"
	}
}
```

Acceptance tests:

- `pnpm --filter @agent-vm/openclaw-mcp-portal-plugin build` creates
  `dist/openclaw.plugin.json`.
- The built package exposes the plugin manifest from `dist`, matching the
  `agent-vm` plugin bundle discovery path.

- [x] **Step 2: Add OpenClaw manifest**

`openclaw.plugin.json` must declare:

```json
{
	"id": "mcp-portal",
	"name": "MCP Portal",
	"description": "Managed per-agent MCP server facade over configured upstream MCP servers.",
	"activation": { "onStartup": true },
	"configSchema": {
		"type": "object",
		"additionalProperties": false,
		"properties": {
			"enabledNamespaces": {
				"type": "array",
				"items": { "type": "string" }
			},
			"enabledNamespacesByAgent": {
				"type": "object",
				"additionalProperties": {
					"type": "array",
					"items": { "type": "string" }
				}
			},
			"hiddenToolsByAgent": {
				"type": "object",
				"additionalProperties": {
					"type": "array",
					"items": {
						"type": "object",
						"additionalProperties": false,
						"required": ["namespace", "toolName"],
						"properties": {
							"namespace": { "type": "string" },
							"toolName": { "type": "string" }
						}
					}
				}
			},
			"skillsDirs": {
				"type": "array",
				"items": { "type": "string" }
			},
			"promptContext": {
				"type": "object",
				"additionalProperties": false,
				"properties": {
					"enabled": { "type": "boolean" },
					"maxNamespaces": { "type": "number" }
				}
			},
			"cache": {
				"type": "object",
				"additionalProperties": false,
				"properties": {
					"catalogTtlMs": { "type": "number" }
				}
			},
			"approval": {
				"type": "object",
				"additionalProperties": false,
				"properties": {
					"alwaysAskTools": {
						"type": "array",
						"items": {
							"type": "object",
							"additionalProperties": false,
							"required": ["namespace", "toolName"],
							"properties": {
								"namespace": { "type": "string" },
								"toolName": { "type": "string" }
							}
						}
					},
					"writeTools": {
						"type": "array",
						"items": {
							"type": "object",
							"additionalProperties": false,
							"required": ["namespace", "toolName"],
							"properties": {
								"namespace": { "type": "string" },
								"toolName": { "type": "string" }
							}
						}
					},
					"allowWithoutApprovalTools": {
						"type": "array",
						"items": {
							"type": "object",
							"additionalProperties": false,
							"required": ["namespace", "toolName"],
							"properties": {
								"namespace": { "type": "string" },
								"toolName": { "type": "string" }
							}
						}
					},
					"trustedAnnotationNamespaces": {
						"type": "array",
						"items": { "type": "string" }
					},
					"annotationPolicy": {
						"type": "string",
						"enum": ["destructive-requires-approval", "off"]
					}
				}
			}
		}
	}
}
```

This plugin manages the front-side MCP Portal server bindings. It does not
register `mcp_portal_*` as OpenClaw plugin tools.

Acceptance tests:

- Manifest schema rejects unknown top-level fields.
- Manifest schema rejects `mcpServers`; upstream servers come from OpenClaw
  `mcp.servers`.
- Manifest schema accepts the generated default portal config.

- [x] **Step 3: Add local OpenClaw API types**

Type the exact API surface this plugin uses:

- `config`
- `pluginConfig`
- `logger`
- prompt hook registration
- runtime lifecycle cleanup
- any OpenClaw MCP bridge/session-bootstrap registration API used to inject
  managed MCP servers

Acceptance tests:

- Plugin registration throws a useful error if the required prompt/lifecycle API
  is missing.
- Plugin registration throws a useful error if OpenClaw cannot provide any
  per-agent MCP server binding path.

- [x] **Step 4: Implement per-agent binding manager**

Do not start this step until Task 0 records an acceptable OpenClaw binding
surface for the pinned OpenClaw version. If Task 0 cannot prove Hono Streamable
HTTP binding, in-process transport binding, or stdio MCP binding, stop and update
the architecture before implementation.

`portal-server-manager.ts` must choose one binding strategy:

- preferred: Hono-hosted Streamable HTTP MCP endpoint per portal binding, with
  the route and binding credential inserted into a generated OpenClaw
  `mcp.servers.<portalServerName>` entry by trusted gateway code
- for each generated server entry, compute OpenClaw's materialized tool names as
  `<portalServerName>__mcp_portal_list`,
  `<portalServerName>__mcp_portal_search`,
  `<portalServerName>__mcp_portal_describe`, and
  `<portalServerName>__mcp_portal_call`
- write the bound agent's `agents.list[].tools.allow` so the agent sees only its
  own four portal tools, not other agents' portal server entries
- acceptable fallback: `InMemoryTransport` per portal binding when OpenClaw can
  attach a plugin-provided in-process transport directly to an agent runtime
- last fallback: one stdio `mcp-portal-server` process per agent when OpenClaw
  only supports process-backed MCP server injection

Hard requirements:

- no global portal MCP server shared by all agents without an unspoofable
  server-side binding
- no model-supplied agent ID
- no post-filtered global search
- no model-visible binding secret, upstream MCP auth header, or upstream server
  config
- cleanup closes only the binding for the affected agent/session

Acceptance tests:

- The implementation cites the Task 0 binding decision in code comments or test
  fixture names so the dependency is visible to future maintainers.
- Agent A and Agent B receive different generated `mcp.servers` entries, route
  bindings, and per-agent tool allowlists.
- Agent A cannot connect to Agent B's portal binding.
- Binding config contains no upstream auth header values in logs or prompt text.
- Config changes invalidate affected portal sessions immediately, not after
  `catalogTtlMs`.
- Lifecycle cleanup closes the correct portal server binding.

- [x] **Step 5: Inject compact prompt context**

Register a prompt hook using the exact hook proven in Task 0:
`before_prompt_build` or `agent_turn_prepare`. Generated plugin config must set
`plugins.entries.mcp-portal.hooks.allowPromptInjection: true`.
The injected context must be compact and stable:

```text
MCP Portal is available as an MCP server.
Use mcp_portal_list for allowed namespaces and compact tool summaries,
mcp_portal_search for discovery, mcp_portal_describe for full JSON Schema and
optional Zod/TypeScript helpers, and mcp_portal_call to call an upstream MCP
tool by namespace + toolName. Call mcp_portal_describe before mcp_portal_call
unless you already saw the full schema for that tool in this portal session.
Gateway owns MCP auth.
Namespaces: linear(18 tools), readwise(9 tools), calendar(6 tools)
```

Acceptance tests:

- Prompt context appears when enabled.
- Prompt context is absent with a clear diagnostic when `allowPromptInjection` is
  disabled.
- Prompt context lists only namespaces allowed for that agent.
- Prompt context omits raw schemas and secrets.
- Prompt context degrades gracefully when no upstream MCP servers are configured.

- [x] **Step 6: Wire workspace package resolution**

Update repo package wiring:

- `packages/agent-vm/package.json` depends on `@agent-vm/mcp-portal` and
  `@agent-vm/openclaw-mcp-portal-plugin` with `workspace:*`.
- `tsconfig.base.json` adds path aliases for both packages.
- `packages/agent-vm/tsconfig.build.json` adds build-time path aliases for both
  packages.
- `packages/openclaw-mcp-portal-plugin/tsconfig.build.json` maps
  `@agent-vm/mcp-portal` to the core package declarations.

Acceptance tests:

- `pnpm --filter @agent-vm/openclaw-mcp-portal-plugin typecheck` resolves the
  portal package import.
- `pnpm --filter @agent-vm/agent-vm typecheck` resolves both portal packages for
  managed image package-spec discovery.

---

### Task 8: Approval, Redaction, And Safety Policy

**Files:**
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-approval-policy.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/portal-approval-bridge.ts`
- Create: `packages/openclaw-mcp-portal-plugin/src/redaction.ts`
- Create: matching `*.test.ts`

- [x] **Step 1: Implement redaction**

Redact:

- authorization headers
- token-like query params
- env values
- `*_TOKEN`, `*_KEY`, `*_SECRET`, `PASSWORD`
- bearer/basic auth strings
- per-agent portal binding credentials

Acceptance tests:

- Errors containing `Bearer secret-value` are reported without the secret.
- Search/list/describe/call outputs never contain configured env/header values.
- Non-throwing upstream MCP results with `isError: true`, text content, or
  `structuredContent` containing configured secrets are redacted before they
  reach the agent.
- A legitimate MCP tool schema with input properties named `headers`,
  `authorization`, or `apiKey` remains intact in `mcp_portal_describe`.
- Per-agent binding secrets never appear in prompt context, logs, Tool VM helper
  artifacts, non-throwing MCP results, or thrown errors.

- [x] **Step 2: Implement approval policy**

Approval policy applies to `mcp_portal_call` before upstream `Client.callTool`.

Rules:

- policy returns either `allow` or `approval_required`.
- `allowWithoutApprovalTools` is the only explicit bypass for untrusted
  namespaces and must be configured by namespace + toolName.
- `alwaysAskTools` always returns `approval_required`.
- `writeTools` always returns critical `approval_required`.
- `trustedAnnotationNamespaces` controls whether upstream tool annotations are
  trusted for one namespace. The default is no trusted namespaces.
- For namespaces not in `trustedAnnotationNamespaces`, require approval for every
  tool unless the exact namespace/toolName is in `allowWithoutApprovalTools`.
- For trusted namespaces,
  `annotationPolicy: "destructive-requires-approval"` requires approval when the
  described tool has `annotations.destructiveHint !== false` or
  `annotations.readOnlyHint !== true`.
- list/search/describe do not require approval by default.

Approval protocol:

- If OpenClaw exposes a native approval API proven in Task 0, create a
  server-side approval request keyed by:
  - portal binding ID
  - namespace
  - toolName
  - canonicalized argument hash
  - policy level
- Return `approval_required` to the agent without calling upstream.
- Do not accept approval tokens, approval booleans, request IDs, or actor IDs
  from model-visible `mcp_portal_call` arguments.
- If a non-authorizing `approvalRequestId` is included in the response for UI
  correlation, no portal tool may accept it as proof of approval.
- When the operator approves, the server-side bridge grants one exact matching
  call. A changed argument hash requires a fresh approval request.
- If OpenClaw has no approval bridge, fail closed: approval-required tools return
  `approval_required` and are never called.

Acceptance tests:

- read-only call does not require approval by default.
- destructive annotated call requires approval.
- a namespace that is not trusted for annotations requires approval even if the
  upstream tool claims `readOnlyHint: true`.
- an exact `allowWithoutApprovalTools` entry allows a configured untrusted tool
  without approving the whole namespace.
- configured write tool returns critical approval.
- search/list/describe do not require approval.
- model-supplied approval fields are rejected as unknown input.
- approval for one argument hash does not authorize a changed argument payload.
- without an OpenClaw approval bridge, approval-required tools fail closed and
  do not call upstream.

---

### Task 9: Install Portal Into Managed Gateway And Tool VM Images

**Files:**
- Modify: `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- Modify: `packages/agent-vm/src/cli/build-command.test.ts`
- Modify: `docker/base-images/tool-vm/Dockerfile`

- [x] **Step 1: Managed OpenClaw gateway image installs portal packages**

Extend managed Dockerfile generation:

- resolve `@agent-vm/openclaw-mcp-portal-plugin` package spec from installed
  package metadata, same as the gondolin plugin
- resolve `@agent-vm/mcp-portal` package spec for the portal server entrypoint
- install both globally in OpenClaw gateway images
- symlink the plugin `dist` directory to:
  `/home/openclaw/.openclaw/extensions/mcp-portal`
- make `mcp-portal-server` available on PATH in the gateway image
- include the packages in the generated Dockerfile plan

Acceptance tests:

- generated OpenClaw gateway Dockerfile installs gondolin, portal plugin, and
  portal server packages.
- generated Dockerfile symlinks both extension directories.
- generated Dockerfile has `mcp-portal-server` available.
- overlay `openClawPackageOverrides` cannot override the managed portal plugin
  package by accident.

- [x] **Step 2: Managed Tool VM image installs TypeScript helper**

Update Tool VM base/Dockerfile generation so managed Tool VM images have:

- pnpm available for global package installation
- `@agent-vm/mcp-portal` installed globally
- `agent-vm-mcp-portal` available on PATH
- no auth config, no upstream MCP server config, no token names

Acceptance tests:

- generated Tool VM Dockerfile contains the portal helper package install.
- generated Tool VM Dockerfile does not contain `TOKEN`, `Authorization`,
  `.npmrc`, `.netrc`, or `_authToken`.

---

### Task 10: Update Init Defaults, Doctor, And Docs

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`
- Create: `docs/subsystems/mcp-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/reference/configuration/system-json.md`

- [x] **Step 1: Generated OpenClaw config enables portal plugin**

Default OpenClaw config must:

- include both extension load paths:
  - `/home/openclaw/.openclaw/extensions/gondolin`
  - `/home/openclaw/.openclaw/extensions/mcp-portal`
- allow `gondolin`, `memory-core`, and `mcp-portal`
- enable `mcp-portal`
- enable managed per-agent portal MCP server bindings by adding generated
  `mcp.servers.<portalServerName>` entries and matching
  `agents.list[].tools.allow` restrictions for each configured agent
- set `plugins.entries.mcp-portal.hooks.allowPromptInjection: true`
- keep operator-authored upstream `mcp.servers` empty unless user config adds
  servers

Acceptance tests:

- `agent-vm init` output contains the portal plugin entry.
- generated plugin entry enables `hooks.allowPromptInjection`.
- generated config enables managed portal MCP server bindings.
- generated config does not add fake upstream MCP servers or secret
  placeholders.

- [x] **Step 2: Add deployment doctor coverage**

Doctor must validate:

- portal extension load path exists in generated/configured OpenClaw config
- portal plugin is allowed
- portal plugin entry is enabled when managed portal is enabled
- `mcp-portal-server` entrypoint is available in the gateway image
- per-agent portal binding config is present and names the Task 0 verified
  binding strategy
- plugin prompt injection is allowed when prompt context is enabled
- missing/broken portal config reports redacted diagnostics

Acceptance tests:

- valid generated OpenClaw config passes portal doctor checks.
- missing portal extension path produces an actionable doctor warning.
- missing per-agent binding config is reported.
- prompt context enabled without `allowPromptInjection` is reported.
- diagnostics do not include raw MCP header/env values.

- [x] **Step 3: Document the model**

Docs must state:

- MCP Portal is an MCP server facade and MCP client aggregator.
- Each agent receives a separate portal binding.
- Namespace + toolName are the canonical callable identity; `toolRef` is a
  stable reference, not a replacement for namespace.
- Gateway owns upstream MCP auth and connections.
- Denied tools never enter an agent's scoped catalog or search index.
- Tool VM receives TypeScript/Zod helpers only.
- MCP JSON Schema is canonical.
- Zod reconstruction is used for validation/helpers and remains derived.
- Annotation trust is per upstream namespace. Untrusted upstream annotations do
  not bypass approval.
- `mcp_portal_call` returns Zod-style validation errors and does not call
  upstream on invalid input.
- Credential redaction is not general PII minimization. V1 documents the
  response-content limitation and reserves `upstream-response-middleware.ts` for
  future PII/content-policy filtering.
- Intent verification is future work. V1 must not add model-visible
  `commitToken` or approval-token fields.
- Tool VM HTTP-mediated secrets are external to this portal plan. If a separate
  Gondolin secret-source feature exists, portal docs must point to it instead of
  duplicating that secret surface.

- [x] **Step 4: Regenerate manuals**

Run:

```bash
pnpm --filter @agent-vm/agent-vm build
pnpm agent-vm manual update
```

Expected: generated manuals mention MCP Portal server bindings, progressive
disclosure, gateway-owned MCP auth, namespace/toolName calls, and Tool VM helper
availability.

---

### Task 11: Verification

**Files:**
- No planned source edits except fixes found by verification.

- [x] **Step 1: Run focused package tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src
```

Expected: PASS.

- [x] **Step 2: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS with exit code 0.

- [x] **Step 3: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS, including the two new portal packages.

- [x] **Step 4: Run full checks**

Run:

```bash
pnpm check
```

Expected: PASS, including package-version sync, Zod version check, type-aware
lint, format check, and typecheck.

- [x] **Step 5: Run managed-image smoke checks**

Create a temporary deployment directory, run `agent-vm init`, build generated
managed Dockerfiles, and inspect them.

Expected:

- OpenClaw gateway Dockerfile installs and symlinks the portal plugin.
- OpenClaw gateway Dockerfile installs `mcp-portal-server`.
- Tool VM Dockerfile installs the TypeScript helper CLI.
- Generated OpenClaw config enables per-agent portal MCP server bindings.
- Generated OpenClaw config sets `hooks.allowPromptInjection: true` for
  `mcp-portal`.
- No generated Dockerfile or config contains raw upstream auth header values or
  token literals except user-authored upstream MCP server config supplied by the
  operator. Generated per-agent portal binding secrets may appear only in the
  loopback portal MCP server headers that bind each OpenClaw agent to its own
  portal facade.

- [x] **Step 6: Run portal runtime smoke checks**

Add a smoke test that boots controlled portal bindings against controlled
upstream MCP test servers:

- one paginated stdio MCP server
- one remote SSE or streamable-http MCP server with auth headers
- two OpenClaw agents with different portal exposure policies

Expected:

- Each agent sees exactly one `mcp-portal` MCP server binding.
- MCP `tools/list` on that binding returns `mcp_portal_list`,
  `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`.
- `mcp_portal_list` shows only each agent's allowed namespaces.
- `mcp_portal_search` finds tools through schema field names inside the scoped
  index.
- A denied namespace never appears in list/search results and cannot influence
  ranking/counts.
- Runtime evidence shows denied tools are absent before indexing, not removed by
  global post-filtering.
- Removing a namespace from an agent policy removes it from list/search/describe
  and prevents calls immediately without waiting for TTL expiry.
- `mcp_portal_describe` returns full input/output schemas and annotations.
- `mcp_portal_describe` can return deterministic TypeScript/Zod helper source.
- `mcp_portal_call` returns Zod-style validation errors for invalid input without
  calling upstream.
- `mcp_portal_call` calls the selected upstream MCP tool only after validation
  succeeds.
- approval-required calls return `approval_required` without calling upstream
  until a server-side approval grant exists.
- redaction applies to thrown errors and non-throwing MCP results, including
  `isError` results and `structuredContent`.
- response middleware seam runs on upstream results and currently performs only
  credential redaction.
- Agent A cannot see, describe, or call Agent B-only tools.
- SSE/HTTP auth headers are used by the gateway and never appear in portal
  outputs, Tool VM helper artifacts, logs, or thrown errors.

---

## Implementation Check-In

Implemented in the `mcp-portal` worktree.

Verification from the implementation pass:

- `pnpm fmt && pnpm check` passed.
- `pnpm vitest run packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src packages/agent-vm/src/build/managed-image-release.test.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/build-command.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
  passed: 27 files, 165 tests.
- `pnpm -r build` passed across the workspace packages.
- `pnpm test:unit` passed: 154 files, 1174 tests passed, 1 skipped.
- `pnpm test:smoke` passed: 5 files passed, 1 skipped; 6 tests passed, 1 skipped.
- `pnpm test:integration` still has two live VM/Gondolin failures that were
  already reproduced outside the portal implementation path:
  cross-VM SSH exits 255 and the live sandbox health probe returns
  `400 Bad Request`.

Independent review check-ins:

- xhigh Codex review found catalog redaction and session-scoped approval gaps;
  both were patched and covered by tests.
- Claude Opus max-effort review found raw-vs-validated approval argument hashing;
  this was patched by normalizing approval arguments through the same JSON
  Schema/Zod path used by `mcp_portal_call`.

---

## Self-Review

- Spec coverage: The plan covers MCP Portal as a per-agent MCP server facade,
  upstream MCP client aggregation, namespace-first calls, scoped catalogs/search,
  JSON Schema preservation, Zod validation, TypeScript/Zod Tool VM helpers,
  approval, redaction, docs, and verification.
- Placeholder scan: The plan avoids placeholder implementation steps and names
  exact files, tools, commands, and acceptance tests.
- Type consistency: `PortalCatalog`, `toolRef`, `namespace`, `toolName`,
  `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and
  `mcp_portal_call` are used consistently.
