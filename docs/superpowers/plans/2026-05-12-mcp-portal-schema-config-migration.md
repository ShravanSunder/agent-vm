# MCP Portal Schema Config Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move MCP Portal configuration into explicit JSONC contracts: `system.jsonc` owns zone agents and the MCP config directory, `mcp.config.jsonc` owns upstream MCP providers, and `mcp-portal.config.jsonc` owns portal server settings, agent profile bindings, and policy.

**Architecture:** `@agent-vm/config-contracts` is the shared package for MCP-related JSONC schemas, JSON Schema artifacts, config loaders, and TypeScript types. `agent-vm` owns controller-only `system.jsonc` validation and materializes OpenClaw runtime config from the three authored files. OpenClaw `openclaw.json` may contain generated MCP server endpoints, but it must not contain human-authored MCP Portal namespace/profile policy.

**Tech Stack:** TypeScript, Zod 4, JSONC config loading, JSON Schema artifacts generated from Zod, `jsonc-parser` migrations, cmd-ts CLI subcommands, Vitest, OXC/Oxfmt.

---

## Target Config Shape

New scaffolds use JSONC for human-authored config. `system.json` remains accepted only as a legacy input when it already exists.

`config/system.jsonc` owns the zone and agent registry:

```jsonc
{
	"$schema": "./schemas/system.schema.json",
	"schemaVersion": 1,
	"zones": [
		{
			"id": "shravan",
			"gateway": {
				"type": "openclaw",
				"config": "./gateways/shravan/openclaw.json"
			},
			"agents": [
				{ "id": "sun" },
				{ "id": "shravan", "toolVmProfile": "tools-dev" },
				{ "id": "alevtina", "toolVmProfile": "tools-light" }
			],
			"defaultToolVmProfile": "standard",
			"agentToolVmProfiles": {},
			"mcp": {
				"configDir": "./gateways/shravan"
			}
		}
	]
}
```

`config/gateways/<zone>/mcp.config.jsonc` owns upstream MCP providers:

```jsonc
{
	"$schema": "../../schemas/mcp.schema.json",
	"schemaVersion": 1,
	"providers": {
		"linear": {
			"kind": "mcp",
			"namespace": "linear",
			"discovery": { "summary": "Linear issue tracker" },
			"transport": {
				"kind": "streamable-http",
				"url": "https://mcp.linear.app/mcp",
				"headers": {
					"authorization": {
						"source": "environment",
						"name": "LINEAR_MCP_TOKEN"
					}
				}
			}
		}
	}
}
```

`config/gateways/<zone>/mcp-portal.config.jsonc` owns portal server settings, agent-to-profile assignments, and portal policy:

```jsonc
{
	"$schema": "../../schemas/mcp-portal.schema.json",
	"schemaVersion": 1,
	"server": {
		"host": "127.0.0.1",
		"port": 18790,
		"accessHeader": {
			"name": "x-agent-vm-mcp-portal-secret",
			"secret": { "source": "environment", "name": "MCP_PORTAL_SERVER_SECRET" }
		}
	},
	"agents": {
		"sun": { "profile": "research" },
		"shravan": { "profile": "builder" },
		"alevtina": { "profile": "reviewer" }
	},
	"profiles": {
		"default": {
			"enabledNamespaces": [],
			"enabledToolsByNamespace": {},
			"hiddenToolsByNamespace": {},
			"logging": { "enabled": false },
			"promptContext": { "enabled": true, "maxNamespaces": 12 },
			"cache": { "catalogTtlMs": 60000 },
			"approval": {
				"allowWithoutApprovalTools": [],
				"alwaysAskTools": [],
				"annotationPolicy": "destructive-requires-approval",
				"trustedAnnotationNamespaces": [],
				"writeTools": []
			}
		},
		"builder": {
			"extends": "default",
			"enabledNamespaces": ["linear", "github"],
			"enabledToolsByNamespace": {
				"linear": ["create_issue", "search_issues"],
				"github": ["get_file_contents"]
			},
			"logging": { "enabled": true }
		}
	}
}
```

Important semantics:

- `$schema` is an editor/tooling hint. It must point to deployment-local schema files; no `agent-vm.dev` site or GitHub Pages hosting is required.
- `schemaVersion` is the runtime and migration gate. New scaffolds and migrations write `schemaVersion: 1`.
- `enabledNamespaces: []` means deny all namespaces. V1 has no implicit allow-all.
- `enabledToolsByNamespace` narrows tools inside an enabled namespace. Missing namespace entries mean all tools in that enabled namespace are available unless hidden.
- `hiddenToolsByNamespace` removes tools before catalog and search-index construction.
- `logging.enabled` controls MCP Portal audit logging only. It is not content filtering.
- MCP provider credentials live only in `mcp.config.jsonc`. Portal profiles select namespaces/tools and policy; they do not own upstream secrets.
- Agent-to-MCP-profile assignment lives in `mcp-portal.config.jsonc`, not `system.jsonc`. `system.jsonc` only declares which agents exist in the zone.
- Secure tools profiles are intentionally out of scope for this plan.

---

## File Structure

- Create/modify `packages/config-contracts/`
  - `src/json-config-file.ts`: shared JSONC loader.
  - `src/secret-value.ts`: shared environment / 1Password secret reference schema.
  - `src/mcp-config.ts`: upstream MCP provider schema, loader, and resolved provider helper.
  - `src/mcp-portal-config.ts`: portal server, agent binding, profile, approval, prompt, cache, and logging schema.
  - `src/schema-artifacts.ts`: JSON Schema artifacts generated from Zod for `mcp.config.jsonc` and `mcp-portal.config.jsonc`.
  - Tests for strict parsing, profile inheritance, defaults, and schema artifacts.
- Modify `packages/agent-vm/src/config/system-config.ts`
  - Add root `$schema` and `schemaVersion`.
  - Add `zones[].agents[]` objects and `zones[].mcp.configDir`.
  - Resolve `mcp.configDir` relative to the system config file.
  - Reject worker zones that declare agents/MCP fields.
  - Validate duplicate agents, tool VM profile references, and agent-keyed maps.
  - Export or provide a system JSON Schema artifact used by scaffolding.
- Modify `packages/gateway-interface/src/gateway-lifecycle.ts`
  - Carry normalized agents, MCP config directory, generated runtime MCP servers, and generated runtime plugin config.
- Modify `packages/agent-vm/src/gateway/gateway-zone-support.ts`
  - Map system config zones into lifecycle zone config.
- Create/modify `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`
  - Build OpenClaw `mcp.servers` entries from `mcp-portal.config.jsonc`.
  - Build OpenClaw plugin config `{ configDir }`.
- Modify `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
  - Load `mcp-portal.config.jsonc` from `zone.mcp.configDir`.
  - Attach runtime MCP servers and runtime plugin config before lifecycle boot.
- Modify `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
  - Write effective OpenClaw config with generated MCP servers.
  - Replace stale `mcp-portal.config` instead of merging old policy fields.
- Modify `packages/agent-vm/src/cli/init-command.ts`
  - Scaffold `config/system.jsonc`, `mcp.config.jsonc`, `mcp-portal.config.jsonc`, and deployment-local schema files.
- Modify `packages/agent-vm/src/cli/migrate-commands.ts`
  - Add `runMigrateMcpPortalConfigCommand`.
  - Preserve JSONC comments while adding `$schema`, `schemaVersion`, `zones[].agents`, and `zones[].mcp.configDir`.
  - Create missing MCP config files and schema files without overwriting existing authored files.
- Modify `packages/agent-vm/src/cli/commands/migrate-definition.ts`
  - Add `agent-vm migrate mcp-portal`.
- Modify validation and doctor:
  - `packages/agent-vm/src/operations/config-validation.ts`
  - `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify docs and generated manuals:
  - `docs/reference/configuration/system-json.md`
  - `docs/subsystems/mcp-portal.md`
  - `docs/architecture/openclaw-gateway.md`
  - `packages/agent-vm/src/cli/manual-templates.ts`
  - `packages/agent-vm/src/cli/manual-templates.test.ts`

---

### Task 1: Add Shared Config Contracts Package

**Files:**
- Create/modify: `packages/config-contracts/package.json`
- Create/modify: `packages/config-contracts/src/json-config-file.ts`
- Create/modify: `packages/config-contracts/src/secret-value.ts`
- Create/modify: `packages/config-contracts/src/mcp-config.ts`
- Create/modify: `packages/config-contracts/src/mcp-portal-config.ts`
- Create/modify: `packages/config-contracts/src/schema-artifacts.ts`
- Create/modify: `packages/config-contracts/src/*.test.ts`
- Modify: `tsconfig.base.json`
- Modify: consuming package `package.json` files

- [ ] **Step 1: Write failing config-contract tests**

Run:

```bash
pnpm vitest run packages/config-contracts/src
```

Expected before implementation: tests fail because the package and schemas do not exist.

Required tests:

- `loadMcpConfig` accepts JSONC comments and strict upstream provider config.
- `loadMcpConfig` rejects unknown fields.
- `mcpConfigToResolvedProviders` preserves `streamable-http`, `sse`, and `stdio` as a discriminated union.
- `loadMcpPortalConfig` accepts server settings, agent profile bindings, and profile policy.
- `resolveMcpPortalProfile` applies inheritance without mutating parent profiles.
- `resolveMcpPortalProfile` rejects unknown parents and cycles.
- `createConfigContractSchemaArtifacts` returns separate JSON Schemas for `mcp` and `mcpPortal` with stable `$id` and `schemaVersion`.

- [ ] **Step 2: Implement shared schemas and loaders**

Implementation rules:

- No `any`.
- No non-null assertions.
- Use `z.infer` from Zod schemas.
- Use strict object schemas unless a field is deliberately open.
- Keep JSON Schema canonical on the wire; Zod is the runtime validator and artifact generator.

The MCP provider transport union must be:

```ts
type ResolvedMcpProvider =
	| {
			readonly headers: Readonly<Record<string, SecretValue>>;
			readonly namespace: string;
			readonly transport: 'streamable-http' | 'sse';
			readonly url: string;
	  }
	| {
			readonly args: readonly string[];
			readonly command: string;
			readonly cwd?: string;
			readonly env: Readonly<Record<string, SecretValue>>;
			readonly namespace: string;
			readonly transport: 'stdio';
	  };
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/config-contracts/src
pnpm --filter @agent-vm/config-contracts typecheck
```

Expected: PASS.

---

### Task 2: Add System Config Agent Registry And MCP Config Directory

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`

- [ ] **Step 1: Write failing system schema tests**

Required tests:

- Loads root `$schema` and `schemaVersion`.
- Loads OpenClaw `zones[].agents` as objects.
- Loads and resolves `zones[].mcp.configDir`.
- Rejects duplicate agent IDs.
- Rejects `agent.toolVmProfile`, `defaultToolVmProfile`, and `agentToolVmProfiles` references to unknown Tool VM profiles.
- Rejects worker zones that declare `agents`, `agentToolVmProfiles`, `agentSandboxSeeds`, or `mcp`.
- Keeps legacy `system.json` load support while new scaffolds use `system.jsonc`.

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement system schema updates**

Required shape:

```ts
const zoneAgentSchema = z
	.object({
		id: agentIdSchema,
		toolVmProfile: z.string().min(1).optional(),
	})
	.strict();

const zoneMcpConfigSchema = z
	.object({
		configDir: z.string().min(1),
	})
	.strict();
```

Root fields:

```ts
$schema: z.string().min(1).optional(),
schemaVersion: z.literal(1).default(1),
```

Path resolution:

```ts
...(zone.mcp === undefined ? {} : { mcp: { configDir: resolvePath(zone.mcp.configDir) } }),
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Expected: PASS.

---

### Task 3: Scaffold Authored JSONC Files And Local Schema Files

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Write failing scaffold tests**

For OpenClaw scaffolds, assert these files are created:

```text
config/system.jsonc
config/schemas/system.schema.json
config/schemas/mcp.schema.json
config/schemas/mcp-portal.schema.json
config/gateways/<zone>/openclaw.json
config/gateways/<zone>/mcp.config.jsonc
config/gateways/<zone>/mcp-portal.config.jsonc
```

Required generated references:

- `system.jsonc.$schema === "./schemas/system.schema.json"`
- `mcp.config.jsonc.$schema === "../../schemas/mcp.schema.json"`
- `mcp-portal.config.jsonc.$schema === "../../schemas/mcp-portal.schema.json"`
- `system.jsonc.zones[0].mcp.configDir === "./gateways/<zone>"`
- `mcp-portal.config.jsonc.agents[agentId].profile === "default"` for every scaffolded agent.
- `openclaw.json.plugins.entries["mcp-portal"].config` is absent or contains only runtime-safe fields; it must not contain `promptContext`, `enabledNamespaces`, or old policy fields.

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement scaffold output**

Implementation details:

- Use `formatJsoncConfig(...)` for authored JSONC files.
- Use `createConfigContractSchemaArtifacts()` for MCP schema files.
- Use the system schema artifact from `agent-vm` for `system.schema.json`.
- Do not overwrite existing authored config unless `overwrite` is true.
- New scaffolds should prefer `system.jsonc`; if a legacy `system.json` already exists, preserve that path.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

---

### Task 4: Add MCP Portal Config Migration Command

**Files:**
- Modify: `packages/agent-vm/src/cli/migrate-commands.ts`
- Modify: `packages/agent-vm/src/cli/commands/migrate-definition.ts`
- Modify: `packages/agent-vm/src/cli/migrate-commands.test.ts`

- [ ] **Step 1: Write failing migration tests**

Required tests:

- Creates `mcp.config.jsonc`, `mcp-portal.config.jsonc`, and schema files for OpenClaw zones.
- Adds root `$schema` and `schemaVersion` to `system.jsonc` if missing.
- Adds `zones[].agents` from existing `openclaw.json.agents.list`.
- Adds `zones[].mcp.configDir`.
- Preserves comments in `system.jsonc`.
- Rewrites `openclaw.json.mcp.servers` to `http://127.0.0.1:18790/agents/<agentId>/mcp`.
- Removes old `mcp_portal_*` server entries before adding current entries.
- Replaces stale OpenClaw plugin `config.promptContext` with `{ configDir: "/home/openclaw/.openclaw/config" }`.
- Does not copy access secrets into the generated MCP provider config.

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/migrate-commands.test.ts -t "runMigrateMcpPortalConfigCommand"
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement migration**

Add:

```ts
export interface MigrateMcpPortalConfigCommandResult {
	readonly migratedZones: readonly string[];
	readonly skippedZones: readonly string[];
	readonly createdFiles: readonly string[];
}
```

The command is:

```bash
agent-vm migrate mcp-portal --config config/system.jsonc
```

It prints migrated zones, created files, and skipped zones.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/migrate-commands.test.ts
```

Expected: PASS.

---

### Task 5: Validate Cross-File Config Consistency

**Files:**
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.test.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`

- [ ] **Step 1: Write failing validation and doctor tests**

Config validation must report:

- Missing `mcp.config.jsonc`.
- Missing `mcp-portal.config.jsonc`.
- Portal agents not declared in `system.jsonc` `zones[].agents`.
- System agents missing portal profile bindings.
- Portal agent bindings that reference missing profiles.

Doctor must report:

- OpenClaw MCP Portal zones with zero agents.
- Stale portal policy in OpenClaw plugin config.
- Config read failures without cascading misleading diagnostics.

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/config-validation.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement validation and doctor checks**

Validation rules:

- If `zone.mcp` exists, both `mcp.config.jsonc` and `mcp-portal.config.jsonc` must load from `zone.mcp.configDir`.
- `zone.agents[].id` and `mcp-portal.config.jsonc.agents` must be the same set for configured portal zones.
- Every portal agent profile must resolve through `resolveMcpPortalProfile`.
- OpenClaw config may contain generated `mcp.servers` entries, but it must not own namespace/tool policy.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/config-validation.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts
```

Expected: PASS.

---

### Task 6: Materialize OpenClaw Runtime Config From MCP Portal Config

**Files:**
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-support.ts`
- Create/modify: `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.ts`
- Create/modify: `packages/agent-vm/src/gateway/mcp-portal-openclaw-materialization.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Modify: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`

- [ ] **Step 1: Write failing materialization tests**

Required tests:

- Builds one OpenClaw MCP server entry per system agent.
- Fails before boot if a system agent has no portal profile binding.
- Uses `mcp-portal.config.jsonc.server.accessHeader` for generated MCP server headers.
- Uses URL shape `http://127.0.0.1:<port>/agents/<agentId>/mcp`.
- Replaces stale OpenClaw plugin config with `{ configDir: "/home/openclaw/.openclaw/config" }`.
- Preserves explicit caller-provided runtime plugin config overrides when supplied.

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected before implementation: FAIL.

- [ ] **Step 2: Implement materialization**

Implementation rules:

- `gateway-interface` carries runtime materialization as data.
- `agent-vm` loads config before starting the VM.
- `openclaw-gateway` writes the final effective `openclaw.json`.
- The plugin receives only runtime process config such as `configDir` and optional `binPath`; namespace/tool policy stays in `mcp-portal.config.jsonc`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS.

---

### Task 7: Update Docs And Generated Manuals

**Files:**
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Update operator-facing docs**

Docs must state:

- New authored config files are JSONC.
- `system.jsonc` declares zone agents and `mcp.configDir`.
- `mcp.config.jsonc` declares upstream MCP providers and credentials.
- `mcp-portal.config.jsonc` declares server access header, agent profile bindings, profiles, policy, logging, prompt context, and cache.
- `openclaw.json` can contain generated portal endpoint servers, but not human-authored portal policy.
- Run `agent-vm migrate mcp-portal` for existing multi-agent OpenClaw configs.
- `$schema` is an editor hint; `schemaVersion` is the migration gate.
- Secure tools profiles are out of scope.

- [ ] **Step 2: Run docs/manual tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

---

### Task 8: Full Verification

**Files:**
- No planned source edits except fixes discovered by verification.

- [ ] **Step 1: Run focused config tests**

Run:

```bash
pnpm vitest run packages/config-contracts/src packages/agent-vm/src/config/system-config.test.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/migrate-commands.test.ts packages/agent-vm/src/operations/config-validation.test.ts packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused gateway materialization tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway packages/openclaw-gateway/src/openclaw-lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Run full check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Run smoke tests**

Run:

```bash
pnpm test:smoke
```

Expected: PASS, or document any known non-portal environment failure with exact failing test name and exit code.

---

## Self-Review

- Spec coverage: This plan covers the shared config package, JSONC config split, local schema artifacts, system-agent registry, migration command, cross-file validation, doctor diagnostics, OpenClaw runtime materialization, generated manuals, and verification.
- Placeholder scan: No placeholder tasks remain; every task names exact files and commands.
- Type consistency: The plan consistently uses `system.jsonc`, `mcp.config.jsonc`, `mcp-portal.config.jsonc`, `zones[].agents[]`, `zones[].mcp.configDir`, `providers`, `profiles`, `enabledNamespaces`, `enabledToolsByNamespace`, and `hiddenToolsByNamespace`.
