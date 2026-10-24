import { expect, it } from 'vitest';

import { recordBatchCallAnalytics } from '#tool-host-core/call-analytics/batch-call-analytics';
import type { CallAnalytics } from '#tool-host-core/call-analytics/models/call-analytics';
import { workspaceConfigurationSchema } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { testHostedProxyLimits } from '#tool-host-core/request-limits/test-fixtures/hosted-proxy-limits';
import { createWorkspaceEngine } from '#tool-host-core/workspace-engines/workspace-engine';

it('keeps each request gateway on its catalog generation across a later request refresh', async () => {
	let nowMs = 100;
	let generation = 'first';
	const engine = await createWorkspaceEngine({
		workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		configuration: workspaceConfigurationSchema.parse({
			organizationId: '11111111-1111-4111-8111-111111111111',
			workspaceName: 'fixture',
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
				agents: { sender: { credentialVersion: 1 } },
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
		persona: 'fixture',
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
			persona: 'fixture',
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

it.each([true, false])(
	'pins access and analytics to the request catalog when initial approval is %s',
	async (initialRequiresApproval) => {
		// Arrange: the same tool changes only its trusted approval annotations.
		let nowMs = 100;
		let requiresApproval = initialRequiresApproval;
		let upstreamCalls = 0;
		const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
		const engine = await createWorkspaceEngine({
			workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			configuration: workspaceConfigurationSchema.parse({
				organizationId: '11111111-1111-4111-8111-111111111111',
				workspaceName: 'fixture',
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
					agents: { sender: { credentialVersion: 1 } },
					profiles: {
						fixture: {
							namespaces: {
								fixture: {
									tools: { allow: '*' },
									calls: { withoutApproval: { allow: [] }, requiresApproval: { allow: '*' } },
									approval: { trustedAnnotations: true },
								},
							},
						},
					},
				},
			}),
			secrets: { read: () => '12'.repeat(32) },
			clock,
			limits: testHostedProxyLimits,
			createClient: () => ({
				connect: async () => {},
				close: async () => {},
				callTool: async () => {
					upstreamCalls += 1;
					return { content: [{ type: 'text', text: 'effect' }] };
				},
				listTools: async () => ({
					tools: [
						{
							name: 'changing',
							inputSchema: { type: 'object' },
							annotations: { readOnlyHint: !requiresApproval, destructiveHint: requiresApproval },
						},
					],
				}),
			}),
			createUpstreamMcpTransport: () => ({
				start: async () => {},
				send: async () => {},
				close: async () => {},
			}),
		});
		const first = engine.gatewayFor({
			agentClientId: 'sender',
			persona: 'fixture',
			consumeTokenId: async () => ({ ok: true }),
		});
		try {
			const initialCatalog = await first.gateway.prepareCatalog();
			// Act: another request refreshes the organization while the first remains open.
			requiresApproval = !initialRequiresApproval;
			nowMs += 60_001;
			await engine.refresh();
			const second = engine.gatewayFor({
				agentClientId: 'sender',
				persona: 'fixture',
				consumeTokenId: async () => ({ ok: true }),
			});
			try {
				const refreshedCatalog = await second.gateway.prepareCatalog();
				expect(refreshedCatalog.sourceHash).not.toBe(initialCatalog.sourceHash);
				await Promise.all(
					(
						[
							[first, initialRequiresApproval],
							[second, !initialRequiresApproval],
						] as const
					).map(async ([requestEngine, expectedApproval]) => {
						const events: CallAnalytics[] = [];
						const input = {
							calls: [
								{ id: 'changing', namespace: 'fixture', toolName: 'changing', arguments: {} },
							],
						};
						const result = await requestEngine.gateway.call(input);
						// Assert actual gateway authorization, then the production analytics writer.
						expect(result.results.changing?.ok).toBe(!expectedApproval);
						if (expectedApproval)
							expect(result.results.changing).toMatchObject({
								error: { kind: 'approval_token_missing' },
							});
						recordBatchCallAnalytics({
							organizationId: '11111111-1111-4111-8111-111111111111',
							workspaceId: '22222222-2222-4222-8222-222222222222',
							workspaceName: 'fixture',
							agentClientId: 'sender',
							mode: 'indirect',
							input,
							result,
							startedAt: nowMs,
							clock,
							sink: { write: (event) => events.push(event) },
							log: () => {},
							trustedTool: requestEngine.trustedTool,
							requiresApproval: requestEngine.requiresApproval,
						});
						expect(events.at(-1)).toMatchObject({
							organizationId: '11111111-1111-4111-8111-111111111111',
							workspaceId: '22222222-2222-4222-8222-222222222222',
							workspaceName: 'fixture',
							serverName: 'fixture',
							toolName: 'changing',
							outcome: expectedApproval ? 'needs approval' : 'ran',
							failureKind: expectedApproval ? 'approval' : 'none',
						});
					}),
				);
				expect(upstreamCalls).toBe(1);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
		}
	},
);

it.each(['fresh', 'failed-refresh'] as const)(
	'reuses only settled catalog data for %s',
	async (state) => {
		const cached = {
			discoveryStartedAt: 100,
			snapshot: {
				kind: 'complete' as const,
				toolsByNamespace: new Map([
					['fixture', [{ name: 'read', inputSchema: { type: 'object' as const } }]],
				]),
				discoveryFailures: [],
			},
		};
		let discoveries = 0;
		const engine = await createWorkspaceEngine({
			workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			cachedCatalog: cached,
			configuration: workspaceConfigurationSchema.parse({
				organizationId: '11111111-1111-4111-8111-111111111111',
				workspaceName: 'fixture',
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
					agents: { sender: { credentialVersion: 1 } },
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
			clock: {
				nowMs: () => (state === 'fresh' ? 101 : 60_101),
				nowIso: () => '2026-10-22T00:00:00.000Z',
			},
			limits: testHostedProxyLimits,
			createClient: () => ({
				connect: async () => {},
				close: async () => {},
				callTool: async () => ({}),
				listTools: async () => {
					discoveries += 1;
					throw new Error('controlled discovery failure');
				},
			}),
			createUpstreamMcpTransport: () => ({
				start: async () => {},
				send: async () => {},
				close: async () => {},
			}),
		});
		const request = engine.gatewayFor({
			agentClientId: 'sender',
			persona: 'fixture',
			consumeTokenId: async () => ({ ok: true }),
		});
		try {
			expect(engine.settledCatalog()).toBe(cached);
			expect((await request.gateway.prepareCatalog()).tools.map((tool) => tool.toolName)).toEqual([
				'read',
			]);
			expect(discoveries).toBe(state === 'fresh' ? 0 : 1);
		} finally {
			await request.close();
		}
	},
);
