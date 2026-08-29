import type {
	PortalCallRequest,
	PortalCallResult,
	PortalListRequest,
} from '@agent-vm/agent-portal-sdk';
import { mcpConfigSchema, standaloneToolPortalConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
	createStandaloneToolPortalApprovalToken,
	type StandaloneToolPortalApprovalBatchIntent,
} from './standalone-entrypoint/standalone-tool-portal-approval.js';
import { createStandaloneToolPortalProjectionService } from './standalone-entrypoint/standalone-tool-portal-mcp-projection.js';
import {
	standaloneApprovalHmacKey as approvalHmacKey,
	standaloneAuthenticatedEnvelope as authenticatedEnvelope,
	standaloneBaseSemanticSnapshot as standaloneSemanticSnapshot,
	createStandaloneToolPortalFixture as createStandaloneFixture,
	standaloneMcpConfig,
	standaloneServiceGeneration as serviceGeneration,
	standaloneToolPortalConfig as standaloneConfig,
} from './standalone-tool-portal-service-test-fixture.js';
import { agentATrustedContext, createServiceFixture } from './tool-portal-service-test-fixture.js';
import {
	createToolPortalService,
	type ToolPortalStandaloneSemanticSnapshot,
} from './tool-portal-service.js';

describe('standalone-v1 ToolPortalService seam', () => {
	it('owns one precisely named subordinate capability core', () => {
		const { service } = createStandaloneFixture();

		expect(service.mode).toBe('standalone-v1');
		expect(Object.keys(service).toSorted()).toEqual(['capabilityCore', 'mode']);
		expect(service.capabilityCore.semanticSnapshot).toEqual({
			...standaloneSemanticSnapshot,
			activeRevision:
				'standalone-portal-admission:f8e47996b5ec634effe26ec461ab05470e59857a33f9c78d7a21f5f022c8c079',
			catalogRevision:
				'standalone-catalog:cb49a6d0102b42550f728818e4cd22d5bd7557b4e7af577371133b725cf91602',
			desiredRevision:
				'standalone-portal-admission:f8e47996b5ec634effe26ec461ab05470e59857a33f9c78d7a21f5f022c8c079',
		});
	});

	it('derives fresh effective identity for summary add, change, and removal with reused base revisions', () => {
		// Arrange
		const summaryStates = [undefined, 'First summary.', 'Second summary.'] as const;

		// Act
		const effectiveSnapshots = summaryStates.map((summary) => {
			const discovery = summary === undefined ? {} : { summary };
			return createStandaloneFixture({
				baseSemanticSnapshot: {
					...standaloneSemanticSnapshot,
					namespaceDiscoveryByProfile: {
						'code-builder': [{ namespace: 'github', ...discovery }],
					},
				},
				mcpConfig: mcpConfigSchema.parse({
					...standaloneMcpConfig,
					providers: {
						github: {
							...standaloneMcpConfig.providers.github,
							discovery,
						},
					},
				}),
			}).service.capabilityCore.semanticSnapshot;
		});

		// Assert
		expect(new Set(effectiveSnapshots.map(({ catalogRevision }) => catalogRevision)).size).toBe(3);
		expect(new Set(effectiveSnapshots.map(({ activeRevision }) => activeRevision)).size).toBe(3);
		for (const snapshot of effectiveSnapshots) {
			expect(snapshot.activeRevision).toBe(snapshot.desiredRevision);
			expect(snapshot.bindingRevision).toBe(standaloneSemanticSnapshot.bindingRevision);
			expect(snapshot.profilePolicyRevision).toBe(standaloneSemanticSnapshot.profilePolicyRevision);
			expect(snapshot.providerRevision).toBe(standaloneSemanticSnapshot.providerRevision);
			expect(snapshot.schemaRevision).toBe(standaloneSemanticSnapshot.schemaRevision);
		}
	});

	it('preserves a caller base active-versus-desired mismatch after derivation', () => {
		// Arrange
		const baseSemanticSnapshot = {
			...standaloneSemanticSnapshot,
			desiredRevision: 'semantic:13',
		};

		// Act
		const effectiveSemanticSnapshot = createStandaloneFixture({ baseSemanticSnapshot }).service
			.capabilityCore.semanticSnapshot;

		// Assert
		expect(effectiveSemanticSnapshot.activeRevision).not.toBe(
			effectiveSemanticSnapshot.desiredRevision,
		);
	});

	it('keeps effective revisions stable when profile record keys are reordered', () => {
		// Arrange
		const reviewerProfile = {
			namespaces: {
				gitlab: {
					backend: { kind: 'mcp_provider' as const },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_merge_request'], deny: [] },
					},
					tools: { allow: ['get_merge_request'], deny: [] },
				},
			},
		};
		const profiles = {
			'code-builder': standaloneConfig.profiles['code-builder'],
			reviewer: reviewerProfile,
		};
		const reversedProfiles = {
			reviewer: reviewerProfile,
			'code-builder': standaloneConfig.profiles['code-builder'],
		};
		const mcpConfig = mcpConfigSchema.parse({
			...standaloneMcpConfig,
			providers: {
				...standaloneMcpConfig.providers,
				gitlab: {
					discovery: { summary: 'GitLab merge request tools.' },
					kind: 'mcp',
					namespace: 'gitlab',
					transport: {
						kind: 'streamable-http',
						requiredEgressHosts: ['gitlab.example.test'],
						url: 'https://gitlab.example.test/mcp',
					},
				},
			},
		});
		const namespaceDiscoveryEntries = {
			'code-builder': [{ namespace: 'github', summary: 'GitHub repository tools.' }],
			reviewer: [{ namespace: 'gitlab', summary: 'GitLab merge request tools.' }],
		};
		const reversedNamespaceDiscoveryEntries = {
			reviewer: namespaceDiscoveryEntries.reviewer,
			'code-builder': namespaceDiscoveryEntries['code-builder'],
		};
		const surfaceEligibility = {
			'code-builder': { github: ['http', 'mcp'] },
			reviewer: { gitlab: ['mcp'] },
		} satisfies ToolPortalStandaloneSemanticSnapshot['surfaceEligibilityByProfile'];

		// Act
		const forwardSnapshot = createStandaloneFixture({
			baseSemanticSnapshot: {
				...standaloneSemanticSnapshot,
				namespaceDiscoveryByProfile: namespaceDiscoveryEntries,
				surfaceEligibilityByProfile: surfaceEligibility,
			},
			config: { ...standaloneConfig, profiles },
			mcpConfig,
		}).service.capabilityCore.semanticSnapshot;
		const reversedSnapshot = createStandaloneFixture({
			baseSemanticSnapshot: {
				...standaloneSemanticSnapshot,
				namespaceDiscoveryByProfile: reversedNamespaceDiscoveryEntries,
				surfaceEligibilityByProfile: {
					reviewer: surfaceEligibility.reviewer,
					'code-builder': surfaceEligibility['code-builder'],
				},
			},
			config: { ...standaloneConfig, profiles: reversedProfiles },
			mcpConfig,
		}).service.capabilityCore.semanticSnapshot;

		// Assert
		expect(reversedSnapshot.catalogRevision).toBe(forwardSnapshot.catalogRevision);
		expect(reversedSnapshot.activeRevision).toBe(forwardSnapshot.activeRevision);
		expect(reversedSnapshot.desiredRevision).toBe(forwardSnapshot.desiredRevision);
	});

	it('changes only opaque authority freshness across a summary-only mutation', async () => {
		// Arrange
		const summaryMarker = 'SUMMARY_MARKER_MUST_NOT_ENTER_AUTHORITY_PAYLOADS';
		const createSummaryFixture = (summary: string): ReturnType<typeof createStandaloneFixture> => {
			const discovery = { summary };
			return createStandaloneFixture({
				baseSemanticSnapshot: {
					...standaloneSemanticSnapshot,
					namespaceDiscoveryByProfile: {
						'code-builder': [{ namespace: 'github', summary }],
					},
				},
				mcpConfig: mcpConfigSchema.parse({
					...standaloneMcpConfig,
					providers: {
						github: {
							...standaloneMcpConfig.providers.github,
							discovery,
						},
					},
				}),
			});
		};
		const baseline = createSummaryFixture('Baseline GitHub summary.');
		const changed = createSummaryFixture(summaryMarker);
		const invocationOptions = {
			authenticatedEnvelope,
			correlation: { sessionId: 'summary-only-session' },
			surfaceClass: 'mcp' as const,
		};
		const directRequest = {
			calls: [
				{ arguments: { number: 42 }, id: 'direct-call', name: 'get_issue', namespace: 'github' },
			],
		} satisfies PortalCallRequest;
		const protectedRequest = {
			calls: [
				{
					arguments: { title: 'Review summary isolation' },
					id: 'protected-call',
					name: 'create_issue',
					namespace: 'github',
				},
			],
		} satisfies PortalCallRequest;
		const searchRequest = {
			requests: [
				{
					id: 'search',
					limit: 20,
					query: 'issue',
					schemaDetail: 'summary' as const,
				},
			],
		};
		const describeRequest = {
			requests: [
				{
					id: 'describe',
					includeJsonSchema: false,
					includeRelated: false,
					includeTypescriptHelper: false,
					includeZod: false,
					tools: [{ name: 'get_issue', namespace: 'github' }],
				},
			],
		};
		const executeProtectedCall = async (
			fixture: ReturnType<typeof createSummaryFixture>,
		): Promise<{
			readonly approvalToken: string;
			readonly challenge: PortalCallResult;
			readonly intent: StandaloneToolPortalApprovalBatchIntent;
			readonly result: PortalCallResult;
		}> => {
			const projection = createStandaloneToolPortalProjectionService(fixture.service);
			const challenge = await projection.call(protectedRequest, invocationOptions);
			const intent = fixture.approvalIntents.at(-1);
			if (intent === undefined) throw new Error('Expected a protected-call approval intent.');
			const approvalToken = createStandaloneToolPortalApprovalToken({
				expiresAt: '2026-07-18T12:01:00.000Z',
				hmacKey: approvalHmacKey,
				intent,
				keyVersion: 1,
				tokenId:
					intent.semanticRevisions.activeRevision ===
					baseline.service.capabilityCore.semanticSnapshot.activeRevision
						? '10000000-0000-4000-8000-000000000011'
						: '10000000-0000-4000-8000-000000000012',
			});
			const result = await projection.call(protectedRequest, {
				...invocationOptions,
				approvalToken,
			});
			return { approvalToken, challenge, intent, result };
		};

		// Act
		const [baselineDirectResult, changedDirectResult] = await Promise.all([
			createStandaloneToolPortalProjectionService(baseline.service).call(
				directRequest,
				invocationOptions,
			),
			createStandaloneToolPortalProjectionService(changed.service).call(
				directRequest,
				invocationOptions,
			),
		]);
		const [baselineSearch, changedSearch, baselineDescribe, changedDescribe] = await Promise.all([
			createStandaloneToolPortalProjectionService(baseline.service).search(
				searchRequest,
				invocationOptions,
			),
			createStandaloneToolPortalProjectionService(changed.service).search(
				searchRequest,
				invocationOptions,
			),
			createStandaloneToolPortalProjectionService(baseline.service).describe(
				describeRequest,
				invocationOptions,
			),
			createStandaloneToolPortalProjectionService(changed.service).describe(
				describeRequest,
				invocationOptions,
			),
		]);
		const [baselineProtected, changedProtected] = await Promise.all([
			executeProtectedCall(baseline),
			executeProtectedCall(changed),
		]);
		const baselineDirectInvocation = baseline.backend.callInvocations[0];
		const changedDirectInvocation = changed.backend.callInvocations[0];
		const baselineProtectedInvocation = baseline.backend.callInvocations[1];
		const changedProtectedInvocation = changed.backend.callInvocations[1];

		// Assert
		expect(changed.service.capabilityCore.semanticSnapshot.catalogRevision).not.toBe(
			baseline.service.capabilityCore.semanticSnapshot.catalogRevision,
		);
		expect(changed.service.capabilityCore.semanticSnapshot.activeRevision).not.toBe(
			baseline.service.capabilityCore.semanticSnapshot.activeRevision,
		);
		expect(changedDirectResult.items[0]?.operationId).not.toBe(
			baselineDirectResult.items[0]?.operationId,
		);
		expect(changedProtected.intent.protectedCalls[0]?.operationId).not.toBe(
			baselineProtected.intent.protectedCalls[0]?.operationId,
		);
		if (
			baselineDirectInvocation?.[1].dispatchAuthority.kind !== 'without-approval' ||
			changedDirectInvocation?.[1].dispatchAuthority.kind !== 'without-approval'
		) {
			throw new Error('Expected direct standalone dispatch authorities.');
		}
		expect(changedDirectInvocation[1].dispatchAuthority.fingerprint).not.toBe(
			baselineDirectInvocation[1].dispatchAuthority.fingerprint,
		);
		expect(baselineDirectResult.items[0]).toMatchObject({
			owningGeneration: standaloneSemanticSnapshot.activeRevision,
			status: 'ok',
			value: { backend: 'mcp-provider' },
		});
		expect(changedDirectResult.items[0]).toMatchObject({
			owningGeneration: standaloneSemanticSnapshot.activeRevision,
			status: 'ok',
			value: { backend: 'mcp-provider' },
		});
		expect(baselineProtected.result.items[0]).toMatchObject({
			owningGeneration: standaloneSemanticSnapshot.activeRevision,
			status: 'ok',
			value: { backend: 'mcp-provider' },
		});
		expect(changedProtected.result.items[0]).toMatchObject({
			owningGeneration: standaloneSemanticSnapshot.activeRevision,
			status: 'ok',
			value: { backend: 'mcp-provider' },
		});
		expect(baselineProtected.challenge.items[0]?.status).toBe('approval_required');
		expect(changedProtected.challenge.items[0]?.status).toBe('approval_required');
		expect(baselineProtected.intent.authenticatedEnvelope.serviceGeneration).toBe(
			serviceGeneration,
		);
		expect(changedProtected.intent.authenticatedEnvelope.serviceGeneration).toBe(serviceGeneration);
		for (const invocation of [baselineProtectedInvocation, changedProtectedInvocation]) {
			if (invocation?.[1].dispatchAuthority.kind !== 'standalone-hmac-batch') {
				throw new Error('Expected protected standalone dispatch authority.');
			}
			expect(invocation[1].dispatchAuthority.approval.serviceGeneration).toBe(serviceGeneration);
		}
		expect(changedSearch.items[0]?.status).toBe('ok');
		expect(changedDescribe.items[0]?.status).toBe('ok');
		if (
			baselineSearch.items[0]?.status !== 'ok' ||
			changedSearch.items[0]?.status !== 'ok' ||
			baselineDescribe.items[0]?.status !== 'ok' ||
			changedDescribe.items[0]?.status !== 'ok'
		) {
			throw new Error('Expected successful standalone discovery results.');
		}
		expect(changedSearch.items[0].value.tools).toEqual(baselineSearch.items[0].value.tools);
		expect(changedDescribe.items[0].value.tools).toEqual(baselineDescribe.items[0].value.tools);
		expect(changedSearch.items[0].value.namespaceDiscovery).toEqual([
			{ namespace: 'github', summary: summaryMarker },
		]);
		expect(
			JSON.stringify({
				approvalIntents: changed.approvalIntents,
				backendCalls: changed.backend.callInvocations,
				directResult: changedDirectResult,
				protected: changedProtected,
			}),
		).not.toContain(summaryMarker);
	});

	it('keeps standalone identity distinct from managed framework identity', async () => {
		const { service } = createStandaloneFixture();
		const standaloneOptions = {
			correlation: { sessionId: 'standalone-session' },
			origin: { authenticatedEnvelope, kind: 'standalone' as const },
			surfaceClass: 'mcp' as const,
		};
		const forgedStandaloneOrigin = {
			...standaloneOptions,
			origin: {
				...standaloneOptions.origin,
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			},
		};

		await expect(
			service.capabilityCore.list(
				{ requests: [{ id: 'list', limit: 20 }] },
				forgedStandaloneOrigin,
			),
		).rejects.toThrow();
		expect(standaloneOptions.origin).not.toHaveProperty('frameworkIdentity');
	});

	it('reserves and arms one exact ordered HMAC batch before protected dispatch', async () => {
		const fixture = createStandaloneFixture();
		const projection = createStandaloneToolPortalProjectionService(fixture.service);
		const effectiveSemanticSnapshot = fixture.service.capabilityCore.semanticSnapshot;
		const request = {
			calls: [
				{ arguments: { title: 'first' }, id: 'call-a', name: 'create_issue', namespace: 'github' },
				{ arguments: { title: 'second' }, id: 'call-b', name: 'create_issue', namespace: 'github' },
			],
		} satisfies PortalCallRequest;
		const invocationOptions = {
			authenticatedEnvelope,
			correlation: { sessionId: 'standalone-session' },
			surfaceClass: 'mcp' as const,
		};
		const challenge = await projection.call(request, invocationOptions);
		const protectedCalls = request.calls.map((call, index) => {
			const operationId = challenge.items[index]?.operationId;
			if (operationId === undefined) throw new Error('Expected deterministic operation id.');
			return { call, operationId };
		});
		const intent = {
			authenticatedEnvelope,
			protectedCalls,
			semanticRevisions: {
				activeRevision: effectiveSemanticSnapshot.activeRevision,
				bindingRevision: effectiveSemanticSnapshot.bindingRevision,
				catalogRevision: effectiveSemanticSnapshot.catalogRevision,
				profilePolicyRevision: effectiveSemanticSnapshot.profilePolicyRevision,
				providerRevision: effectiveSemanticSnapshot.providerRevision,
				schemaRevision: effectiveSemanticSnapshot.schemaRevision,
			},
			surfaceClass: 'mcp',
		} satisfies StandaloneToolPortalApprovalBatchIntent;
		const approvalToken = createStandaloneToolPortalApprovalToken({
			expiresAt: '2026-07-18T12:01:00.000Z',
			hmacKey: approvalHmacKey,
			intent,
			keyVersion: 1,
			tokenId: '10000000-0000-4000-8000-000000000001',
		});

		const result = await projection.call(request, { ...invocationOptions, approvalToken });

		expect(result.ok).toBe(true);
		expect(fixture.backend.callInvocations).toHaveLength(2);
		for (const [publicRequest, options] of fixture.backend.callInvocations) {
			expect(publicRequest).not.toHaveProperty('approvalToken');
			expect(options).not.toHaveProperty('approvalToken');
			expect(options.origin.kind).toBe('standalone');
			expect(options.origin).not.toHaveProperty('frameworkIdentity');
			expect(options.dispatchAuthority).toMatchObject({
				approval: {
					kind: 'standalone-hmac-batch',
					operationIds: protectedCalls.map(({ operationId }) => operationId),
				},
				kind: 'standalone-hmac-batch',
			});
		}
	});

	it('returns matched MCP-provider visibility through managed and standalone adapters', async () => {
		const managed = createServiceFixture();
		const standalone = createStandaloneFixture();
		const request = { requests: [{ id: 'list', limit: 20 }] } satisfies PortalListRequest;

		const [managedResult, standaloneResult] = await Promise.all([
			managed.capabilityCore.list(request, {
				origin: { kind: 'managed', trustedContext: agentATrustedContext },
				surfaceClass: 'mcp',
			}),
			createStandaloneToolPortalProjectionService(standalone.service).list(request, {
				authenticatedEnvelope,
				correlation: { sessionId: 'standalone-session' },
				surfaceClass: 'mcp',
			}),
		]);

		expect(standaloneResult).toEqual(managedResult);
	});

	it('admits no privileged backend ports in standalone construction', () => {
		const fixture = createStandaloneFixture();
		const createInvalidStandaloneService = (): void => {
			createToolPortalService({
				approvalCoordinator: fixture.approvalCoordinator,
				baseSemanticSnapshot: standaloneSemanticSnapshot,
				backendPorts: {
					// @ts-expect-error Standalone version 1 accepts only the MCP-provider port.
					controllerExecution: vi.fn(),
					mcpProvider: fixture.backend.port,
				},
				config: standaloneConfig,
				mcpConfig: standaloneMcpConfig,
			});
		};

		expect(createInvalidStandaloneService).toBeTypeOf('function');
	});

	it.each(['controller_execution', 'tool_vm_runner'] as const)(
		'rejects the privileged %s backend during standalone service startup',
		(backendKind) => {
			const privilegedBackend: unknown =
				backendKind === 'controller_execution'
					? {
							kind: backendKind,
							operations: { controller_host_probe: { kind: 'registered_action' } },
						}
					: {
							kind: backendKind,
							operations: {
								read_file: {
									description: 'Read one bounded file.',
									kind: 'filesystem.read',
								},
							},
							profile: 'sandbox_ssh',
						};

			const parsedPrivilegedConfig = standaloneToolPortalConfigSchema.parse({
				...standaloneConfig,
				profiles: {
					'code-builder': {
						namespaces: {
							privileged: {
								discovery: {},
								backend: privilegedBackend,
								calls: {
									requiresApproval: { allow: [], deny: [] },
									withoutApproval: { allow: '*', deny: [] },
								},
								tools: { allow: '*', deny: [] },
							},
						},
					},
				},
			});
			const fixture = createStandaloneFixture();
			expect(() =>
				createToolPortalService({
					approvalCoordinator: fixture.approvalCoordinator,
					baseSemanticSnapshot: standaloneSemanticSnapshot,
					backendPorts: { mcpProvider: fixture.backend.port },
					config: parsedPrivilegedConfig,
					mcpConfig: standaloneMcpConfig,
				}),
			).toThrow('Standalone Tool Portal version 1 does not admit the privileged');
		},
	);
});
