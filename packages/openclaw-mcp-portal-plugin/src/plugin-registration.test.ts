import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	OpenClawBeforePromptBuildEvent,
	OpenClawPluginHookEventMap,
	OpenClawPluginHookResultMap,
	OpenClawPluginHookOptions,
	OpenClawRuntimeLifecycleRegistration,
	OpenClawToolFactory,
} from './openclaw-plugin-api.js';
import {
	registerMcpPortalPlugin,
	validatePortalPluginApi,
	validatePortalPortAgainstTcpPool,
} from './plugin-registration.js';

const createdDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		createdDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createPortalConfigDir(props: {
	readonly enabledNamespaces: readonly string[];
}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'agent-vm-openclaw-mcp-portal-plugin-'));
	createdDirectories.push(dir);
	await writeFile(
		join(dir, 'mcp.config.jsonc'),
		JSON.stringify({ providers: {}, schemaVersion: 1 }),
	);
	await writeFile(
		join(dir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { shravan: { profile: 'default' } },
			profiles: { default: { enabledNamespaces: props.enabledNamespaces } },
			schemaVersion: 1,
		}),
	);
	return dir;
}

describe('plugin registration validation', () => {
	it('imports MCP Portal through the core subpath only', async () => {
		const source = await readFile(new URL('./plugin-registration.ts', import.meta.url), 'utf8');

		expect(source).not.toContain("from '@agent-vm/mcp-portal'");
		expect(source).toContain("from '@agent-vm/mcp-portal/core'");
	});

	it('does not fire-and-forget portal config loading during synchronous registration', async () => {
		const source = await readFile(new URL('./plugin-registration.ts', import.meta.url), 'utf8');

		expect(source).not.toContain('void runtimeState.loadPortalConfig()');
		expect(source).not.toContain('failed to initialize portal config');
	});

	it('requires native tool registration, before-tool-call hooks, and lifecycle cleanup APIs', () => {
		expect(() => validatePortalPluginApi({})).toThrow(/registerTool/u);
		expect(() =>
			validatePortalPluginApi({
				registerPromptHook: () => undefined,
				registerRuntimeLifecycle: () => undefined,
				registerTool: () => undefined,
			}),
		).toThrow(/before_tool_call/u);
		expect(() =>
			validatePortalPluginApi({
				on: () => undefined,
				registerRuntimeLifecycle: () => undefined,
				registerTool: () => undefined,
			}),
		).not.toThrow();
	});

	it('refuses a portal port inside the Tool VM TCP pool range', () => {
		expect(() =>
			validatePortalPortAgainstTcpPool({
				port: 19_001,
				tcpPool: { basePort: 19_000, size: 4 },
			}),
		).toThrow(/overlaps/u);
		expect(() =>
			validatePortalPortAgainstTcpPool({
				port: 18_790,
				tcpPool: { basePort: 19_000, size: 4 },
			}),
		).not.toThrow();
	});

	it('registers native portal tools plus prompt and tool hooks', () => {
		const hooks: string[] = [];
		const registeredTools: OpenClawToolFactory[] = [];
		let lifecycleRegistration: OpenClawRuntimeLifecycleRegistration | undefined;

		registerMcpPortalPlugin({
			config: {
				tcpPool: { basePort: 19_000, size: 4 },
			},
			logger: { error: () => undefined },
			lifecycle: {
				registerRuntimeLifecycle: (lifecycle) => {
					lifecycleRegistration = lifecycle;
				},
			},
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredTools.push(tool);
				}
			},
		});

		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0]?.({ agentId: 'shravan' })).toEqual([
			expect.objectContaining({ name: 'mcp_portal_list' }),
			expect.objectContaining({ name: 'mcp_portal_search' }),
			expect.objectContaining({ name: 'mcp_portal_describe' }),
			expect.objectContaining({ name: 'mcp_portal_call' }),
		]);
		expect(hooks).toEqual(['before_tool_call', 'before_prompt_build']);
		expect(lifecycleRegistration).toMatchObject({
			id: 'mcp-portal-core',
		});
		expect(lifecycleRegistration?.cleanup).toEqual(expect.any(Function));
	});

	it('registers native portal tools during OpenClaw tool discovery without runtime hooks', () => {
		const hooks: string[] = [];
		const logger = { info: vi.fn() };
		const registeredTools: OpenClawToolFactory[] = [];

		registerMcpPortalPlugin({
			logger,
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registrationMode: 'tool-discovery',
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredTools.push(tool);
				}
			},
		});

		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0]?.({ agentId: 'shravan' })).toEqual([
			expect.objectContaining({ name: 'mcp_portal_list' }),
			expect.objectContaining({ name: 'mcp_portal_search' }),
			expect.objectContaining({ name: 'mcp_portal_describe' }),
			expect.objectContaining({ name: 'mcp_portal_call' }),
		]);
		expect(hooks).toEqual([]);
		expect(logger.info).toHaveBeenCalledWith(
			"[mcp-portal] registered native portal tools for registrationMode='tool-discovery'.",
		);
	});

	it('registers native portal tools during OpenClaw capability discovery without runtime hooks', () => {
		const registeredTools: OpenClawToolFactory[] = [];

		registerMcpPortalPlugin({
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registrationMode: 'discovery',
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredTools.push(tool);
				}
			},
		});

		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0]?.({ agentId: 'shravan' })).toEqual([
			expect.objectContaining({ name: 'mcp_portal_list' }),
			expect.objectContaining({ name: 'mcp_portal_search' }),
			expect.objectContaining({ name: 'mcp_portal_describe' }),
			expect.objectContaining({ name: 'mcp_portal_call' }),
		]);
	});

	it('requires a portal config directory during OpenClaw capability discovery', () => {
		expect(() =>
			registerMcpPortalPlugin({
				registrationMode: 'discovery',
				registerTool: () => undefined,
			}),
		).toThrow(/requires configDir/u);
	});

	it('registers native portal tools in any non-full mode that exposes registerTool', () => {
		const registeredTools: OpenClawToolFactory[] = [];

		registerMcpPortalPlugin({
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registrationMode: 'setup-runtime',
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredTools.push(tool);
				}
			},
		});

		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0]?.({ agentId: 'shravan' })).toEqual([
			expect.objectContaining({ name: 'mcp_portal_list' }),
			expect.objectContaining({ name: 'mcp_portal_search' }),
			expect.objectContaining({ name: 'mcp_portal_describe' }),
			expect.objectContaining({ name: 'mcp_portal_call' }),
		]);
	});

	it('skips non-full registration modes when registerTool is unavailable', () => {
		const logger = { warn: vi.fn() };

		expect(() =>
			registerMcpPortalPlugin({
				logger,
				pluginConfig: {
					configDir: '/config/gateways/sunclaw',
				},
				registrationMode: 'cli-metadata',
			}),
		).not.toThrow();
		expect(logger.warn).toHaveBeenCalledWith(
			"[mcp-portal] skipped native portal tool registration for registrationMode='cli-metadata' because OpenClaw did not expose registerTool.",
		);
	});

	it('uses the loaded portal profile to scope native tool descriptors', async () => {
		const configDir = await createPortalConfigDir({ enabledNamespaces: ['linear'] });
		let registeredToolFactory: OpenClawToolFactory | undefined;
		let beforePromptBuild:
			| ((
					event: OpenClawBeforePromptBuildEvent,
					context: { readonly agentId?: string },
			  ) =>
					| OpenClawPluginHookResultMap['before_prompt_build']
					| Promise<OpenClawPluginHookResultMap['before_prompt_build'] | void>
					| void)
			| undefined;

		registerMcpPortalPlugin({
			logger: { error: () => undefined },
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
				_options?: OpenClawPluginHookOptions,
			): void => {
				if (hookName === 'before_prompt_build') {
					beforePromptBuild = handler as typeof beforePromptBuild;
				}
			},
			pluginConfig: { configDir },
			registerRuntimeLifecycle: () => undefined,
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredToolFactory = tool;
				}
			},
		});

		await beforePromptBuild?.({}, { agentId: 'shravan' });
		const tools = registeredToolFactory?.({ agentId: 'shravan' });
		if (!Array.isArray(tools)) {
			throw new Error('MCP Portal registered tool factory did not return tools.');
		}

		expect(tools.find((tool) => tool.name === 'mcp_portal_list')?.description).toContain(
			'Authorized MCP namespaces for this agent scope: linear.',
		);
	});

	it('does not register a managed service for native OpenClaw', () => {
		const registerService = vi.fn();
		const hooks: string[] = [];
		let registeredToolFactory: OpenClawToolFactory | undefined;

		registerMcpPortalPlugin({
			config: {
				tcpPool: { basePort: 19_000, size: 4 },
			},
			logger: { error: () => undefined },
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredToolFactory = tool;
				}
			},
			registerRuntimeLifecycle: () => undefined,
			registerService,
		});

		expect(registerService).not.toHaveBeenCalled();
		expect(hooks).toEqual(['before_tool_call', 'before_prompt_build']);
		expect(registeredToolFactory).toEqual(expect.any(Function));
	});

	it('throws a tool error when OpenClaw omits trusted agent identity', async () => {
		let registeredToolFactory: OpenClawToolFactory | undefined;

		registerMcpPortalPlugin({
			logger: { error: () => undefined },
			on: () => undefined,
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerRuntimeLifecycle: () => undefined,
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredToolFactory = tool;
				}
			},
		});
		const tools = registeredToolFactory?.({});
		if (!Array.isArray(tools)) {
			throw new Error('MCP Portal registered tool factory did not return tools.');
		}
		const callTool = tools.find((tool) => tool.name === 'mcp_portal_call');
		if (callTool === undefined) {
			throw new Error('MCP Portal call tool was not registered.');
		}

		await expect(callTool.execute('call-1', { calls: [] })).rejects.toThrow(
			/mcp-portal: OpenClaw did not provide a trusted agentId/u,
		);
	});

	it('supports the OpenClaw runtime lifecycle API without onDispose', () => {
		const hooks: string[] = [];
		const registeredTools: OpenClawToolFactory[] = [];
		let lifecycleRegistration: OpenClawRuntimeLifecycleRegistration | undefined;

		registerMcpPortalPlugin({
			config: {
				tcpPool: { basePort: 19_000, size: 4 },
			},
			logger: { error: () => undefined },
			on: <THookName extends keyof OpenClawPluginHookEventMap>(
				hookName: THookName,
				_handler: (
					event: OpenClawPluginHookEventMap[THookName],
					context: { readonly agentId?: string },
				) =>
					| OpenClawPluginHookResultMap[THookName]
					| Promise<OpenClawPluginHookResultMap[THookName] | void>
					| void,
			): void => {
				hooks.push(hookName);
			},
			pluginConfig: {
				configDir: '/config/gateways/sunclaw',
			},
			registerRuntimeLifecycle: (lifecycle) => {
				lifecycleRegistration = lifecycle;
			},
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredTools.push(tool);
				}
			},
		});

		expect(registeredTools).toHaveLength(1);
		expect(hooks).toEqual(['before_tool_call', 'before_prompt_build']);
		expect(lifecycleRegistration).toMatchObject({
			id: 'mcp-portal-core',
		});
		expect(lifecycleRegistration?.cleanup).toEqual(expect.any(Function));
	});

	it('does not rethrow a failed core initialization during lifecycle cleanup', async () => {
		let registeredToolFactory: OpenClawToolFactory | undefined;
		let lifecycleRegistration: OpenClawRuntimeLifecycleRegistration | undefined;

		registerMcpPortalPlugin({
			logger: { error: () => undefined },
			on: () => undefined,
			pluginConfig: {
				configDir: '/definitely/missing/mcp-portal-config',
			},
			registerRuntimeLifecycle: (lifecycle) => {
				lifecycleRegistration = lifecycle;
			},
			registerTool: (tool) => {
				if (typeof tool === 'function') {
					registeredToolFactory = tool;
				}
			},
		});
		const tools = registeredToolFactory?.({ agentId: 'shravan' });
		if (!Array.isArray(tools)) {
			throw new Error('MCP Portal registered tool factory did not return tools.');
		}
		const callTool = tools.find((tool) => tool.name === 'mcp_portal_list');
		if (callTool === undefined || lifecycleRegistration?.cleanup === undefined) {
			throw new Error('MCP Portal test did not capture tool and cleanup registrations.');
		}

		await expect(callTool.execute('call-1', { requests: [{ id: 'list' }] })).rejects.toThrow();
		await expect(lifecycleRegistration.cleanup({ reason: 'restart' })).resolves.toBeUndefined();
	});
});
