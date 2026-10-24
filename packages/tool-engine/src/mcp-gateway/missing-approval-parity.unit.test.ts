import { expect, it } from 'vitest';

import { projectProxyMcpResult } from '#mcp-gateway/proxy-results/proxy-mcp-result';
import { createHarness } from '#mcp-gateway/test-fixtures/mcp-gateway-harness';

it.each(['direct', 'indirect'] as const)(
	'keeps the legacy missing-token error for a protected %s call without effects',
	async (mode) => {
		const harness = createHarness(undefined, 'complete', {
			approvalTokens: {
				key: new Uint8Array(32).fill(0x12),
				consumeTokenId: async () => {
					throw new Error('Missing token must never reach replay.');
				},
			},
		});
		const input = {
			calls: [{ id: 'ask', namespace: 'alpha', toolName: 'ask', arguments: { value: 42 } }],
		};
		const result =
			mode === 'indirect'
				? await harness.gateway.call(input)
				: await harness.gateway.callDirect({
						name: 'alpha__ask__645775a667',
						item: 'ask',
						arguments: { value: 42 },
						catalog: await harness.gateway.prepareCatalog(),
					});
		const projected = projectProxyMcpResult({
			operation: mode === 'indirect' ? 'mcp_portal_call' : 'direct',
			input,
			result,
		});
		expect(projected).toEqual({
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						auditEvents: [],
						content: [],
						items: [
							{
								error: {
									code: 'approval_token_missing',
									message:
										'An MCP Portal approval token is required before this MCP Portal call can run.',
									namespace: 'alpha',
									toolName: 'ask',
								},
								requestId: mode === 'direct' ? 'catalog-call' : 'ask',
								status: 'failed',
							},
						],
					}),
				},
			],
			isError: true,
		});
		expect(harness.effects).toHaveLength(0);
	},
);
