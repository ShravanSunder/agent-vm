import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	ManagedMcpProviderBackendFactory,
	McpProviderCapabilityBackend,
} from '@agent-vm/mcp-portal/mcp-provider-backend';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedToolPortalInProcessRuntime } from './managed-tool-portal-runtime.js';

const createdDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directoryPath = await mkdtemp(path.join(tmpdir(), 'agent-vm-tool-portal-runtime-'));
	createdDirectories.push(directoryPath);
	return directoryPath;
}

async function writeJsonConfig(filePath: string, value: unknown): Promise<void> {
	await writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

function createMcpBackendStub(): McpProviderCapabilityBackend {
	return {
		call: vi.fn(async () => ({ items: [], ok: true })),
		describe: vi.fn(async () => ({ items: [], ok: true })),
		list: vi.fn(async () => ({ items: [], ok: true })),
		search: vi.fn(async () => ({ items: [], ok: true })),
	};
}

describe('managed Tool Portal runtime', () => {
	afterEach(async () => {
		await Promise.all(
			createdDirectories.splice(0).map(async (directoryPath) => {
				await rm(directoryPath, { recursive: true, force: true });
			}),
		);
	});

	it('rejects effective config manifest filenames that escape the config directory', async () => {
		const rootDirectory = await createTemporaryDirectory();
		const configDirectory = path.join(rootDirectory, 'effective');
		const outsideMcpConfigPath = path.join(rootDirectory, 'outside-mcp.config.jsonc');
		await mkdir(configDirectory);
		await writeJsonConfig(outsideMcpConfigPath, {
			providers: {},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal.config.jsonc'), {
			agents: { 'agent-a': { profile: 'default' } },
			profiles: {
				default: {
					capabilities: {},
				},
			},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal-effective-manifest.json'), {
			mcpConfigFile: '../outside-mcp.config.jsonc',
			portalConfigFile: 'mcp-portal.config.jsonc',
			schemaVersion: 1,
			toolPortalConfigFile: 'tool-portal.config.jsonc',
		});

		const runtime = createManagedToolPortalInProcessRuntime({
			configDir: configDirectory,
		});

		await expect(runtime.getEntryPoint('agent-a')).rejects.toThrow(
			/effective config manifest.*inside the config directory/u,
		);
	});

	it('bounds session-keyed entrypoint cache entries and refreshes recency on reuse', async () => {
		const rootDirectory = await createTemporaryDirectory();
		const configDirectory = path.join(rootDirectory, 'config');
		await mkdir(configDirectory);
		await writeJsonConfig(path.join(configDirectory, 'mcp.config.jsonc'), {
			providers: {},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal.config.jsonc'), {
			agents: { 'agent-a': { profile: 'default' } },
			profiles: {
				default: {
					capabilities: {
						controller_host_action: {
							backend: { kind: 'controller_host_action' },
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: ['zone_git_push'], deny: [] },
							},
							tools: { allow: ['zone_git_push'], deny: [] },
						},
					},
				},
			},
			schemaVersion: 1,
		});
		const createdBackendCacheKeys: string[] = [];
		const runtime = createManagedToolPortalInProcessRuntime({
			configDir: configDirectory,
			createControllerHostActionBackend: (_projection, context) => {
				createdBackendCacheKeys.push(context.entryPointCacheKey);
				return {
					call: vi.fn(async () => ({ items: [], ok: true })),
					describe: vi.fn(async () => ({ items: [], ok: true })),
					list: vi.fn(async () => ({ items: [], ok: true })),
					search: vi.fn(async () => ({ items: [], ok: true })),
				};
			},
			maxEntryPointCacheEntries: 2,
		});

		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-a' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-b' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-a' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-c' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-b' });

		expect(createdBackendCacheKeys).toEqual(['session-a', 'session-b', 'session-c', 'session-b']);
	});

	it('retires session-scoped MCP backends on LRU eviction and runtime close', async () => {
		const rootDirectory = await createTemporaryDirectory();
		const configDirectory = path.join(rootDirectory, 'config');
		await mkdir(configDirectory);
		await writeJsonConfig(path.join(configDirectory, 'mcp.config.jsonc'), {
			providers: {},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal.config.jsonc'), {
			agents: { 'agent-a': { profile: 'default' } },
			profiles: {
				default: {
					capabilities: {},
				},
			},
			schemaVersion: 1,
		});
		const retiredSessionKeys: string[] = [];
		const closeFactory = vi.fn(async () => {});
		const factory = {
			close: closeFactory,
			createBackend: vi.fn(() => createMcpBackendStub()),
			retireSession: vi.fn(async (sessionKey: string) => {
				retiredSessionKeys.push(sessionKey);
			}),
		} satisfies ManagedMcpProviderBackendFactory;
		const runtime = createManagedToolPortalInProcessRuntime({
			configDir: configDirectory,
			createMcpProviderBackendFactory: vi.fn(async () => factory),
			maxEntryPointCacheEntries: 2,
		});

		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-a' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-b' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-a' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-c' });
		await runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-b' });

		expect(retiredSessionKeys).toEqual(['session-b', 'session-a']);

		await runtime.close();

		expect(retiredSessionKeys).toEqual(['session-b', 'session-a', 'session-c', 'session-b']);
		expect(closeFactory).toHaveBeenCalledTimes(1);
	});

	it('retires MCP sessions that finish after their cache entry was evicted', async () => {
		const rootDirectory = await createTemporaryDirectory();
		const configDirectory = path.join(rootDirectory, 'config');
		await mkdir(configDirectory);
		await writeJsonConfig(path.join(configDirectory, 'mcp.config.jsonc'), {
			providers: {},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal.config.jsonc'), {
			agents: { 'agent-a': { profile: 'default' } },
			profiles: {
				default: {
					capabilities: {
						'upstream-a': {
							backend: { kind: 'mcp_provider' },
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: '*', deny: [] },
							},
							tools: { allow: '*', deny: [] },
						},
					},
				},
			},
			schemaVersion: 1,
		});
		const observedSessionKeys: string[] = [];
		const retiredSessionKeys: string[] = [];
		const factory = {
			close: vi.fn(async () => {}),
			createBackend: vi.fn((_projection, options) => {
				if (options?.sessionKey === undefined) {
					throw new Error('Expected session key.');
				}
				observedSessionKeys.push(options.sessionKey);
				return createMcpBackendStub();
			}),
			retireSession: vi.fn(async (sessionKey: string) => {
				retiredSessionKeys.push(sessionKey);
			}),
		} satisfies ManagedMcpProviderBackendFactory;
		const runtime = createManagedToolPortalInProcessRuntime({
			configDir: configDirectory,
			createMcpProviderBackendFactory: vi.fn(async () => factory),
			maxEntryPointCacheEntries: 1,
		});

		const firstEntryPoint = runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-a' });
		const secondEntryPoint = runtime.getEntryPoint('agent-a', { entryPointCacheKey: 'session-b' });
		await Promise.all([firstEntryPoint, secondEntryPoint]);
		await runtime.close();

		expect(observedSessionKeys).toEqual(['session-a', 'session-b']);
		expect(retiredSessionKeys).toEqual(['session-a', 'session-b']);
	});

	it('derives an MCP-safe session key from internal cache keys with control separators', async () => {
		const rootDirectory = await createTemporaryDirectory();
		const configDirectory = path.join(rootDirectory, 'config');
		await mkdir(configDirectory);
		await writeJsonConfig(path.join(configDirectory, 'mcp.config.jsonc'), {
			providers: {},
			schemaVersion: 1,
		});
		await writeJsonConfig(path.join(configDirectory, 'tool-portal.config.jsonc'), {
			agents: { 'agent-a': { profile: 'default' } },
			profiles: {
				default: {
					capabilities: {
						'upstream-a': {
							backend: { kind: 'mcp_provider' },
							calls: {
								requiresApproval: { allow: [], deny: [] },
								withoutApproval: { allow: '*', deny: [] },
							},
							tools: { allow: '*', deny: [] },
						},
					},
				},
			},
			schemaVersion: 1,
		});
		const observedSessionKeys: string[] = [];
		const retiredSessionKeys: string[] = [];
		const factory = {
			close: vi.fn(async () => {}),
			createBackend: vi.fn((_projection, options) => {
				if (options?.sessionKey === undefined) {
					throw new Error('Expected session key.');
				}
				observedSessionKeys.push(options.sessionKey);
				return createMcpBackendStub();
			}),
			retireSession: vi.fn(async (sessionKey: string) => {
				retiredSessionKeys.push(sessionKey);
			}),
		} satisfies ManagedMcpProviderBackendFactory;
		const runtime = createManagedToolPortalInProcessRuntime({
			configDir: configDirectory,
			createMcpProviderBackendFactory: vi.fn(async () => factory),
			maxEntryPointCacheEntries: 1,
		});

		await runtime.getEntryPoint('agent-a', {
			entryPointCacheKey: 'zone-a\u0000agent-a\u0000session-a',
		});
		await runtime.getEntryPoint('agent-a', {
			entryPointCacheKey: 'zone-a\u0000agent-a\u0000session-b',
		});
		await runtime.close();

		expect(observedSessionKeys).toHaveLength(2);
		expect(observedSessionKeys[0]).toMatch(/^tool-portal-entrypoint-/u);
		expect(observedSessionKeys[1]).toMatch(/^tool-portal-entrypoint-/u);
		expect(observedSessionKeys[0]).not.toContain('\u0000');
		expect(observedSessionKeys[1]).not.toContain('\u0000');
		expect(retiredSessionKeys).toEqual(observedSessionKeys);
	});
});
