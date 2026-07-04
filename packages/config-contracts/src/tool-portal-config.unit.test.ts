import { describe, expect, it } from 'vitest';

import {
	createToolPortalControllerHostActionProjection,
	createToolPortalMcpProjection,
	ToolPortalControllerHostActionProjectionSchema,
	toolPortalConfigSchema,
	ToolPortalMcpProjectionSchema,
} from './tool-portal-config.js';

const validToolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	profiles: {
		'code-builder': {
			capabilities: {
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: ['delete_repo'] },
				},
				local: {
					backend: { kind: 'controller_host_action' },
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
};

describe('tool portal config contract', () => {
	it('parses complete profiles without hidden inheritance', () => {
		expect(toolPortalConfigSchema.parse(validToolPortalConfig)).toMatchObject({
			agents: { 'agent-a': { profile: 'code-builder' } },
		});

		expect(
			toolPortalConfigSchema.safeParse({
				...validToolPortalConfig,
				profiles: {
					'code-builder': {
						extends: 'base',
						...validToolPortalConfig.profiles['code-builder'],
					},
				},
			}).success,
		).toBe(false);
	});

	it('rejects missing profiles and dual MCP Portal policy authority', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validToolPortalConfig,
				agents: { 'agent-a': { profile: 'missing' } },
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validToolPortalConfig,
				mcpPortalProfile: 'code-builder',
			}).success,
		).toBe(false);
	});

	it('accepts only hard-cutover Tool Portal backend kinds', () => {
		for (const acceptedBackendKind of [
			'mcp_provider',
			'tool_vm_runner',
			'controller_host_action',
		]) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validToolPortalConfig,
					profiles: {
						'code-builder': {
							capabilities: {
								github: {
									...validToolPortalConfig.profiles['code-builder'].capabilities.github,
									backend: { kind: acceptedBackendKind },
								},
							},
						},
					},
				}).success,
			).toBe(true);
		}

		for (const legacyBackendKind of ['mcp', 'credentialed_runner']) {
			expect(
				toolPortalConfigSchema.safeParse({
					...validToolPortalConfig,
					profiles: {
						'code-builder': {
							capabilities: {
								github: {
									...validToolPortalConfig.profiles['code-builder'].capabilities.github,
									backend: { kind: legacyBackendKind },
								},
							},
						},
					},
				}).success,
			).toBe(false);
		}
	});

	it('rejects overlapping approval selectors inside one capability policy', () => {
		expect(
			toolPortalConfigSchema.safeParse({
				...validToolPortalConfig,
				profiles: {
					'code-builder': {
						capabilities: {
							github: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: ['create_issue'], deny: [] },
									withoutApproval: { allow: ['create_issue'], deny: [] },
								},
								tools: { allow: ['create_issue'], deny: [] },
							},
						},
					},
				},
			}).success,
		).toBe(false);

		expect(
			toolPortalConfigSchema.safeParse({
				...validToolPortalConfig,
				profiles: {
					'code-builder': {
						capabilities: {
							github: {
								backend: { kind: 'mcp_provider' },
								calls: {
									requiresApproval: { allow: ['create_issue'], deny: [] },
									withoutApproval: { allow: '*', deny: [] },
								},
								tools: { allow: ['create_issue'], deny: [] },
							},
						},
					},
				},
			}).success,
		).toBe(false);
	});

	it('builds a neutral MCP projection containing only MCP-backed capabilities', () => {
		const projection = createToolPortalMcpProjection({
			agentId: 'agent-a',
			config: toolPortalConfigSchema.parse(validToolPortalConfig),
		});

		expect(ToolPortalMcpProjectionSchema.parse(projection)).toEqual({
			agentId: 'agent-a',
			namespaces: {
				github: {
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue', 'create_issue'], deny: ['delete_repo'] },
				},
			},
			profile: 'code-builder',
		});
	});

	it('builds a controller host action projection containing only controller capabilities', () => {
		const projection = createToolPortalControllerHostActionProjection({
			agentId: 'agent-a',
			config: toolPortalConfigSchema.parse(validToolPortalConfig),
		});

		expect(ToolPortalControllerHostActionProjectionSchema.parse(projection)).toEqual({
			agentId: 'agent-a',
			namespaces: {
				local: {
					calls: {
						requiresApproval: { allow: ['push_branch'], deny: [] },
						withoutApproval: { allow: [], deny: [] },
					},
					tools: { allow: ['push_branch'], deny: [] },
				},
			},
			profile: 'code-builder',
		});
	});
});
