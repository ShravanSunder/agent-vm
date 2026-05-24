import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { OpenClawToolFactory } from './openclaw-plugin-api.js';

describe('native MCP Portal onUpdate forwarding', () => {
	it('forwards core progress events through OpenClaw onUpdate', async () => {
		vi.resetModules();
		const coreResult = {
			items: [{ requestId: 'read-1', status: 'success' }],
			toolName: 'mcp_portal_call',
		};
		const close = vi.fn(async () => undefined);
		vi.doMock('@agent-vm/mcp-portal/core', () => ({
			createPortalCore: () => ({
				callStream: async function* () {
					yield {
						kind: 'progress',
						message: 'Calling upstream MCP tool upstream-mock.read_thing.',
						progress: 5,
						requestId: 'read-1',
						total: 10,
					};
					yield { kind: 'completed', result: coreResult };
				},
				close,
				collectPortalCoreResult: async (
					events: AsyncIterable<
						| {
								readonly kind: 'progress';
								readonly message: string;
								readonly progress: number;
								readonly requestId: string;
								readonly total: number;
						  }
						| { readonly kind: 'completed'; readonly result: typeof coreResult }
					>,
					props: {
						readonly onEvent?: (event: unknown) => Promise<void> | void;
					},
				) => {
					for await (const event of events) {
						await props.onEvent?.(event);
						if (event.kind === 'completed') {
							return event.result;
						}
					}
					throw new Error('test stream did not complete');
				},
				createAgentScope: (scope: unknown) => scope,
			}),
			createUpstreamMcpClientRuntime: () => ({
				callTool: vi.fn(),
				closeAgentScope: vi.fn(),
				closeSession: vi.fn(),
				listTools: vi.fn(),
			}),
			listPortalCoreToolDescriptors: () => [
				{
					description: 'Call authorized MCP tools.',
					inputSchema: { type: 'object' },
					name: 'mcp_portal_call',
				},
			],
			resolveUpstreamServers: async () => [],
		}));
		const { registerMcpPortalPlugin } = await import('./plugin-registration.js');
		const workspace = await mkdtemp(join(tmpdir(), 'openclaw-mcp-portal-plugin-'));
		let registeredToolFactory: OpenClawToolFactory | undefined;
		const onUpdate = vi.fn(async () => undefined);
		try {
			await writeFile(
				join(workspace, 'mcp.config.jsonc'),
				JSON.stringify({ providers: {}, schemaVersion: 1 }),
			);
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					profiles: {
						default: { namespaces: {} },
					},
					schemaVersion: 1,
				}),
			);

			registerMcpPortalPlugin({
				logger: { error: () => undefined, warn: () => undefined },
				on: () => undefined,
				pluginConfig: { configDir: workspace },
				registerRuntimeLifecycle: () => undefined,
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
			const callTool = tools.find((tool) => tool.name === 'mcp_portal_call');
			if (callTool === undefined) {
				throw new Error('MCP Portal call tool was not registered.');
			}

			const result = await callTool.execute('call-1', { calls: [] }, undefined, onUpdate);

			expect(result.details).toBe(coreResult);
			expect(onUpdate).toHaveBeenCalledWith({
				message: 'Calling upstream MCP tool upstream-mock.read_thing.',
				progress: 5,
				requestId: 'read-1',
				total: 10,
				type: 'mcp_portal_progress',
			});
		} finally {
			await rm(workspace, { force: true, recursive: true });
			vi.doUnmock('@agent-vm/mcp-portal/core');
			vi.resetModules();
		}
	});

	it('logs and continues when OpenClaw onUpdate rejects', async () => {
		vi.resetModules();
		const coreResult = {
			items: [{ requestId: 'read-1', status: 'success' }],
			toolName: 'mcp_portal_call',
		};
		const close = vi.fn(async () => undefined);
		vi.doMock('@agent-vm/mcp-portal/core', () => ({
			createPortalCore: () => ({
				callStream: async function* () {
					yield {
						kind: 'progress',
						message: 'Calling upstream MCP tool upstream-mock.read_thing.',
						requestId: 'read-1',
					};
					yield { kind: 'completed', result: coreResult };
				},
				close,
				collectPortalCoreResult: async (
					events: AsyncIterable<
						| {
								readonly kind: 'progress';
								readonly message: string;
								readonly requestId: string;
						  }
						| { readonly kind: 'completed'; readonly result: typeof coreResult }
					>,
					props: {
						readonly onEvent?: (event: unknown) => Promise<void> | void;
					},
				) => {
					for await (const event of events) {
						await props.onEvent?.(event);
						if (event.kind === 'completed') {
							return event.result;
						}
					}
					throw new Error('test stream did not complete');
				},
				createAgentScope: (scope: unknown) => scope,
			}),
			createUpstreamMcpClientRuntime: () => ({
				callTool: vi.fn(),
				closeAgentScope: vi.fn(),
				closeSession: vi.fn(),
				listTools: vi.fn(),
			}),
			listPortalCoreToolDescriptors: () => [
				{
					description: 'Call authorized MCP tools.',
					inputSchema: { type: 'object' },
					name: 'mcp_portal_call',
				},
			],
			resolveUpstreamServers: async () => [],
		}));
		const { registerMcpPortalPlugin } = await import('./plugin-registration.js');
		const workspace = await mkdtemp(join(tmpdir(), 'openclaw-mcp-portal-plugin-'));
		let registeredToolFactory: OpenClawToolFactory | undefined;
		const warn = vi.fn();
		try {
			await writeFile(
				join(workspace, 'mcp.config.jsonc'),
				JSON.stringify({ providers: {}, schemaVersion: 1 }),
			);
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					profiles: {
						default: { namespaces: {} },
					},
					schemaVersion: 1,
				}),
			);

			registerMcpPortalPlugin({
				logger: { error: () => undefined, warn },
				on: () => undefined,
				pluginConfig: { configDir: workspace },
				registerRuntimeLifecycle: () => undefined,
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
			const callTool = tools.find((tool) => tool.name === 'mcp_portal_call');
			if (callTool === undefined) {
				throw new Error('MCP Portal call tool was not registered.');
			}

			const result = await callTool.execute('call-1', { calls: [] }, undefined, async () => {
				throw new Error('update channel closed');
			});

			expect(result.details).toBe(coreResult);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('OpenClaw onUpdate delivery failed: update channel closed'),
			);
		} finally {
			await rm(workspace, { force: true, recursive: true });
			vi.doUnmock('@agent-vm/mcp-portal/core');
			vi.resetModules();
		}
	});

	it('rejects non-environment secrets in managed OpenClaw effective config', async () => {
		vi.resetModules();
		vi.doMock('@agent-vm/mcp-portal/core', () => ({
			createPortalCore: vi.fn(),
			createUpstreamMcpClientRuntime: vi.fn(),
			listPortalCoreToolDescriptors: () => [
				{
					description: 'Call authorized MCP tools.',
					inputSchema: { type: 'object' },
					name: 'mcp_portal_call',
				},
			],
			resolveUpstreamServers: async (props: {
				readonly resolveSecret: (secret: {
					readonly ref: string;
					readonly source: '1password';
				}) => Promise<string>;
			}) => {
				await props.resolveSecret({ ref: 'op://vault/item/field', source: '1password' });
				return [];
			},
		}));
		const { registerMcpPortalPlugin } = await import('./plugin-registration.js');
		const workspace = await mkdtemp(join(tmpdir(), 'openclaw-mcp-portal-plugin-'));
		let registeredToolFactory: OpenClawToolFactory | undefined;
		try {
			await writeFile(
				join(workspace, 'mcp.config.jsonc'),
				JSON.stringify({ providers: {}, schemaVersion: 1 }),
			);
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					profiles: { default: { namespaces: {} } },
					schemaVersion: 1,
				}),
			);

			registerMcpPortalPlugin({
				logger: { error: () => undefined, warn: () => undefined },
				on: () => undefined,
				pluginConfig: { configDir: workspace },
				registerRuntimeLifecycle: () => undefined,
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
			const callTool = tools.find((tool) => tool.name === 'mcp_portal_call');
			if (callTool === undefined) {
				throw new Error('MCP Portal call tool was not registered.');
			}

			await expect(callTool.execute('call-1', { calls: [] })).rejects.toThrow(
				/MCP Portal managed OpenClaw effective config must use environment secret refs/u,
			);
		} finally {
			await rm(workspace, { force: true, recursive: true });
			vi.doUnmock('@agent-vm/mcp-portal/core');
			vi.resetModules();
		}
	});

	it('retries managed core initialization after a transient failure', async () => {
		vi.resetModules();
		const coreResult = {
			items: [{ requestId: 'read-1', status: 'success' }],
			toolName: 'mcp_portal_call',
		};
		const close = vi.fn(async () => undefined);
		const createPortalCore = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error('transient config read failed');
			})
			.mockImplementationOnce(() => ({
				callStream: async function* () {
					yield { kind: 'completed', result: coreResult };
				},
				close,
				collectPortalCoreResult: async (
					events: AsyncIterable<{ readonly kind: 'completed'; readonly result: typeof coreResult }>,
				) => {
					for await (const event of events) {
						return event.result;
					}
					throw new Error('test stream did not complete');
				},
				createAgentScope: (scope: unknown) => scope,
			}));
		vi.doMock('@agent-vm/mcp-portal/core', () => ({
			createPortalCore,
			createUpstreamMcpClientRuntime: () => ({
				callTool: vi.fn(),
				closeAgentScope: vi.fn(),
				closeSession: vi.fn(),
				listTools: vi.fn(),
			}),
			listPortalCoreToolDescriptors: () => [
				{
					description: 'Call authorized MCP tools.',
					inputSchema: { type: 'object' },
					name: 'mcp_portal_call',
				},
			],
			resolveUpstreamServers: async () => [],
		}));
		const { registerMcpPortalPlugin } = await import('./plugin-registration.js');
		const workspace = await mkdtemp(join(tmpdir(), 'openclaw-mcp-portal-plugin-'));
		let registeredToolFactory: OpenClawToolFactory | undefined;
		try {
			await writeFile(
				join(workspace, 'mcp.config.jsonc'),
				JSON.stringify({ providers: {}, schemaVersion: 1 }),
			);
			await writeFile(
				join(workspace, 'mcp-portal.config.jsonc'),
				JSON.stringify({
					agents: { shravan: { profile: 'default' } },
					profiles: {
						default: { namespaces: {} },
					},
					schemaVersion: 1,
				}),
			);

			registerMcpPortalPlugin({
				logger: { error: () => undefined, warn: () => undefined },
				on: () => undefined,
				pluginConfig: { configDir: workspace },
				registerRuntimeLifecycle: () => undefined,
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
			const callTool = tools.find((tool) => tool.name === 'mcp_portal_call');
			if (callTool === undefined) {
				throw new Error('MCP Portal call tool was not registered.');
			}

			await expect(callTool.execute('call-1', { calls: [] })).rejects.toThrow(
				/transient config read failed/u,
			);
			const result = await callTool.execute('call-2', { calls: [] });

			expect(result.details).toBe(coreResult);
			expect(createPortalCore).toHaveBeenCalledTimes(2);
		} finally {
			await rm(workspace, { force: true, recursive: true });
			vi.doUnmock('@agent-vm/mcp-portal/core');
			vi.resetModules();
		}
	});
});
