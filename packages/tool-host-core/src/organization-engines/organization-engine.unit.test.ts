import { expect, it } from 'vitest';

import { organizationConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createOrganizationEngine } from '#tool-host-core/organization-engines/organization-engine';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';

it('keeps each request gateway on its catalog generation across a later request refresh', async () => {
	let nowMs = 100;
	let generation = 'first';
	const engine = await createOrganizationEngine({
		organizationId: 'fixture',
		configuration: organizationConfigurationSchema.parse({
			organizationName: 'fixture',
			approvalKeyBinding: 'KEY',
			mcp: {
				schemaVersion: 1,
				providers: {
					fixture: {
						kind: 'mcp',
						namespace: 'fixture',
						transport: { kind: 'streamable-http', url: 'https://fixture.invalid/mcp' },
					},
				},
			},
			portal: {
				schemaVersion: 1,
				agents: { sender: { profile: 'fixture' } },
				profiles: {
					fixture: {
						namespaces: {
							fixture: {
								tools: { allow: '*' },
								calls: { withoutApproval: { allow: '*' }, requiresApproval: { allow: [] } },
							},
						},
					},
				},
			},
		}),
		secrets: { read: () => '12'.repeat(32) },
		clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
		limits: testHostedProxyLimits,
		createClient: () => ({
			connect: async () => {},
			close: async () => {},
			callTool: async () => ({}),
			listTools: async () => ({ tools: [{ name: generation, inputSchema: { type: 'object' } }] }),
		}),
		createUpstreamMcpTransport: () => ({
			start: async () => {},
			send: async () => {},
			close: async () => {},
		}),
	});
	const first = engine.gatewayFor({
		agentClientId: 'sender',
		consumeTokenId: async () => ({ ok: true }),
	});
	try {
		const firstCatalog = await first.gateway.prepareCatalog();
		expect(firstCatalog.tools.map((tool) => tool.toolName)).toEqual(['first']);
		generation = 'second';
		nowMs += 60_001;
		await engine.refresh();
		const second = engine.gatewayFor({
			agentClientId: 'sender',
			consumeTokenId: async () => ({ ok: true }),
		});
		try {
			const secondCatalog = await second.gateway.prepareCatalog();
			expect(secondCatalog.tools.map((tool) => tool.toolName)).toEqual(['second']);
			expect(secondCatalog.sourceHash).not.toBe(firstCatalog.sourceHash);
			const firstAgain = await first.gateway.prepareCatalog();
			expect(firstAgain.tools.map((tool) => tool.toolName)).toEqual(['first']);
			expect(firstAgain.sourceHash).toBe(firstCatalog.sourceHash);
			expect(first.trustedTool('fixture', 'first')).toBe(true);
			expect(first.trustedTool('fixture', 'second')).toBe(false);
			expect(second.trustedTool('fixture', 'second')).toBe(true);
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
	}
});
