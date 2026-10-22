import * as nodeHost from '@agent-collaboration/tool-host-node';
import { ToolPortalMcpProjectionSchema } from '@agent-vm/config-contracts';
import { ToolSchema } from '@modelcontextprotocol/core';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, vi } from 'vitest';

import {
	createManagedMcpProviderBackendFactoryFromConfig,
	type ManagedMcpProviderBackendFactory,
	type McpProviderCapabilityBackend,
} from '#gateway-runtime/backends/managed-mcp-provider-backend';

const githubTools = [
	{
		description: 'Read issue',
		inputSchema: {
			properties: { number: { type: 'number' } },
			required: ['number'],
			type: 'object',
		},
		name: 'get_issue',
	},
	{
		description: 'Create issue',
		inputSchema: {
			properties: { title: { type: 'string' } },
			required: ['title'],
			type: 'object',
		},
		name: 'create_issue',
	},
] satisfies readonly Tool[];

const factories: ManagedMcpProviderBackendFactory[] = [];
vi.mock('@agent-collaboration/tool-host-node', async (importOriginal) => ({
	...(await importOriginal<typeof import('@agent-collaboration/tool-host-node')>()),
	resolveUpstreamServers: vi.fn(),
	createNodeProviderRuntime: vi.fn(),
}));
afterEach(async () => {
	await Promise.all(factories.splice(0).map(async (factory) => await factory.close()));
	vi.clearAllMocks();
});
interface FixtureOptions {
	readonly callUpstreamTool?: (call: {
		readonly arguments: Record<string, unknown>;
		readonly namespace: string;
		readonly toolName: string;
		readonly agentScopeId: string;
	}) => Promise<unknown>;
	readonly listTools?: (props: { readonly namespace: string }) => Promise<readonly Tool[]>;
}
async function createFactoryFixture(
	options: FixtureOptions = {},
): Promise<ManagedMcpProviderBackendFactory> {
	vi.mocked(nodeHost.resolveUpstreamServers).mockResolvedValue([
		{ namespace: 'github', transport: 'streamable-http', url: 'https://controlled.invalid' },
		{ namespace: 'linear', transport: 'streamable-http', url: 'https://controlled.invalid' },
	]);
	vi.mocked(nodeHost.createNodeProviderRuntime).mockReturnValue({
		callTool:
			options.callUpstreamTool ??
			(async (call) => ({
				arguments: call.arguments,
				ok: true,
				upstreamTool: `${call.namespace}.${call.toolName}`,
			})),
		listTools: async (call) =>
			(
				await (options.listTools?.(call) ??
					Promise.resolve(call.namespace === 'github' ? githubTools : []))
			).map((tool) => ToolSchema.parse(tool)),
		closeAgentScope: async () => undefined,
		closeSession: async () => undefined,
	});
	const factory = await createManagedMcpProviderBackendFactoryFromConfig({
		mcpConfig: { schemaVersion: 1, providers: {} },
		resolveSecret: async () => {
			throw new Error('No secret required by the controlled unit edge');
		},
	});
	factories.push(factory);
	return factory;
}
const defaultProjection = ToolPortalMcpProjectionSchema.parse({
	agentId: 'agent-a',
	namespaces: {
		github: {
			calls: {
				requiresApproval: { allow: ['create_issue'], deny: [] },
				withoutApproval: { allow: ['get_issue'], deny: [] },
			},
			tools: { allow: ['get_issue', 'create_issue'], deny: [] },
		},
	},
	profile: 'code-builder',
});
async function createBackendFixture(
	options: FixtureOptions = {},
): Promise<McpProviderCapabilityBackend> {
	return (await createFactoryFixture(options)).createBackend(defaultProjection);
}

export { createBackendFixture, createFactoryFixture, defaultProjection, githubTools };
