# MCP Capability Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenClaw gateway plugin that consolidates configured MCP servers and local skill docs behind two progressive-disclosure tools: `mcp_portal_search` and `mcp_portal_execute`.

**Architecture:** The portal runs in the gateway process, owns upstream MCP auth/config, and exposes a small search/execute surface to agents. This stays separate from `gondolin-secret-source`: the portal brokers MCP capabilities, while Gondolin secret sources broker Tool VM HTTP-mediated secrets.

**Tech Stack:** TypeScript, OpenClaw plugin `api.registerTool`/`api.registerHook('before_tool_call')`, official MCP TypeScript SDK client transports, Zod, Vitest.

---

## Current Evidence To Preserve

- OpenClaw plugins can register tools with `api.registerTool(...)`; the existing agent-vm plugin already registers `zone_git_push`.
- OpenClaw plugin hooks use `api.registerHook(...)`; `before_tool_call` can return `requireApproval` and OpenClaw routes it through the existing approval UI and `/approve`.
- OpenClaw already supports `mcp.servers` with stdio and remote HTTP/SSE server configs. The portal must read that existing gateway registry instead of introducing a second `mcpServers` config surface.
- The official MCP TypeScript SDK supports clients with `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, and `SSEClientTransport`.
- The portal should not expose upstream MCP server env vars, auth headers, or raw config values in search results.

## Non-Goals

- Do not implement arbitrary JavaScript Code Mode execution in this plan. The v1 portal is deterministic search plus direct tool execution by capability ID. Code execution can be a later design after choosing an isolate boundary.
- Do not put Tool VM credentials into the portal. Tool VM secrets remain under `gondolin-secret-source`.
- Do not replace OpenClaw's existing MCP support. This plugin is an agent-visible progressive-disclosure proxy for selected servers.

## File Structure

Create a new package:

- `packages/openclaw-mcp-capability-portal-plugin/package.json`
  - Publishable OpenClaw plugin package.
- `packages/openclaw-mcp-capability-portal-plugin/tsconfig.json`
  - Package TypeScript config.
- `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json`
  - Build TypeScript config.
- `packages/openclaw-mcp-capability-portal-plugin/tsdown.config.ts`
  - ESM build config.
- `packages/openclaw-mcp-capability-portal-plugin/openclaw.plugin.json`
  - OpenClaw plugin manifest and config schema.
- `packages/openclaw-mcp-capability-portal-plugin/src/index.ts`
  - Exports plugin registration.
- `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts`
  - Registers portal tools and approval hook.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts`
  - Parses portal-only plugin config: skills directories, enabled server IDs, and approval metadata.
- `packages/openclaw-mcp-capability-portal-plugin/src/capability-types.ts`
  - Defines capability IDs and portal result types.
- `packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.ts`
  - Loads local markdown skills into searchable capabilities.
- `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts`
  - Connects to configured upstream MCP servers and calls tools.
- `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts`
  - Normalizes OpenClaw's existing `api.config.mcp.servers` records into portal runtime records without exposing env/header values to agents.
- `packages/openclaw-mcp-capability-portal-plugin/src/capability-index.ts`
  - Builds/searches the merged skill and MCP capability index.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts`
  - Implements `mcp_portal_search` and `mcp_portal_execute`.
- `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts`
  - Uses `before_tool_call` to ask on configured capability IDs.
- `packages/openclaw-mcp-capability-portal-plugin/src/*.test.ts`
  - Unit tests for parser, index, runtime wrapper, tools, and approval hook.

Modify:

- `pnpm-workspace.yaml`
  - Includes the new package if the workspace does not already include `packages/*`.
- `package.json`
  - No script change if recursive package scripts already cover `packages/*`.
- `docs/subsystems/secrets-and-credentials.md`
  - Notes that MCP portal auth lives in OpenClaw gateway `mcp.servers`, not in Tool VM env.
- `docs/reference/configuration/system-json.md`
  - Links to OpenClaw plugin config example if the docs already contain plugin config guidance.
- `docs/architecture/openclaw-gateway.md`
  - Adds gateway-side capability portal diagram.

---

### Task 1: Scaffold The Separate Portal Plugin Package

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/package.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsconfig.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/tsdown.config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/openclaw.plugin.json`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/index.ts`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Create package metadata**

Create `packages/openclaw-mcp-capability-portal-plugin/package.json`:

```json
{
	"name": "@agent-vm/openclaw-mcp-capability-portal-plugin",
	"version": "0.0.58",
	"description": "OpenClaw plugin that exposes configured MCP servers through a progressive-disclosure capability portal.",
	"homepage": "https://github.com/ShravanSunder/agent-vm#readme",
	"bugs": {
		"url": "https://github.com/ShravanSunder/agent-vm/issues"
	},
	"license": "MIT",
	"author": "Shravan Sunder <ShravanSunder@users.noreply.github.com>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ShravanSunder/agent-vm.git",
		"directory": "packages/openclaw-mcp-capability-portal-plugin"
	},
	"files": [
		"dist"
	],
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"publishConfig": {
		"access": "public"
	},
	"scripts": {
		"build": "tsdown && cp openclaw.plugin.json dist/",
		"prepack": "pnpm -C ../.. build",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"@modelcontextprotocol/sdk": "^1.24.0",
		"zod": "^4.1.13"
	}
}
```

- [ ] **Step 2: Add TypeScript build files**

Create `packages/openclaw-mcp-capability-portal-plugin/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"include": ["src/**/*.ts"],
	"exclude": ["dist"]
}
```

Create `packages/openclaw-mcp-capability-portal-plugin/tsconfig.build.json`:

```json
{
	"extends": "./tsconfig.json",
	"exclude": ["dist", "src/**/*.test.ts"]
}
```

Create `packages/openclaw-mcp-capability-portal-plugin/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: 'src/index.ts',
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
```

- [ ] **Step 3: Add the OpenClaw manifest**

Create `packages/openclaw-mcp-capability-portal-plugin/openclaw.plugin.json`:

```json
{
	"id": "mcp-capability-portal",
	"name": "MCP Capability Portal",
	"description": "Gateway-side MCP capability portal with search and execute tools.",
	"activation": {
		"onStartup": true
	},
	"contracts": {
		"tools": ["mcp_portal_search", "mcp_portal_execute"]
	},
	"configSchema": {
		"type": "object",
		"additionalProperties": false,
		"properties": {
			"skillsDirs": {
				"type": "array",
				"items": { "type": "string", "minLength": 1 }
			},
			"enabledServerIds": {
				"type": "array",
				"items": { "type": "string", "minLength": 1 }
			},
			"approval": {
				"type": "object",
				"additionalProperties": false,
				"properties": {
					"alwaysAskCapabilityIds": {
						"type": "array",
						"items": { "type": "string", "minLength": 1 }
					},
					"writeCapabilityIds": {
						"type": "array",
						"items": { "type": "string", "minLength": 1 }
					}
				}
			}
		}
	}
}
```

- [ ] **Step 4: Add the package entry point**

Create `packages/openclaw-mcp-capability-portal-plugin/src/index.ts`:

```ts
import plugin from './plugin-registration.js';

export default plugin;
```

- [ ] **Step 5: Verify workspace inclusion**

Run:

```bash
cat pnpm-workspace.yaml
```

If the workspace already includes `packages/*`, no edit is needed. If it lists packages explicitly, add:

```yaml
  - packages/openclaw-mcp-capability-portal-plugin
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
pnpm install
```

Expected: lockfile updates with `@modelcontextprotocol/sdk`.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add pnpm-lock.yaml pnpm-workspace.yaml packages/openclaw-mcp-capability-portal-plugin
git commit -m "feat: scaffold mcp capability portal plugin

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Parse Portal Config

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.test.ts`

- [ ] **Step 1: Write parser tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parsePortalConfig } from './portal-config.js';

describe('parsePortalConfig', () => {
	it('parses portal metadata without accepting MCP server definitions', () => {
		expect(
			parsePortalConfig({
				approval: {
					alwaysAskCapabilityIds: ['mcp:calendar:create_event'],
					writeCapabilityIds: ['mcp:calendar:delete_event'],
				},
				enabledServerIds: ['calendar', 'readwise'],
				skillsDirs: ['/opt/agent-vm/skills'],
			}),
		).toEqual({
			approval: {
				alwaysAskCapabilityIds: ['mcp:calendar:create_event'],
				writeCapabilityIds: ['mcp:calendar:delete_event'],
			},
			enabledServerIds: ['calendar', 'readwise'],
			skillsDirs: ['/opt/agent-vm/skills'],
		});
	});

	it('defaults to all OpenClaw MCP servers, no skills, and no approval overrides', () => {
		expect(parsePortalConfig({})).toEqual({
			approval: {
				alwaysAskCapabilityIds: [],
				writeCapabilityIds: [],
			},
			enabledServerIds: [],
			skillsDirs: [],
		});
	});

	it('rejects a duplicate mcpServers surface in plugin config', () => {
		expect(() =>
			parsePortalConfig({
				mcpServers: {
					calendar: {
						command: 'node',
					},
				},
			}),
		).toThrow();
	});
});
```

- [ ] **Step 2: Run parser tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-config.test.ts
```

Expected: FAIL because `portal-config.ts` does not exist.

- [ ] **Step 3: Implement parser**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts`:

```ts
import { z } from 'zod';

const portalConfigSchema = z
	.object({
		approval: z
			.object({
				alwaysAskCapabilityIds: z.array(z.string().min(1)).default([]),
				writeCapabilityIds: z.array(z.string().min(1)).default([]),
			})
			.strict()
			.default({
				alwaysAskCapabilityIds: [],
				writeCapabilityIds: [],
			}),
		enabledServerIds: z.array(z.string().min(1)).default([]),
		skillsDirs: z.array(z.string().min(1)).default([]),
	})
	.strict();

export type PortalConfig = z.infer<typeof portalConfigSchema>;

export function parsePortalConfig(value: unknown): PortalConfig {
	return portalConfigSchema.parse(value ?? {});
}
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/portal-config.ts packages/openclaw-mcp-capability-portal-plugin/src/portal-config.test.ts
git commit -m "feat: parse mcp portal config

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Define Capability Types And Search Index

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/capability-types.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/capability-index.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/capability-index.test.ts`

- [ ] **Step 1: Write index tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/capability-index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createCapabilityIndex } from './capability-index.js';
import type { PortalCapability } from './capability-types.js';

const capabilities: readonly PortalCapability[] = [
	{
		description: 'List calendar events for a day.',
		id: 'mcp:calendar:list_events',
		kind: 'mcp-tool',
		source: 'calendar',
		title: 'List events',
	},
	{
		description: 'Create a calendar event.',
		id: 'mcp:calendar:create_event',
		inputSchema: {
			type: 'object',
			properties: {
				summary: { type: 'string' },
			},
		},
		kind: 'mcp-tool',
		source: 'calendar',
		title: 'Create event',
	},
	{
		description: 'How to use Readwise from agents.',
		id: 'skill:readwise',
		kind: 'skill',
		source: '/skills/readwise.md',
		title: 'Readwise skill',
	},
];

describe('createCapabilityIndex', () => {
	it('searches capabilities by title, description, source, and id', () => {
		const index = createCapabilityIndex(capabilities);

		expect(index.search({ query: 'calendar create', limit: 5 })).toEqual([
			expect.objectContaining({
				id: 'mcp:calendar:create_event',
			}),
			expect.objectContaining({
				id: 'mcp:calendar:list_events',
			}),
		]);
	});

	it('looks up a capability by id', () => {
		const index = createCapabilityIndex(capabilities);

		expect(index.getById('skill:readwise')).toEqual(capabilities[2]);
	});

	it('returns all capabilities for empty query up to the limit', () => {
		const index = createCapabilityIndex(capabilities);

		expect(index.search({ limit: 2 })).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run index tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/capability-index.test.ts
```

Expected: FAIL because the files do not exist.

- [ ] **Step 3: Implement capability types**

Create `packages/openclaw-mcp-capability-portal-plugin/src/capability-types.ts`:

```ts
export type PortalCapabilityKind = 'mcp-tool' | 'skill';

export interface PortalCapability {
	readonly description: string;
	readonly id: string;
	readonly inputSchema?: Record<string, unknown>;
	readonly kind: PortalCapabilityKind;
	readonly source: string;
	readonly title: string;
}

export interface PortalSearchRequest {
	readonly kind?: PortalCapabilityKind;
	readonly limit?: number;
	readonly query?: string;
}

export interface PortalSearchResult {
	readonly capabilities: readonly PortalCapability[];
}

export interface PortalExecuteRequest {
	readonly arguments?: Record<string, unknown>;
	readonly id: string;
}
```

- [ ] **Step 4: Implement search index**

Create `packages/openclaw-mcp-capability-portal-plugin/src/capability-index.ts`:

```ts
import type { PortalCapability, PortalSearchRequest } from './capability-types.js';

export interface CapabilityIndex {
	getById(capabilityId: string): PortalCapability | undefined;
	search(request: PortalSearchRequest): readonly PortalCapability[];
}

function normalizeSearchText(value: string): string {
	return value.toLowerCase().replace(/[_:-]+/gu, ' ');
}

function scoreCapability(capability: PortalCapability, terms: readonly string[]): number {
	const haystack = normalizeSearchText(
		[
			capability.id,
			capability.kind,
			capability.source,
			capability.title,
			capability.description,
		].join(' '),
	);
	return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export function createCapabilityIndex(capabilities: readonly PortalCapability[]): CapabilityIndex {
	const capabilitiesById = new Map(capabilities.map((capability) => [capability.id, capability]));
	return {
		getById(capabilityId) {
			return capabilitiesById.get(capabilityId);
		},
		search(request) {
			const limit = request.limit ?? 10;
			const query = normalizeSearchText(request.query ?? '').trim();
			const terms = query.length === 0 ? [] : query.split(/\s+/u);
			const filteredCapabilities = capabilities.filter(
				(capability) => !request.kind || capability.kind === request.kind,
			);
			if (terms.length === 0) {
				return filteredCapabilities.slice(0, limit);
			}
			return filteredCapabilities
				.map((capability) => ({
					capability,
					score: scoreCapability(capability, terms),
				}))
				.filter((entry) => entry.score > 0)
				.sort((left, right) => right.score - left.score || left.capability.id.localeCompare(right.capability.id))
				.slice(0, limit)
				.map((entry) => entry.capability);
		},
	};
}
```

- [ ] **Step 5: Run index tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/capability-index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/capability-types.ts packages/openclaw-mcp-capability-portal-plugin/src/capability-index.ts packages/openclaw-mcp-capability-portal-plugin/src/capability-index.test.ts
git commit -m "feat: add mcp portal capability index

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Load Skill Directory Capabilities

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.test.ts`

- [ ] **Step 1: Write skill loader tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadSkillCapabilities } from './skill-directory.js';

describe('loadSkillCapabilities', () => {
	it('loads markdown skills as searchable capabilities', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-portal-skills-'));
		await mkdir(path.join(root, 'readwise'), { recursive: true });
		await writeFile(
			path.join(root, 'readwise', 'SKILL.md'),
			[
				'---',
				'name: readwise',
				'description: Search and read saved articles from Readwise.',
				'---',
				'Use readwise search for saved articles.',
				'',
			].join('\n'),
		);

		await expect(loadSkillCapabilities({ skillsDirs: [root] })).resolves.toEqual([
			{
				description: 'Search and read saved articles from Readwise.',
				id: 'skill:readwise',
				kind: 'skill',
				source: path.join(root, 'readwise', 'SKILL.md'),
				title: 'readwise',
			},
		]);
	});
});
```

- [ ] **Step 2: Run skill loader tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.test.ts
```

Expected: FAIL because `skill-directory.ts` does not exist.

- [ ] **Step 3: Implement skill loader**

Create `packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { PortalCapability } from './capability-types.js';

function parseFrontmatterValue(content: string, fieldName: string): string | undefined {
	const match = new RegExp(`^${fieldName}:\\s*(.+)$`, 'mu').exec(content);
	return match?.[1]?.trim();
}

export async function loadSkillCapabilities(options: {
	readonly skillsDirs: readonly string[];
}): Promise<readonly PortalCapability[]> {
	const capabilities: PortalCapability[] = [];
	for (const skillsDir of options.skillsDirs) {
		const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
			const content = await readFile(skillPath, 'utf8').catch(() => undefined);
			if (!content) {
				continue;
			}
			const name = parseFrontmatterValue(content, 'name') ?? entry.name;
			const description =
				parseFrontmatterValue(content, 'description') ?? `Skill instructions from ${skillPath}.`;
			capabilities.push({
				description,
				id: `skill:${name}`,
				kind: 'skill',
				source: skillPath,
				title: name,
			});
		}
	}
	return capabilities.sort((left, right) => left.id.localeCompare(right.id));
}
```

- [ ] **Step 4: Run skill loader tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.ts packages/openclaw-mcp-capability-portal-plugin/src/skill-directory.test.ts
git commit -m "feat: load mcp portal skill capabilities

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Build MCP Client Runtime

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.test.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.test.ts`

- [ ] **Step 0: Normalize OpenClaw MCP server records, not plugin-owned records**

Create `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.test.ts` with tests that mirror OpenClaw's existing MCP transport behavior:

```ts
import { describe, expect, it } from 'vitest';

import { normalizeOpenClawMcpServers } from './openclaw-mcp-server-config.js';

describe('normalizeOpenClawMcpServers', () => {
	it('normalizes stdio and HTTP servers from OpenClaw mcp.servers', () => {
		expect(
			normalizeOpenClawMcpServers({
				calendar: {
					args: ['calendar-server.js'],
					command: 'node',
					env: { CALENDAR_TOKEN: 'secret-value' },
				},
				linear: {
					headers: { authorization: 'Bearer secret-value' },
					transport: 'streamable-http',
					url: 'https://mcp.linear.app/mcp',
				},
			}),
		).toEqual({
			calendar: {
				args: ['calendar-server.js'],
				command: 'node',
				env: { CALENDAR_TOKEN: 'secret-value' },
				kind: 'stdio',
			},
			linear: {
				headers: { authorization: 'Bearer secret-value' },
				kind: 'http',
				transport: 'streamable-http',
				url: 'https://mcp.linear.app/mcp',
			},
		});
	});

	it('drops dangerous stdio env entries the same way OpenClaw bundle-mcp does', () => {
		expect(
			normalizeOpenClawMcpServers({
				unsafe: {
					command: 'node',
					env: {
						LD_PRELOAD: '/tmp/hook.so',
						SAFE_TOKEN: 'ok',
					},
				},
			}).unsafe,
		).toEqual({
			args: [],
			command: 'node',
			env: { SAFE_TOKEN: 'ok' },
			kind: 'stdio',
		});
	});
});
```

Create `packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts`.

Implementation constraint: base this adapter on OpenClaw's `src/agents/mcp-transport-config.ts` and `src/agents/mcp-config-shared.ts` semantics. If OpenClaw exports a public helper by implementation time, import that helper instead of copying the rules. If it does not, keep this as a tiny compatibility adapter with tests for dangerous env filtering, HTTP header coercion, transport aliases, and skipped malformed servers.

- [ ] **Step 1: Write runtime tests with fake clients**

Create `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createMcpClientRuntime } from './mcp-client-runtime.js';
import type { PortalConfig } from './portal-config.js';

describe('createMcpClientRuntime', () => {
	it('lists MCP tools as portal capabilities without leaking env or headers', async () => {
		const runtime = createMcpClientRuntime({
			clientFactory: async () => ({
				callTool: vi.fn(),
				close: vi.fn(),
				listTools: vi.fn(async () => ({
					tools: [
						{
							description: 'Create a calendar event.',
							inputSchema: {
								type: 'object',
							},
							name: 'create_event',
						},
					],
				})),
			}),
			mcpServers: {
				calendar: {
					args: ['server.js'],
					command: 'node',
					env: {
						CALENDAR_TOKEN: 'secret-value',
					},
					kind: 'stdio',
				},
			},
			config: {
				approval: {
					alwaysAskCapabilityIds: [],
					writeCapabilityIds: [],
				},
				enabledServerIds: [],
				skillsDirs: [],
			} satisfies PortalConfig,
		});

		await expect(runtime.listCapabilities()).resolves.toEqual([
			{
				description: 'Create a calendar event.',
				id: 'mcp:calendar:create_event',
				inputSchema: {
					type: 'object',
				},
				kind: 'mcp-tool',
				source: 'calendar',
				title: 'create_event',
			},
		]);
	});

	it('executes MCP tools by capability id', async () => {
		const callTool = vi.fn(async () => ({
			content: [{ type: 'text', text: 'created' }],
		}));
		const runtime = createMcpClientRuntime({
			clientFactory: async () => ({
				callTool,
				close: vi.fn(),
				listTools: vi.fn(async () => ({ tools: [] })),
			}),
			mcpServers: {
				calendar: {
					args: ['server.js'],
					command: 'node',
					env: {},
					kind: 'stdio',
				},
			},
			config: {
				approval: {
					alwaysAskCapabilityIds: [],
					writeCapabilityIds: [],
				},
				enabledServerIds: [],
				skillsDirs: [],
			} satisfies PortalConfig,
		});

		await expect(
			runtime.executeTool({
				arguments: { summary: 'Review' },
				id: 'mcp:calendar:create_event',
			}),
		).resolves.toEqual({
			content: [{ type: 'text', text: 'created' }],
		});
		expect(callTool).toHaveBeenCalledWith({
			arguments: { summary: 'Review' },
			name: 'create_event',
		});
	});
});
```

- [ ] **Step 2: Run runtime tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.test.ts
```

Expected: FAIL because `mcp-client-runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime wrapper**

Create `packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { PortalCapability, PortalExecuteRequest } from './capability-types.js';
import type { PortalConfig } from './portal-config.js';

export type PortalMcpServerConfig =
	| {
			readonly args: readonly string[];
			readonly command: string;
			readonly cwd?: string;
			readonly env: Readonly<Record<string, string>>;
			readonly kind: 'stdio';
	  }
	| {
			readonly headers: Readonly<Record<string, string>>;
			readonly kind: 'http';
			readonly transport: 'sse' | 'streamable-http';
			readonly url: string;
	  };

interface MinimalMcpClient {
	callTool(request: { readonly arguments?: Record<string, unknown>; readonly name: string }): Promise<unknown>;
	close(): Promise<void> | void;
	listTools(): Promise<{
		readonly tools: readonly {
			readonly description?: string;
			readonly inputSchema?: Record<string, unknown>;
			readonly name: string;
		}[];
	}>;
}

export interface McpClientRuntime {
	executeTool(request: PortalExecuteRequest): Promise<unknown>;
	listCapabilities(): Promise<readonly PortalCapability[]>;
}

function capabilityIdFor(serverId: string, toolName: string): string {
	return `mcp:${serverId}:${toolName}`;
}

function parseMcpCapabilityId(capabilityId: string): { readonly serverId: string; readonly toolName: string } {
	const parts = capabilityId.split(':');
	if (parts.length !== 3 || parts[0] !== 'mcp' || !parts[1] || !parts[2]) {
		throw new Error(`Invalid MCP capability id '${capabilityId}'.`);
	}
	return {
		serverId: parts[1],
		toolName: parts[2],
	};
}

async function createSdkClient(serverId: string, server: PortalMcpServerConfig): Promise<MinimalMcpClient> {
	const client = new Client({
		name: `agent-vm-mcp-portal-${serverId}`,
		version: '1.0.0',
	});
	if (server.kind === 'stdio') {
		await client.connect(
			new StdioClientTransport({
				args: server.args,
				command: server.command,
				cwd: server.cwd,
				env: server.env,
			}),
		);
		return client;
	}
	if (server.transport === 'sse') {
		await client.connect(
			new SSEClientTransport(new URL(server.url), {
				requestInit: {
					headers: server.headers,
				},
			}),
		);
		return client;
	}
	await client.connect(
		new StreamableHTTPClientTransport(new URL(server.url), {
			requestInit: {
				headers: server.headers,
			},
		}),
	);
	return client;
}

export function createMcpClientRuntime(options: {
	readonly clientFactory?: (serverId: string, server: PortalMcpServerConfig) => Promise<MinimalMcpClient>;
	readonly config: PortalConfig;
	readonly mcpServers: Readonly<Record<string, PortalMcpServerConfig>>;
}): McpClientRuntime {
	const clientFactory = options.clientFactory ?? createSdkClient;
	const clients = new Map<string, Promise<MinimalMcpClient>>();
	const selectedServerIds =
		options.config.enabledServerIds.length > 0
			? options.config.enabledServerIds
			: Object.keys(options.mcpServers);

	function getClient(serverId: string): Promise<MinimalMcpClient> {
		const server = options.mcpServers[serverId];
		if (!server) {
			throw new Error(`Unknown MCP server '${serverId}'.`);
		}
		const existingClient = clients.get(serverId);
		if (existingClient) {
			return existingClient;
		}
		const nextClient = clientFactory(serverId, server);
		clients.set(serverId, nextClient);
		return nextClient;
	}

	return {
		async executeTool(request) {
			const { serverId, toolName } = parseMcpCapabilityId(request.id);
			const client = await getClient(serverId);
			return await client.callTool({
				arguments: request.arguments ?? {},
				name: toolName,
			});
		},
		async listCapabilities() {
			const capabilities: PortalCapability[] = [];
			for (const serverId of selectedServerIds) {
				const client = await getClient(serverId);
				const result = await client.listTools();
				for (const tool of result.tools) {
					capabilities.push({
						description: tool.description ?? `MCP tool '${tool.name}' from '${serverId}'.`,
						id: capabilityIdFor(serverId, tool.name),
						...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
						kind: 'mcp-tool',
						source: serverId,
						title: tool.name,
					});
				}
			}
			return capabilities.sort((left, right) => left.id.localeCompare(right.id));
		},
	};
}
```

- [ ] **Step 4: Run runtime tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.ts packages/openclaw-mcp-capability-portal-plugin/src/openclaw-mcp-server-config.test.ts packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.ts packages/openclaw-mcp-capability-portal-plugin/src/mcp-client-runtime.test.ts
git commit -m "feat: add mcp portal client runtime

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Implement Portal Tools

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts`

- [ ] **Step 1: Write portal tool tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { registerPortalTools } from './portal-tools.js';

describe('registerPortalTools', () => {
	it('registers search and execute tools', async () => {
		const registerTool = vi.fn();
		registerPortalTools({
			api: { registerTool },
			createIndex: async () => ({
				getById: (id) =>
					id === 'mcp:calendar:create_event'
						? {
								description: 'Create event.',
								id,
								kind: 'mcp-tool',
								source: 'calendar',
								title: 'create_event',
							}
						: undefined,
				search: () => [
					{
						description: 'Create event.',
						id: 'mcp:calendar:create_event',
						kind: 'mcp-tool',
						source: 'calendar',
						title: 'create_event',
					},
				],
			}),
			runtime: {
				executeTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
				listCapabilities: vi.fn(async () => []),
			},
		});

		const [searchTool, executeTool] = registerTool.mock.calls.map((call) => call[0]);

		await expect(searchTool.execute('call-1', { query: 'calendar' })).resolves.toEqual({
			content: JSON.stringify(
				{
					capabilities: [
						{
							description: 'Create event.',
							id: 'mcp:calendar:create_event',
							kind: 'mcp-tool',
							source: 'calendar',
							title: 'create_event',
						},
					],
				},
				null,
				2,
			),
		});
		await expect(
			executeTool.execute('call-2', {
				arguments: { summary: 'Review' },
				id: 'mcp:calendar:create_event',
			}),
		).resolves.toEqual({
			content: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }, null, 2),
		});
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts
```

Expected: FAIL because `portal-tools.ts` does not exist.

- [ ] **Step 3: Implement portal tools**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts`:

```ts
import { createCapabilityIndex, type CapabilityIndex } from './capability-index.js';
import type { PortalExecuteRequest, PortalSearchRequest } from './capability-types.js';
import type { McpClientRuntime } from './mcp-client-runtime.js';
import { loadSkillCapabilities } from './skill-directory.js';

interface RegisterToolApi {
	registerTool(
		tool: {
			readonly description: string;
			readonly execute: (toolCallId: string, params: unknown) => Promise<{ readonly content: string }>;
			readonly name: string;
			readonly parameters: Record<string, unknown>;
		},
		options?: { readonly name?: string; readonly optional?: boolean },
	): void;
}

function asSearchRequest(params: unknown): PortalSearchRequest {
	if (typeof params !== 'object' || params === null) {
		return {};
	}
	const record = params as Record<string, unknown>;
	return {
		...(record.kind === 'mcp-tool' || record.kind === 'skill' ? { kind: record.kind } : {}),
		...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
		...(typeof record.query === 'string' ? { query: record.query } : {}),
	};
}

function asExecuteRequest(params: unknown): PortalExecuteRequest {
	if (typeof params !== 'object' || params === null) {
		throw new Error('mcp_portal_execute requires an object input.');
	}
	const record = params as Record<string, unknown>;
	if (typeof record.id !== 'string' || record.id.length === 0) {
		throw new Error('mcp_portal_execute requires id.');
	}
	return {
		...(typeof record.arguments === 'object' && record.arguments !== null
			? { arguments: record.arguments as Record<string, unknown> }
			: {}),
		id: record.id,
	};
}

export function registerPortalTools(options: {
	readonly api: RegisterToolApi;
	readonly createIndex?: () => Promise<CapabilityIndex>;
	readonly runtime: McpClientRuntime;
	readonly skillsDirs?: readonly string[];
}): void {
	const createIndex =
		options.createIndex ??
		(async () =>
			createCapabilityIndex([
				...(await options.runtime.listCapabilities()),
				...(await loadSkillCapabilities({ skillsDirs: options.skillsDirs ?? [] })),
			]));

	options.api.registerTool(
		{
			description: 'Search gateway-proxied MCP tools and local skill instructions.',
			execute: async (_toolCallId, params) => {
				const index = await createIndex();
				const result = {
					capabilities: index.search(asSearchRequest(params)),
				};
				return {
					content: JSON.stringify(result, null, 2),
				};
			},
			name: 'mcp_portal_search',
			parameters: {
				additionalProperties: false,
				properties: {
					kind: { enum: ['mcp-tool', 'skill'], type: 'string' },
					limit: { minimum: 1, type: 'number' },
					query: { type: 'string' },
				},
				type: 'object',
			},
		},
		{ name: 'mcp_portal_search', optional: true },
	);

	options.api.registerTool(
		{
			description: 'Execute a selected MCP portal capability by id.',
			execute: async (_toolCallId, params) => {
				const request = asExecuteRequest(params);
				const index = await createIndex();
				const capability = index.getById(request.id);
				if (!capability) {
					throw new Error(`Unknown portal capability '${request.id}'.`);
				}
				if (capability.kind !== 'mcp-tool') {
					throw new Error(`Capability '${request.id}' is searchable but not executable.`);
				}
				return {
					content: JSON.stringify(await options.runtime.executeTool(request), null, 2),
				};
			},
			name: 'mcp_portal_execute',
			parameters: {
				additionalProperties: false,
				properties: {
					arguments: {
						additionalProperties: true,
						type: 'object',
					},
					id: { minLength: 1, type: 'string' },
				},
				required: ['id'],
				type: 'object',
			},
		},
		{ name: 'mcp_portal_execute', optional: true },
	);
}
```

- [ ] **Step 4: Run tool tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.ts packages/openclaw-mcp-capability-portal-plugin/src/portal-tools.test.ts
git commit -m "feat: register mcp portal tools

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Add Approval Hook For Portal Execution

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.test.ts`

- [ ] **Step 1: Write approval hook tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { registerPortalApprovalHook } from './portal-approval-hook.js';

describe('registerPortalApprovalHook', () => {
	it('requires approval for configured portal execute capability ids', async () => {
		const on = vi.fn();
		registerPortalApprovalHook({
			api: { on },
			approval: {
				alwaysAskCapabilityIds: ['mcp:calendar:create_event'],
				writeCapabilityIds: [],
			},
		});

		const handler = on.mock.calls[0][1];
		await expect(
			handler({
				params: {
					id: 'mcp:calendar:create_event',
				},
				toolName: 'mcp_portal_execute',
			}),
		).resolves.toEqual({
			requireApproval: {
				description: "Allow MCP portal capability 'mcp:calendar:create_event' to execute.",
				severity: 'warning',
				timeoutBehavior: 'deny',
				timeoutMs: 60_000,
				title: 'Execute MCP portal capability',
			},
		});
	});

	it('does not require approval for search', async () => {
		const on = vi.fn();
		registerPortalApprovalHook({
			api: { on },
			approval: {
				alwaysAskCapabilityIds: ['mcp:calendar:create_event'],
				writeCapabilityIds: [],
			},
		});

		const handler = on.mock.calls[0][1];
		await expect(
			handler({
				params: {
					query: 'calendar',
				},
				toolName: 'mcp_portal_search',
			}),
		).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.test.ts
```

Expected: FAIL because `portal-approval-hook.ts` does not exist.

- [ ] **Step 3: Implement approval hook**

Create `packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts`:

```ts
import type { PortalConfig } from './portal-config.js';

interface BeforeToolCallEvent {
	readonly params?: Record<string, unknown>;
	readonly toolName: string;
}

interface BeforeToolCallResult {
	readonly requireApproval?: {
		readonly description: string;
		readonly severity?: 'info' | 'warning' | 'critical';
		readonly timeoutBehavior?: 'allow' | 'deny';
		readonly timeoutMs?: number;
		readonly title: string;
	};
}

interface HookApi {
	registerHook(
		name: 'before_tool_call',
		handler: (event: BeforeToolCallEvent) => Promise<BeforeToolCallResult | undefined>,
		options?: { readonly priority?: number },
	): void;
}

export function registerPortalApprovalHook(options: {
	readonly api: HookApi;
	readonly approval: PortalConfig['approval'];
}): void {
	const alwaysAsk = new Set(options.approval.alwaysAskCapabilityIds);
	const writeCapabilities = new Set(options.approval.writeCapabilityIds);
	options.api.registerHook(
		'before_tool_call',
		async (event) => {
			if (event.toolName !== 'mcp_portal_execute') {
				return undefined;
			}
			const capabilityId = event.params?.id;
			if (typeof capabilityId !== 'string') {
				return undefined;
			}
			if (!alwaysAsk.has(capabilityId) && !writeCapabilities.has(capabilityId)) {
				return undefined;
			}
			return {
				requireApproval: {
					description: `Allow MCP portal capability '${capabilityId}' to execute.`,
					severity: writeCapabilities.has(capabilityId) ? 'critical' : 'warning',
					timeoutBehavior: 'deny',
					timeoutMs: 60_000,
					title: 'Execute MCP portal capability',
				},
			};
		},
		{ priority: 50 },
	);
}
```

- [ ] **Step 4: Run approval hook tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.ts packages/openclaw-mcp-capability-portal-plugin/src/portal-approval-hook.test.ts
git commit -m "feat: add mcp portal approval hook

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Wire Plugin Registration

**Files:**
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts`
- Create: `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts`

- [ ] **Step 1: Write registration tests**

Create `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import plugin from './plugin-registration.js';

describe('mcp capability portal plugin', () => {
	it('registers portal tools and approval hook', () => {
		const registerTool = vi.fn();
		const registerHook = vi.fn();

		plugin.register({
			config: {
				mcp: {
					servers: {
						calendar: {
							args: ['calendar-server.js'],
							command: 'node',
						},
					},
				},
			},
			pluginConfig: {
				approval: {
					alwaysAskCapabilityIds: ['mcp:calendar:create_event'],
				},
				enabledServerIds: ['calendar'],
				skillsDirs: [],
			},
			registerHook,
			registerTool,
		});

		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'mcp_portal_search' }),
			{ name: 'mcp_portal_search', optional: true },
		);
		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'mcp_portal_execute' }),
			{ name: 'mcp_portal_execute', optional: true },
		);
		expect(registerHook).toHaveBeenCalledWith('before_tool_call', expect.any(Function), {
			priority: 50,
		});
	});
});
```

- [ ] **Step 2: Run registration tests and verify they fail**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts
```

Expected: FAIL because `plugin-registration.ts` does not exist.

- [ ] **Step 3: Implement plugin registration**

Create `packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts`:

```ts
import { createMcpClientRuntime } from './mcp-client-runtime.js';
import { normalizeOpenClawMcpServers } from './openclaw-mcp-server-config.js';
import { parsePortalConfig } from './portal-config.js';
import { registerPortalApprovalHook } from './portal-approval-hook.js';
import { registerPortalTools } from './portal-tools.js';

const plugin = {
	description: 'Gateway-side MCP capability portal with search and execute tools.',
	id: 'mcp-capability-portal',
	name: 'MCP Capability Portal',

	register(api: {
		readonly config?: { readonly mcp?: { readonly servers?: unknown } };
		readonly pluginConfig: Record<string, unknown>;
		readonly registerHook?: Parameters<typeof registerPortalApprovalHook>[0]['api']['registerHook'];
		readonly registerTool?: Parameters<typeof registerPortalTools>[0]['api']['registerTool'];
	}): void {
		if (typeof api.registerTool !== 'function') {
			throw new Error('MCP capability portal requires OpenClaw registerTool.');
		}
		if (typeof api.registerHook !== 'function') {
			throw new Error('MCP capability portal requires OpenClaw plugin hooks.');
		}

		const config = parsePortalConfig(api.pluginConfig);
		const mcpServers = normalizeOpenClawMcpServers(api.config?.mcp?.servers ?? {});
		const runtime = createMcpClientRuntime({ config, mcpServers });
		registerPortalTools({
			api: { registerTool: api.registerTool },
			runtime,
			skillsDirs: config.skillsDirs,
		});
		registerPortalApprovalHook({
			api: { registerHook: api.registerHook },
			approval: config.approval,
		});
	},
};

export default plugin;
```

- [ ] **Step 4: Run registration tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

Run:

```bash
git add packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.ts packages/openclaw-mcp-capability-portal-plugin/src/plugin-registration.test.ts
git commit -m "feat: wire mcp capability portal plugin

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 9: Document Gateway Portal Security And Usage

**Files:**
- Create: `docs/subsystems/mcp-capability-portal.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Add subsystem doc**

Create `docs/subsystems/mcp-capability-portal.md`:

```md
# MCP Capability Portal

The MCP capability portal is a gateway-side OpenClaw plugin. It connects to
selected upstream MCP servers and exposes two agent-visible tools:

- `mcp_portal_search`: searches available MCP tools and local skill docs.
- `mcp_portal_execute`: executes one MCP tool by capability id.

The portal is intentionally separate from Tool VM CLI execution:

- MCP server auth and headers stay in OpenClaw's gateway-owned `mcp.servers` config.
- Search results never include upstream env vars, headers, or raw server config.
- OpenClaw `before_tool_call` approval handles write-sensitive portal execution.
- Tool VM HTTP-mediated secrets remain under `gondolin-secret-source`.

Capability IDs use stable prefixes:

- `mcp:<serverId>:<toolName>` for executable upstream MCP tools.
- `skill:<skillName>` for searchable local skill docs.

Example OpenClaw config:

```jsonc
{
  "mcp": {
    "servers": {
      "linear": {
        "url": "https://mcp.linear.app/mcp",
        "transport": "streamable-http",
        "headers": {
          "authorization": "Bearer ${LINEAR_MCP_TOKEN}"
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "mcp-capability-portal": {
        "enabled": true,
        "path": "@agent-vm/openclaw-mcp-capability-portal-plugin",
        "config": {
          "skillsDirs": ["/opt/agent-vm/skills"],
          "enabledServerIds": ["linear"],
          "approval": {
            "writeCapabilityIds": ["mcp:linear:create_issue"]
          }
        }
      }
    }
  },
  "tools": {
    "allow": ["mcp_portal_search", "mcp_portal_execute"]
  }
}
```
```

- [ ] **Step 2: Add architecture note**

In `docs/architecture/openclaw-gateway.md`, add:

```md
## MCP Capability Portal

The MCP capability portal is a gateway plugin, not a Tool VM service. It
connects to configured upstream MCP servers from OpenClaw's existing
`mcp.servers` registry, keeps their auth material in gateway-owned config, and
exposes only `mcp_portal_search` and `mcp_portal_execute` to agents.

```text
Agent
  |
  | mcp_portal_search / mcp_portal_execute
  v
OpenClaw gateway plugin
  |
  | MCP client transports
  v
Configured upstream MCP servers
```
```

- [ ] **Step 3: Add manual references**

In `packages/agent-vm/src/cli/manual-templates.ts`, add:

```ts
For MCP integrations that should not expose every tool schema to the model,
use the MCP capability portal plugin. It exposes mcp_portal_search and
mcp_portal_execute while reusing OpenClaw mcp.servers for upstream auth.
```

Update `packages/agent-vm/src/cli/manual-templates.test.ts`:

```ts
expect(manual).toContain('MCP capability portal');
expect(manual).toContain('mcp_portal_search');
expect(manual).toContain('mcp_portal_execute');
```

- [ ] **Step 4: Regenerate manual docs**

Run:

```bash
pnpm --filter @agent-vm/agent-vm build
pnpm agent-vm manual update
```

Expected: generated docs mention `MCP capability portal`, `mcp_portal_search`, and `mcp_portal_execute`.

- [ ] **Step 5: Commit Task 9**

Run:

```bash
git add docs packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
git commit -m "docs: add mcp capability portal guidance

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 10: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run portal package tests**

Run:

```bash
pnpm vitest run packages/openclaw-mcp-capability-portal-plugin/src
```

Expected: PASS.

- [ ] **Step 2: Run full unit tests**

Run:

```bash
pnpm test:unit
```

Expected: PASS, all Vitest unit tests pass with exit code 0.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS, including `@agent-vm/openclaw-mcp-capability-portal-plugin`.

- [ ] **Step 4: Run checks**

Run:

```bash
pnpm check
```

Expected: PASS, package version sync, Zod check, type-aware lint, format check, and typecheck all pass with exit code 0.

- [ ] **Step 5: Final commit if verification fixes were needed**

If verification required code or docs changes, commit them:

```bash
git add .
git commit -m "fix: stabilize mcp capability portal

Co-authored-by: Codex <noreply@openai.com>"
```

If no changes were required, do not create an empty commit.

---

## Security Notes

- The portal is a gateway plugin because upstream MCP auth belongs outside Tool VM process memory.
- `mcp_portal_search` is read-only and returns redacted capability metadata.
- `mcp_portal_execute` is the action surface; use `approval.writeCapabilityIds` and `approval.alwaysAskCapabilityIds` for escalation.
- Upstream MCP server config can include env vars or headers, but those values must never appear in search results, tool errors, or logs.
- This plan intentionally does not implement arbitrary JS Code Mode execution. Deterministic search/execute gives progressive disclosure without adding an isolate security problem.

## Self-Review

- Spec coverage: separate portal plugin, gateway-owned MCP auth, progressive search/execute, skill directory, MCP client transports, and OpenClaw approval hook are all mapped to tasks.
- Placeholder scan: the plan uses concrete file paths, function names, test code, implementation code, commands, and expected results.
- Type consistency: `PortalConfig`, `PortalCapability`, `mcp_portal_search`, `mcp_portal_execute`, `createMcpClientRuntime`, and `registerPortalApprovalHook` are named consistently across tasks.
