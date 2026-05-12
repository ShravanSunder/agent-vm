# MCP Portal Schema Config Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move MCP Portal agent/profile policy into a dedicated zone MCP config file, make `system.json` the canonical agent registry/reference surface, and provide a tested migration for generated and existing agent configs.

**Architecture:** `system.json` owns zone identity, the canonical `zones[].agents` list, Tool VM profile selection, and a pointer to a deployment-owned MCP config file. The separate MCP config file owns MCP profiles, namespace/tool enablement, approval, logging, prompt context, and upstream MCP server policy. The loader validates cross-file references so MCP profiles can only target agents declared by the zone.

**Tech Stack:** TypeScript, Zod 4, JSONC config loading, `jsonc-parser` migrations, cmd-ts CLI subcommands, Vitest, OXC/Oxfmt.

---

## Existing Schema System

The repo already has the building blocks for this:

- `packages/agent-vm/src/config/system-config.ts` is the canonical Zod schema and cross-field validator for `config/system.json` / `system.jsonc`.
- `packages/agent-vm/src/config/json-config-file.ts` loads strict JSON or JSONC-like deployment config.
- `packages/agent-vm/src/operations/config-validation.ts` validates system config plus referenced gateway config before boot.
- `packages/agent-vm/src/operations/doctor.ts` and `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts` report actionable deployment diagnostics.
- `packages/agent-vm/src/cli/migrate-commands.ts` already uses `jsonc-parser` edits for `agent-vm migrate images`; MCP migration should follow that pattern.
- `packages/agent-vm/src/cli/init-command.ts` currently writes OpenClaw `agents.list` and generated portal `mcp.servers` entries directly into `openclaw.json`; the schema update should move agent/profile policy to `system.json` + `mcp.json` while keeping OpenClaw runtime materialization generated from those sources.

## Target Config Shape

`system.json` becomes the zone-level reference:

```json
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
			"agents": ["sun", "shravan", "alevtina"],
			"defaultToolVmProfile": "standard",
			"agentToolVmProfiles": {
				"shravan": "tools-dev",
				"alevtina": "tools-light"
			},
			"mcp": {
				"config": "./gateways/shravan/mcp.json",
				"defaultProfile": "default",
				"agentProfiles": {
					"sun": "research",
					"shravan": "builder",
					"alevtina": "reviewer"
				}
			}
		}
	]
}
```

`config/gateways/<zone>/mcp.json` owns MCP Portal policy:

```json
{
	"$schema": "./schemas/mcp-portal.schema.json",
	"schemaVersion": 1,
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

- `$schema` is an editor/tooling hint. It is never used as the runtime migration
  gate and must not be required for hand-authored JSONC files to load. Use
  deployment-local relative schema paths; do not require an `agent-vm.dev`
  website or GitHub Pages hosting.
- `schemaVersion` is the runtime/migration gate. It is required in newly
  scaffolded `system.jsonc` and `mcp.json`, and migration adds it to existing
  system configs when missing.
- Empty `enabledNamespaces` means no namespaces by default. Explicit allow-all can be represented later, but the safe v1 schema is deny-all unless names are listed.
- `enabledToolsByNamespace` narrows tools within an enabled namespace. Missing namespace entries mean all tools in that enabled namespace are available unless hidden.
- `hiddenToolsByNamespace` removes tools after namespace/tool allow selection and before catalog/index construction.
- `logging.enabled` controls MCP Portal audit logging only. It is not content filtering.
- MCP config references profile names only. Agent IDs remain in `system.json`.
- Secure tools profiles are not part of this plan.

## File Structure

- Create `packages/agent-vm/src/config/mcp-config.ts`
  - Zod schema and loader for deployment MCP config files.
- Create `packages/agent-vm/src/config/mcp-config.test.ts`
  - Unit tests for MCP profile parsing, defaults, extension, deny-all, and malformed config.
- Create `packages/agent-vm/src/config/config-schema-artifacts.ts`
  - Canonical schema IDs, schema versions, and JSON Schema artifact builders for
    generated config files.
- Create `packages/agent-vm/src/config/config-schema-artifacts.test.ts`
  - Unit tests that exported JSON Schemas include the expected `$id`,
    `schemaVersion`, and root properties.
- Modify `packages/agent-vm/src/config/system-config.ts`
  - Add root `schemaVersion`, `zones[].agents`, and `zones[].mcp`.
  - Validate OpenClaw-only fields.
  - Validate agent-keyed maps reference `zones[].agents`.
  - Resolve `mcp.config` relative to `system.json`.
- Modify `packages/agent-vm/src/config/system-config.test.ts`
  - Add schema/cross-field tests for agents and MCP config references.
- Modify `packages/gateway-interface/src/gateway-lifecycle.ts`
  - Carry normalized `agents`, `agentToolVmProfiles`, and MCP config reference into lifecycle zone config.
- Modify `packages/agent-vm/src/gateway/gateway-zone-support.ts`
  - Map system config zones into the expanded gateway interface shape.
- Modify `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
  - Parse profile-derived portal config rather than old global `enabledNamespacesByAgent`.
- Modify `packages/openclaw-mcp-portal-plugin/src/portal-agent-registry.ts`
  - Stop reading canonical agent IDs from OpenClaw `agents.list`; receive system/gateway agent records.
- Modify `packages/agent-vm/src/cli/init-command.ts`
  - Scaffold `zones[].agents`, `zones[].mcp`, and `config/gateways/<zone>/mcp.json`.
- Modify `packages/agent-vm/src/cli/init-command.test.ts`
  - Assert generated system config and MCP config are coherent.
- Modify `packages/agent-vm/src/cli/migrate-commands.ts`
  - Add `runMigrateMcpPortalConfigCommand`.
- Modify `packages/agent-vm/src/cli/commands/migrate-definition.ts`
  - Add `agent-vm migrate mcp-portal`.
- Modify `packages/agent-vm/src/cli/migrate-commands.test.ts`
  - Cover JSONC-preserving migration from current OpenClaw agent/plugin config.
- Modify `packages/agent-vm/src/operations/config-validation.ts`
  - Load and validate referenced `mcp.config` files.
- Modify `packages/agent-vm/src/operations/config-validation.test.ts`
  - Cover missing and malformed MCP config.
- Modify `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
  - Validate agent/profile consistency and report stale OpenClaw-owned portal policy.
- Modify `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
  - Cover zero agents, unknown MCP profile, and stale OpenClaw policy diagnostics.
- Modify docs:
  - `docs/reference/configuration/system-json.md`
  - `docs/subsystems/mcp-portal.md`
  - `docs/architecture/openclaw-gateway.md`
  - `packages/agent-vm/src/cli/manual-templates.ts`
  - `packages/agent-vm/src/cli/manual-templates.test.ts`

---

### Task 1: Add Config Schema Artifacts And Version Constants

**Files:**
- Create: `packages/agent-vm/src/config/config-schema-artifacts.ts`
- Create: `packages/agent-vm/src/config/config-schema-artifacts.test.ts`

- [ ] **Step 1: Write failing schema artifact tests**

Add tests:

```ts
test('exports stable schema IDs and version constants', () => {
	expect(agentVmConfigSchemaIds.system).toBe('agent-vm:system:1');
	expect(agentVmConfigSchemaIds.mcpPortal).toBe('agent-vm:mcp-portal:1');
	expect(agentVmConfigSchemaPaths.systemFromSystemConfig).toBe('./schemas/system.schema.json');
	expect(agentVmConfigSchemaPaths.mcpPortalFromGatewayConfig).toBe('./schemas/mcp-portal.schema.json');
	expect(agentVmConfigSchemaVersions.system).toBe(1);
	expect(agentVmConfigSchemaVersions.mcpPortal).toBe(1);
});

test('builds JSON Schema artifacts with root schemaVersion', () => {
	const schemas = buildAgentVmConfigJsonSchemas();

	expect(schemas.system.$id).toBe(agentVmConfigSchemaIds.system);
	expect(schemas.system.properties.schemaVersion.const).toBe(1);
	expect(schemas.mcpPortal.$id).toBe(agentVmConfigSchemaIds.mcpPortal);
	expect(schemas.mcpPortal.properties.schemaVersion.const).toBe(1);
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/config-schema-artifacts.test.ts
```

Expected: FAIL because the artifact module does not exist yet.

- [ ] **Step 2: Implement schema IDs and builders**

Implement constants:

```ts
export const agentVmConfigSchemaIds = {
	system: 'agent-vm:system:1',
	mcpPortal: 'agent-vm:mcp-portal:1',
} as const;

export const agentVmConfigSchemaPaths = {
	systemFromSystemConfig: './schemas/system.schema.json',
	mcpPortalFromGatewayConfig: './schemas/mcp-portal.schema.json',
} as const;

export const agentVmConfigSchemaVersions = {
	system: 1,
	mcpPortal: 1,
} as const;
```

Build JSON Schema artifacts with `z.toJSONSchema(..., { target: 'draft-07', io: 'input' })`.
The artifacts are for editor/tooling hints and tests; runtime validation remains
the Zod loader.

- [ ] **Step 3: Run focused test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/config-schema-artifacts.test.ts
```

Expected: PASS.

---

### Task 2: Add MCP Config Schema

**Files:**
- Create: `packages/agent-vm/src/config/mcp-config.ts`
- Create: `packages/agent-vm/src/config/mcp-config.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add tests proving:

```ts
test('defaults profiles to deny all namespaces', async () => {
	const loadedConfig = await loadMcpPortalConfig(configPath);

	expect(loadedConfig.schemaVersion).toBe(1);
	expect(loadedConfig.profiles.default.enabledNamespaces).toEqual([]);
	expect(resolveMcpPortalProfile(loadedConfig, 'default').enabledNamespaces).toEqual([]);
});

test('resolves profile inheritance without mutating base profiles', async () => {
	const resolvedBuilder = resolveMcpPortalProfile(loadedConfig, 'builder');
	const resolvedDefault = resolveMcpPortalProfile(loadedConfig, 'default');

	expect(resolvedBuilder.enabledNamespaces).toEqual(['github', 'linear']);
	expect(resolvedDefault.enabledNamespaces).toEqual([]);
});

test('rejects unknown inherited profiles', async () => {
	await expect(loadMcpPortalConfig(configPath)).rejects.toThrow(/unknown MCP profile 'missing'/u);
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/mcp-config.test.ts
```

Expected: FAIL because `mcp-config.ts` does not exist yet.

- [ ] **Step 2: Implement schema and loader**

Implement:

```ts
export const mcpPortalProfileSchema = z.object({
	extends: z.string().min(1).optional(),
	enabledNamespaces: z.array(z.string().min(1)).default([]),
	enabledToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
	hiddenToolsByNamespace: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
	logging: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
	promptContext: z.object({
		enabled: z.boolean().default(true),
		maxNamespaces: z.number().int().positive().default(12),
	}).default({ enabled: true, maxNamespaces: 12 }),
	cache: z.object({
		catalogTtlMs: z.number().int().positive().default(60_000),
	}).default({ catalogTtlMs: 60_000 }),
	approval: portalApprovalConfigSchema.default({
		allowWithoutApprovalTools: [],
		alwaysAskTools: [],
		annotationPolicy: 'destructive-requires-approval',
		trustedAnnotationNamespaces: [],
		writeTools: [],
	}),
}).strict();
```

The root config schema must include:

```ts
export const mcpPortalConfigSchema = z.object({
	$schema: z.string().min(1).optional(),
	schemaVersion: z.literal(agentVmConfigSchemaVersions.mcpPortal),
	profiles: z.record(z.string().min(1), mcpPortalProfileSchema).min(1),
}).strict();
```

Use imports at file top. Use `z.infer`. Do not use `any` or non-null assertions.

- [ ] **Step 3: Run focused test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/mcp-config.test.ts
```

Expected: PASS.

---

### Task 3: Add System Config Agent And MCP References

**Files:**
- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`

- [ ] **Step 1: Write failing system schema tests**

Add tests proving:

```ts
test('loads OpenClaw zone agents and MCP config reference', async () => {
	const loadedConfig = await loadSystemConfig(configPath);

	expect(loadedConfig.schemaVersion).toBe(1);
	expect(loadedConfig.zones[0].agents).toEqual(['shravan', 'sun']);
	expect(loadedConfig.zones[0].mcp).toEqual({
		config: path.join(targetDirectory, 'config', 'gateways', 'shravan', 'mcp.json'),
		defaultProfile: 'default',
		agentProfiles: { shravan: 'builder' },
	});
});

test('rejects agent keyed profile maps for agents not declared in zones agents', async () => {
	await expect(loadSystemConfig(configPath)).rejects.toThrow(/references unknown agent 'ghost'/u);
});

test('rejects worker zones declaring MCP portal references', async () => {
	await expect(loadSystemConfig(configPath)).rejects.toThrow(/Worker zone 'worker' must not declare mcp/u);
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Expected: FAIL on unknown fields.

- [ ] **Step 2: Add schema fields**

Add:

```ts
const zoneMcpReferenceSchema = z.object({
	config: z.string().min(1),
	defaultProfile: z.string().min(1).optional(),
	agentProfiles: z.record(agentIdSchema, z.string().min(1)).default({}),
}).strict();
```

Add to zone schema:

```ts
schemaVersion: z.literal(agentVmConfigSchemaVersions.system).default(1),
agents: z.array(agentIdSchema).default([]),
mcp: zoneMcpReferenceSchema.optional(),
```

Cross-field rules:

- Existing system configs without `schemaVersion` continue to load for this
  migration release, but new scaffolds and `agent-vm migrate mcp-portal` write
  `schemaVersion: 1`.
- Worker zones must not declare `agents`, `agentToolVmProfiles`, `agentSandboxSeeds`, or `mcp`.
- OpenClaw zones must declare `agents` explicitly. Empty is allowed only when the operator does not want per-agent MCP Portal bindings.
- Every key in `agentToolVmProfiles`, `agentSandboxSeeds`, `gateway.authProfilesByAgent`, and `mcp.agentProfiles` must exist in `zones[].agents`.
- `mcp.defaultProfile` and `mcp.agentProfiles` values are names only; existence is checked when the referenced `mcp.config` file is loaded.

- [ ] **Step 3: Resolve MCP config paths**

In `resolveRelativePaths`, resolve:

```ts
...(zone.mcp ? { mcp: { ...zone.mcp, config: resolvePath(zone.mcp.config) } } : {}),
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config/system-config.test.ts
```

Expected: PASS.

---

### Task 4: Carry Normalized Agents Through Gateway Interface

**Files:**
- Modify: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-support.ts`
- Modify: relevant tests that construct `GatewayZoneConfig`

- [ ] **Step 1: Write failing mapper test**

Add a test to `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts` or `gateway-zone-support.test.ts` if created:

```ts
test('maps OpenClaw zone agents and MCP reference into lifecycle zone config', () => {
	const lifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone);

	expect(lifecycleZone.agents).toEqual(['shravan']);
	expect(lifecycleZone.agentToolVmProfiles).toEqual({ shravan: 'tools-dev' });
	expect(lifecycleZone.mcp).toEqual({
		config: '/repo/config/gateways/shravan/mcp.json',
		defaultProfile: 'default',
		agentProfiles: { shravan: 'builder' },
	});
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected: FAIL because the interface does not expose these fields.

- [ ] **Step 2: Extend gateway interface**

Add to `GatewayZoneConfig`:

```ts
readonly agents: readonly string[];
readonly agentToolVmProfiles?: Readonly<Record<string, string>>;
readonly mcp?: {
	readonly config: string;
	readonly defaultProfile?: string;
	readonly agentProfiles: Readonly<Record<string, string>>;
};
```

- [ ] **Step 3: Map system config into lifecycle zone**

Update `mapSystemGatewayZoneToLifecycleZone` to include:

```ts
agents: zone.agents,
...(zone.agentToolVmProfiles ? { agentToolVmProfiles: zone.agentToolVmProfiles } : {}),
...(zone.mcp ? { mcp: zone.mcp } : {}),
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/gateway packages/gateway-interface
```

Expected: PASS.

---

### Task 5: Scaffold Separate MCP Config Files

**Files:**
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Write failing scaffold tests**

Add assertions to the existing OpenClaw multi-agent scaffold test:

```ts
expect(systemConfig.zones[0].agents).toEqual(['sun', 'shravan', 'alevtina']);
expect(systemConfig.$schema).toBe('./schemas/system.schema.json');
expect(systemConfig.schemaVersion).toBe(1);
expect(systemConfig.zones[0].mcp).toEqual({
	config: './gateways/my-zone/mcp.json',
	defaultProfile: 'default',
	agentProfiles: {
		sun: 'default',
		shravan: 'default',
		alevtina: 'default',
	},
});

const mcpConfig = await loadJsonConfigFile(path.join(targetDir, 'config', 'gateways', 'my-zone', 'mcp.json'));
expect(mcpConfig).toMatchObject({
	$schema: './schemas/mcp-portal.schema.json',
	schemaVersion: 1,
	profiles: {
		default: {
			enabledNamespaces: [],
			logging: { enabled: false },
		},
	},
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: FAIL because the file is not generated.

- [ ] **Step 2: Generate MCP config**

Add `defaultMcpPortalConfig()` in `init-command.ts` and write it beside `openclaw.json`:

```ts
const defaultMcpPortalConfig = (): object => ({
	schemaVersion: 1,
	profiles: {
		default: {
			enabledNamespaces: [],
			enabledToolsByNamespace: {},
			hiddenToolsByNamespace: {},
			logging: { enabled: false },
			promptContext: { enabled: true, maxNamespaces: 12 },
			cache: { catalogTtlMs: 60_000 },
			approval: {
				allowWithoutApprovalTools: [],
				alwaysAskTools: [],
				annotationPolicy: 'destructive-requires-approval',
				trustedAnnotationNamespaces: [],
				writeTools: [],
			},
		},
	},
});
```

`openclaw.json` may still contain generated loopback portal `mcp.servers` entries because OpenClaw consumes them at runtime. It must not contain the human-authored per-agent namespace/profile policy.

- [ ] **Step 3: Run focused test**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/init-command.test.ts
```

Expected: PASS.

---

### Task 6: Add MCP Portal Config Migration

**Files:**
- Modify: `packages/agent-vm/src/cli/migrate-commands.ts`
- Modify: `packages/agent-vm/src/cli/commands/migrate-definition.ts`
- Modify: `packages/agent-vm/src/cli/migrate-commands.test.ts`

- [ ] **Step 1: Write failing migration tests**

Add tests:

```ts
describe('runMigrateMcpPortalConfigCommand', () => {
	it('creates mcp.json and system zone references from existing OpenClaw agents', async () => {
		const result = await runMigrateMcpPortalConfigCommand({ systemConfigPath });

		expect(result.migratedZones).toEqual(['shravan']);
expect(await loadJsonConfigFile(systemConfigPath)).toMatchObject({
	$schema: './schemas/system.schema.json',
	schemaVersion: 1,
	zones: [
				{
					id: 'shravan',
					agents: ['sun', 'shravan'],
					mcp: {
						config: './gateways/shravan/mcp.json',
						defaultProfile: 'default',
						agentProfiles: { sun: 'default', shravan: 'default' },
					},
				},
			],
		});
expect(await loadJsonConfigFile(mcpConfigPath)).toMatchObject({
	$schema: './schemas/mcp-portal.schema.json',
	schemaVersion: 1,
			profiles: { default: { enabledNamespaces: [] } },
		});
	});

	it('preserves JSONC comments in system config while adding MCP references', async () => {
		const updatedText = await readFile(systemConfigPath, 'utf8');

		expect(updatedText).toContain('// deployment-owned comment');
		expect(updatedText).toContain('"mcp"');
	});
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/migrate-commands.test.ts
```

Expected: FAIL because `runMigrateMcpPortalConfigCommand` does not exist.

- [ ] **Step 2: Implement migration**

Use `jsonc-parser` `modify` / `applyEdits`, following `runMigrateImagesCommand`.

Migration behavior:

- Read `config/system.json` or `system.jsonc`.
- For each OpenClaw zone, read its `gateway.config` OpenClaw config.
- Extract agent IDs from `openclawConfig.agents.list[].id`.
- Add `zones[index].agents` if missing.
- Add `zones[index].mcp` if missing.
- Add root `$schema` and `schemaVersion: 1` to `system.jsonc` if missing.
- Create `config/gateways/<zone>/mcp.json` if missing.
- Do not overwrite an existing `mcp.json`.
- Do not migrate secure tools fields.
- Do not copy generated loopback portal binding secrets into `mcp.json`.

Return:

```ts
export interface MigrateMcpPortalConfigCommandResult {
	readonly migratedZones: readonly string[];
	readonly skippedZones: readonly string[];
	readonly createdFiles: readonly string[];
}
```

- [ ] **Step 3: Add CLI command**

Add:

```text
agent-vm migrate mcp-portal --config config/system.json
```

Output:

```text
migrated MCP portal zones: shravan
created MCP config files: config/gateways/shravan/mcp.json
skipped MCP portal zones: none
```

- [ ] **Step 4: Run migration tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/cli/migrate-commands.test.ts packages/agent-vm/src/cli/commands/command-definition-support.test.ts
```

Expected: PASS.

---

### Task 7: Validate Cross-File MCP Profile References

**Files:**
- Modify: `packages/agent-vm/src/operations/config-validation.ts`
- Modify: `packages/agent-vm/src/operations/config-validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Add tests:

```ts
it('reports missing referenced MCP config files', async () => {
	const result = await runConfigValidation({ systemConfig });

	expect(result.ok).toBe(false);
	expect(result.checks).toContainEqual({
		name: 'mcp-config:shravan',
		ok: false,
		hint: expect.stringContaining('Missing'),
	});
});

it('reports agent profiles that reference missing MCP profiles', async () => {
	const result = await runConfigValidation({ systemConfig });

	expect(result.ok).toBe(false);
	expect(result.checks).toContainEqual({
		name: 'mcp-profile:shravan:agent:shravan',
		ok: false,
		hint: "Agent 'shravan' references unknown MCP profile 'builder'.",
	});
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/config-validation.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement validation**

For each OpenClaw zone with `zone.mcp`:

- Check `zone.mcp.config` exists.
- Load `loadMcpPortalConfig(zone.mcp.config)`.
- Check `zone.mcp.defaultProfile` exists when present.
- Check every `zone.mcp.agentProfiles[agentId]` value exists.
- Check every `zone.mcp.agentProfiles` key exists in `zone.agents`.

- [ ] **Step 3: Run validation tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/config-validation.test.ts
```

Expected: PASS.

---

### Task 8: Wire Plugin Policy From MCP Profiles

**Files:**
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-config.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/portal-agent-registry.ts`
- Modify: `packages/openclaw-mcp-portal-plugin/src/plugin-registration.ts`
- Modify: matching plugin tests

- [ ] **Step 1: Write failing plugin config tests**

Add tests proving:

```ts
test('builds per-agent portal configs from system agent MCP profile mapping', () => {
	const registry = resolvePortalAgentsFromGatewayZone(gatewayZone);
	const portalConfig = resolvePortalConfigForAgent({
		agentId: 'shravan',
		mcpConfig,
		zoneMcpReference: gatewayZone.mcp,
	});

	expect(registry).toEqual([{ id: 'shravan' }]);
	expect(portalConfig.enabledNamespaces).toEqual(['github', 'linear']);
});
```

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src/portal-config.test.ts packages/openclaw-mcp-portal-plugin/src/portal-agent-registry.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Replace old global exposure config**

Map resolved profile fields into the existing portal access policy shape:

- `enabledNamespaces`
- `enabledToolsByNamespace`
- `hiddenToolsByNamespace`
- `logging`
- `promptContext`
- `cache`
- `approval`

Keep backward compatibility only through the migration command, not through long-lived dual runtime paths.

- [ ] **Step 3: Run plugin tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-portal-plugin/src
```

Expected: PASS.

---

### Task 9: Update Doctor And Docs

**Files:**
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- Modify: `packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts`
- Modify: `docs/reference/configuration/system-json.md`
- Modify: `docs/subsystems/mcp-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Write failing doctor tests**

Add tests:

```ts
it('flags OpenClaw MCP Portal config with zero agents', () => {
	const result = runOpenClawDeploymentDoctor(config);

	expect(result.checks).toContainEqual({
		name: 'mcp-portal-agents:shravan',
		ok: false,
		hint: 'Declare zones[].agents or run agent-vm migrate mcp-portal.',
	});
});

it('flags stale portal policy in OpenClaw plugin config', () => {
	const result = runOpenClawDeploymentDoctor(config);

	expect(result.checks).toContainEqual({
		name: 'mcp-portal-config-source:shravan',
		ok: false,
		hint: 'Move MCP Portal namespace/tool policy to the zone mcp.config file.',
	});
});
```

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement doctor checks**

Checks:

- `zones[].agents` present for OpenClaw MCP Portal zones.
- `zones[].mcp.config` exists when portal plugin is enabled.
- All `agentProfiles` reference declared agents.
- OpenClaw plugin config does not own `enabledNamespaces`, `enabledNamespacesByAgent`, or `hiddenToolsByAgent`.
- Generated loopback portal `mcp.servers` entries remain allowed in OpenClaw config.

- [ ] **Step 3: Update docs/manuals**

Docs must state:

- `system.json` references agents and profile names.
- Generated `system.jsonc` and `mcp.json` include `$schema` and `schemaVersion`.
- `$schema` is an editor hint; `schemaVersion` is the migration gate.
- MCP Portal profile policy lives in `mcp.json`.
- `openclaw.json` can contain generated portal binding servers but not the human-authored portal policy.
- Run `agent-vm migrate mcp-portal` for existing multi-agent configs.
- Secure tools profiles are intentionally out of scope.

- [ ] **Step 4: Run docs/manual tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/operations/openclaw-deployment-doctor.test.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected: PASS.

---

### Task 10: Full Verification

**Files:**
- No planned source edits except fixes discovered by verification.

- [ ] **Step 1: Run focused schema and migration tests**

Run:

```bash
pnpm vitest run packages/agent-vm/src/config packages/agent-vm/src/cli/migrate-commands.test.ts packages/agent-vm/src/operations/config-validation.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run portal/plugin focused tests**

Run:

```bash
pnpm vitest run packages/mcp-portal/src packages/openclaw-mcp-portal-plugin/src
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
pnpm -r build
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

- Spec coverage: This plan covers the schema split, separate MCP config file, system-agent canonical registry, migration command, generated init updates, cross-file validation, doctor diagnostics, and tests for agent updates.
- Placeholder scan: No placeholder tasks remain; every task names exact files and commands.
- Type consistency: The plan consistently uses `agents`, `mcp.config`, `mcp.defaultProfile`, `mcp.agentProfiles`, `profiles`, `enabledNamespaces`, `enabledToolsByNamespace`, and `hiddenToolsByNamespace`.
