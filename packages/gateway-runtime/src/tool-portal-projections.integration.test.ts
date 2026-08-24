import {
	PortalArtifactReadRequestSchema,
	PortalCallRequestSchema,
	type PortalCallRequest,
	PortalDescribeRequestSchema,
	type PortalDescribeRequest,
	PortalListRequestSchema,
	type PortalListRequest,
	PortalSearchRequestSchema,
	type PortalSearchRequest,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalListResult,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeRequestOptions,
	type GatewayRuntimeTransportFactory,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type { ToolPortalBackendKind, ToolPortalConfig } from '@agent-vm/config-contracts';
import {
	GatewayRuntimeTrustedInvocationContextSchema,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalApprovalPort,
	type ToolPortalBackendPort,
	type ToolPortalInvocationOptions,
	type ToolPortalCapabilityCore,
	type ToolPortalTrustedInvocationContext,
} from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntimeArtifactReader } from './artifacts/artifact-store.js';
import {
	createGatewayRuntimeToolPortalComposition,
	type GatewayRuntimePortalProjectionOperations,
	type GatewayRuntimePortalProjectionResult,
	type GatewayRuntimePrivateUdsProjectionFactoryProps,
} from './tool-portal-projections.js';

const AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS = [
	'portal',
	'artifact.read',
	'sandbox.environment',
	'sandbox.execution',
	'sandbox.filesystem',
	'sandbox.process',
	'sandbox.retained-results',
	'sandbox.stream',
	'sandbox.terminal',
] as const;

const toolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
		'agent-b': { profile: 'code-builder' },
	},
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				controller_execution: {
					backend: {
						kind: 'controller_execution',
						operations: {
							controller_host_probe: { kind: 'registered_action' },
							workspace_git_push: { kind: 'registered_action' },
							push_branch: { kind: 'registered_action' },
							protected_uds: { kind: 'registered_action' },
						},
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['workspace_git_push'], deny: [] },
					},
					tools: { allow: ['workspace_git_push'], deny: [] },
				},
				github: {
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
				sandbox: {
					backend: {
						kind: 'tool_vm_runner',
						operations: {
							exec: {
								description: 'Run the fixture command.',
								executable: '/usr/bin/true',
								kind: 'command.fixed',
								mandatoryArgvPrefix: [],
								workingDirectory: '.',
							},
						},
						profile: 'sandbox_ssh',
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['exec'], deny: [] },
					},
					tools: { allow: ['exec'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies ToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalNamespaceNames: ['controller_execution', 'github', 'sandbox'],
			toolPortalProfileId: 'code-builder',
		},
		'agent-b': {
			agentId: 'agent-b',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-b' },
			profileAssignmentRevision: 'profile-assignment:agent-b:4',
			toolPortalNamespaceNames: ['controller_execution', 'github', 'sandbox'],
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:9',
	catalogRevision: 'catalog:12',
	desiredRevision: 'semantic:12',
	profilePolicyRevision: 'policy:7',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'provider:5',
	schemaRevision: 'schema:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': {
			controller_execution: ['protected_uds'],
			github: ['protected_uds'],
			sandbox: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const agentATrustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} satisfies ToolPortalTrustedInvocationContext;

const agentBTrustedContext = {
	correlation: { runId: 'run-b', sessionId: 'session-b', toolCallId: 'tool-call-b' },
	principal: {
		agentId: 'agent-b',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-b' },
		profileAssignmentRevision: 'profile-assignment:agent-b:4',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-b' },
} satisfies ToolPortalTrustedInvocationContext;

type PortalOperation = 'call' | 'describe' | 'list' | 'search';
type PortalRequest =
	| PortalCallRequest
	| PortalDescribeRequest
	| PortalListRequest
	| PortalSearchRequest;

type RecordingPrivateUdsProjection = Pick<
	GatewayRuntimePrivateUdsProjectionFactoryProps,
	'artifactOperations' | 'authenticatedOperationGroups' | 'capabilityCore' | 'portalOperations'
>;

interface RecordingBackendInvocation {
	readonly operation: PortalOperation;
	readonly options: ToolPortalInvocationOptions;
	readonly request: PortalRequest;
}

interface RecordingBackendPort<TBackendKind extends ToolPortalBackendKind> {
	readonly invocations: RecordingBackendInvocation[];
	readonly port: ToolPortalBackendPort<TBackendKind>;
}

interface RecordingComposition {
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly privateUdsProjection: RecordingPrivateUdsProjection;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}

interface RecordingCompositionFixture {
	readonly approvalPort: ToolPortalApprovalPort;
	readonly artifactReadRequests: Parameters<GatewayRuntimeArtifactReader['read']>[0][];
	readonly backendPorts: {
		readonly controllerExecution: RecordingBackendPort<'controller_execution'>;
		readonly mcpProvider: RecordingBackendPort<'mcp_provider'>;
		readonly toolVmRunner: RecordingBackendPort<'tool_vm_runner'>;
	};
	readonly composition: RecordingComposition;
	readonly createCapabilityCoreForComposition: (props: {
		readonly approvalPort: ToolPortalApprovalPort;
		readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	}) => ToolPortalCapabilityCore<'managed'>;
	readonly privateUdsFactoryCalls: readonly GatewayRuntimePrivateUdsProjectionFactoryProps[];
}

interface CapturedGatewayRuntimeRequest {
	readonly method: string;
	readonly options: GatewayRuntimeRequestOptions | undefined;
	readonly params: unknown;
}

interface GatewayRuntimeClientProjectionFixture {
	readonly attachmentHandshakes: readonly GatewayRuntimeAttachmentMetadata[];
	readonly client: GatewayRuntimeClient;
	readonly connectedSocketPaths: readonly string[];
	readonly wireRequests: readonly CapturedGatewayRuntimeRequest[];
}

interface TrustedPortalRequestOptions {
	readonly signal?: AbortSignal;
	readonly trustedContext: ToolPortalTrustedInvocationContext;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function invokeParsedPortalOperation(props: {
	readonly method: string;
	readonly operations: GatewayRuntimePortalProjectionOperations;
	readonly publicRequest: unknown;
	readonly trustedContext: ToolPortalTrustedInvocationContext;
}): Promise<GatewayRuntimePortalProjectionResult> {
	switch (props.method) {
		case 'portal.call':
			return await props.operations.call({
				publicRequest: PortalCallRequestSchema.parse(props.publicRequest),
				trustedContext: props.trustedContext,
			});
		case 'portal.describe':
			return await props.operations.describe({
				publicRequest: PortalDescribeRequestSchema.parse(props.publicRequest),
				trustedContext: props.trustedContext,
			});
		case 'portal.list':
			return await props.operations.list({
				publicRequest: PortalListRequestSchema.parse(props.publicRequest),
				trustedContext: props.trustedContext,
			});
		case 'portal.search':
			return await props.operations.search({
				publicRequest: PortalSearchRequestSchema.parse(props.publicRequest),
				trustedContext: props.trustedContext,
			});
		default:
			throw new Error(`Unexpected Gateway runtime method: ${props.method}`);
	}
}

function trustedPortalRequestOptions(
	trustedContext: ToolPortalTrustedInvocationContext,
): TrustedPortalRequestOptions {
	return { trustedContext };
}

function createGatewayRuntimeClientProjectionFixture(
	compositionFixture: RecordingCompositionFixture,
): GatewayRuntimeClientProjectionFixture {
	const attachmentHandshakes: GatewayRuntimeAttachmentMetadata[] = [];
	const connectedSocketPaths: string[] = [];
	const wireRequests: CapturedGatewayRuntimeRequest[] = [];
	const transportFactory: GatewayRuntimeTransportFactory = {
		connect: ({ socketPath }) => {
			connectedSocketPaths.push(socketPath);
			return Promise.resolve({
				close: () => Promise.resolve(),
				handshake: (attachment) => {
					attachmentHandshakes.push(attachment);
					return Promise.resolve();
				},
				request: async (method, params, options) => {
					wireRequests.push({ method, options, params });
					if (
						!isRecord(params) ||
						Object.keys(params).toSorted().join(',') !== 'publicRequest,trustedContext'
					) {
						throw new Error(
							'Gateway runtime portal wire params must separate publicRequest and trustedContext.',
						);
					}
					return await invokeParsedPortalOperation({
						method,
						operations: compositionFixture.composition.privateUdsProjection.portalOperations,
						publicRequest: params['publicRequest'],
						trustedContext: GatewayRuntimeTrustedInvocationContextSchema.parse(
							params['trustedContext'],
						),
					});
				},
			});
		},
	};
	const client = new GatewayRuntimeClient({
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'framework-epoch-7',
			gatewayEpoch: 'gateway-epoch-7',
			protocolVersion: 1,
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			runtimeEpoch: 'runtime-epoch-7',
			schemaVersion: 1,
		},
		socketPath: '/run/agent-vm/gateway-runtime/test-managed-plugin.sock',
		transportFactory,
	});
	return { attachmentHandshakes, client, connectedSocketPaths, wireRequests };
}

function createRecordingBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
	namespace: string,
): RecordingBackendPort<TBackendKind> {
	const invocations: RecordingBackendInvocation[] = [];
	return {
		invocations,
		port: {
			backendKind,
			call: (request, options): Promise<PortalCallResult> => {
				invocations.push({ operation: 'call', options, request });
				const parsedRequest = PortalCallRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.calls.map((call) => ({
						id: call.id,
						operationId: `${namespace}:${call.id}`,
						outcome: {
							certainty: 'proven' as const,
							completion: 'succeeded' as const,
							kind: 'completed' as const,
							retryClass: 'forbidden' as const,
						},
						owningGeneration: 'gateway-epoch-7',
						status: 'ok' as const,
						value: { backendNamespace: namespace },
					})),
					ok: true,
				});
			},
			describe: (request, options): Promise<PortalDescribeResult> => {
				invocations.push({ operation: 'describe', options, request });
				const parsedRequest = PortalDescribeRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { tools: [] },
					})),
					ok: true,
				});
			},
			list: (request, options): Promise<PortalListResult> => {
				invocations.push({ operation: 'list', options, request });
				const parsedRequest = PortalListRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { namespaces: [namespace], tools: [] },
					})),
					ok: true,
				});
			},
			search: (request, options): Promise<PortalSearchResult> => {
				invocations.push({ operation: 'search', options, request });
				const parsedRequest = PortalSearchRequestSchema.parse(request);
				return Promise.resolve({
					items: parsedRequest.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { tools: [] },
					})),
					ok: true,
				});
			},
		},
	};
}

function createRecordingPrivateUdsProjection(
	props: GatewayRuntimePrivateUdsProjectionFactoryProps,
): RecordingPrivateUdsProjection {
	return Object.freeze({
		authenticatedOperationGroups: props.authenticatedOperationGroups,
		artifactOperations: props.artifactOperations,
		capabilityCore: props.capabilityCore,
		portalOperations: props.portalOperations,
	});
}

function composeRecordingProjections(
	projectionCohortDigest: string = semanticSnapshot.projectionCohortDigest,
	configuredAgentIds: readonly string[] = ['agent-a', 'agent-b'],
): RecordingCompositionFixture {
	const approvalPort = {
		armDispatch: (): Promise<never> =>
			Promise.reject(new Error('Approval dispatch is not expected in projection tests.')),
		reserveDispatch: (): Promise<never> =>
			Promise.reject(new Error('Approval admission is not expected in projection tests.')),
	} satisfies ToolPortalApprovalPort;
	const artifactReadRequests: Parameters<GatewayRuntimeArtifactReader['read']>[0][] = [];
	const artifactReader = {
		read: vi.fn(async (props: Parameters<GatewayRuntimeArtifactReader['read']>[0]) => {
			artifactReadRequests.push(props);
			return {
				contentBase64: 'AQI=',
				mediaType: props.request.reference.mediaType ?? 'application/octet-stream',
				offsetBytes: props.request.offsetBytes,
				reference: props.request.reference,
				truncated: true,
			};
		}),
	} satisfies GatewayRuntimeArtifactReader;
	const backendPorts = {
		controllerExecution: createRecordingBackendPort('controller_execution', 'controller_execution'),
		mcpProvider: createRecordingBackendPort('mcp_provider', 'github'),
		toolVmRunner: createRecordingBackendPort('tool_vm_runner', 'sandbox'),
	};
	const createCapabilityCoreForComposition = vi.fn(
		(props: {
			readonly approvalPort: ToolPortalApprovalPort;
			readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
		}): ToolPortalCapabilityCore<'managed'> =>
			createManagedToolPortalCapabilityCore({
				approvalPort: props.approvalPort,
				backendPorts: {
					controllerExecution: backendPorts.controllerExecution.port,
					mcpProvider: backendPorts.mcpProvider.port,
					toolVmRunner: backendPorts.toolVmRunner.port,
				},
				config: toolPortalConfig,
				semanticSnapshot: props.semanticSnapshot,
			}),
	);
	const privateUdsFactoryCalls: GatewayRuntimePrivateUdsProjectionFactoryProps[] = [];
	const composition: RecordingComposition = createGatewayRuntimeToolPortalComposition({
		approvalPort,
		authenticatedPrivateUdsOperationGroups: AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
		artifactReader,
		createPrivateUdsProjection: (props) => {
			privateUdsFactoryCalls.push(props);
			return createRecordingPrivateUdsProjection(props);
		},
		createToolPortalCapabilityCore: createCapabilityCoreForComposition,
		managedPluginAttachment: {
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds,
			projectionCohortDigest,
		},
		semanticSnapshot,
	});
	return {
		approvalPort,
		artifactReadRequests,
		backendPorts,
		composition,
		createCapabilityCoreForComposition,
		privateUdsFactoryCalls,
	};
}

function totalBackendInvocations(fixture: RecordingCompositionFixture): number {
	return (
		fixture.backendPorts.controllerExecution.invocations.length +
		fixture.backendPorts.mcpProvider.invocations.length +
		fixture.backendPorts.toolVmRunner.invocations.length
	);
}

describe('Gateway runtime Tool Portal projections', () => {
	it('rejects duplicate configured agent ids before exact-set normalization', () => {
		expect(() =>
			composeRecordingProjections(semanticSnapshot.projectionCohortDigest, [
				'agent-a',
				'agent-a',
				'agent-b',
			]),
		).toThrow('duplicate configured agent');
	});
	it('rejects a managed attachment for the wrong exact projection cohort', () => {
		expect(() =>
			composeRecordingProjections(
				'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			),
		).toThrow('projection cohort digest does not match');
	});
	it('constructs one capability core and gives that exact core and snapshot only to private UDS', () => {
		const fixture = composeRecordingProjections();

		expect(Object.keys(fixture.composition).toSorted()).toEqual([
			'capabilityCore',
			'privateUdsProjection',
			'semanticSnapshot',
		]);
		expect(fixture.createCapabilityCoreForComposition).toHaveBeenCalledTimes(1);
		expect(fixture.createCapabilityCoreForComposition).toHaveBeenCalledWith({
			approvalPort: fixture.approvalPort,
			semanticSnapshot,
		});
		expect(fixture.privateUdsFactoryCalls).toHaveLength(1);
		expect(fixture.privateUdsFactoryCalls[0]?.capabilityCore).toBe(
			fixture.composition.capabilityCore,
		);
		expect(fixture.privateUdsFactoryCalls[0]?.semanticSnapshot).toBe(
			fixture.composition.capabilityCore.semanticSnapshot,
		);
		expect(fixture.composition.capabilityCore.semanticSnapshot).toEqual(semanticSnapshot);
		expect(fixture.composition.semanticSnapshot).toBe(
			fixture.composition.capabilityCore.semanticSnapshot,
		);
		expect(Object.isFrozen(fixture.composition.semanticSnapshot)).toBe(true);
		expect(Object.isFrozen(fixture.composition.semanticSnapshot.agentProjections)).toBe(true);
		expect(Object.isFrozen(fixture.composition.semanticSnapshot.surfaceEligibilityByProfile)).toBe(
			true,
		);
	});

	it('exposes only configured authenticated private-UDS groups', () => {
		const fixture = composeRecordingProjections();

		expect(fixture.composition.privateUdsProjection.authenticatedOperationGroups).toEqual(
			AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
		);
		expect(fixture.privateUdsFactoryCalls[0]?.authenticatedOperationGroups).toEqual(
			AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
		);
		expect(
			Object.isFrozen(fixture.composition.privateUdsProjection.authenticatedOperationGroups),
		).toBe(true);

		const privateUdsGroups = fixture.composition.privateUdsProjection.authenticatedOperationGroups
			.join(' ')
			.toLowerCase();
		for (const controllerAuthority of ['ssh', 'lease', 'pid', 'gateway.lifecycle']) {
			expect(privateUdsGroups).not.toContain(controllerAuthority);
		}
	});

	it('uses one long-lived projection for distinct verified agent contexts without mutation', async () => {
		const fixture = composeRecordingProjections();
		const snapshotBeforeInvocations = JSON.stringify(semanticSnapshot);
		const privateUdsProjection = fixture.composition.privateUdsProjection;

		await privateUdsProjection.portalOperations.list({
			publicRequest: PortalListRequestSchema.parse({
				requests: [{ id: 'list-a', namespaces: ['github'] }],
			}),
			trustedContext: agentATrustedContext,
		});
		await privateUdsProjection.portalOperations.search({
			publicRequest: PortalSearchRequestSchema.parse({
				requests: [{ id: 'search-b', namespaces: ['github'], query: 'issues' }],
			}),
			trustedContext: agentBTrustedContext,
		});

		expect(fixture.composition.privateUdsProjection).toBe(privateUdsProjection);
		expect(fixture.backendPorts.mcpProvider.invocations.map(({ options }) => options)).toEqual([
			{ surfaceClass: 'protected_uds', trustedContext: agentATrustedContext },
			{ surfaceClass: 'protected_uds', trustedContext: agentBTrustedContext },
		]);
		expect(JSON.stringify(semanticSnapshot)).toBe(snapshotBeforeInvocations);
		expect(fixture.composition.capabilityCore.semanticSnapshot).toEqual(semanticSnapshot);
	});

	it('derives protected-UDS artifact authority from trusted context without session fields', async () => {
		// Arrange
		const fixture = composeRecordingProjections();
		const request = PortalArtifactReadRequestSchema.parse({
			maxBytes: 2,
			offsetBytes: 0,
			reference: {
				byteLength: 4,
				expiresAt: '2026-07-13T18:00:00.000Z',
				fingerprint: `sha256:${'1'.repeat(64)}`,
				id: 'artifact-a',
				mediaType: 'application/octet-stream',
			},
		});

		// Act
		const result = await fixture.composition.privateUdsProjection.artifactOperations.read({
			publicRequest: request,
			trustedContext: agentATrustedContext,
		});

		// Assert
		expect(result).toMatchObject({ contentBase64: 'AQI=', reference: request.reference });
		expect(fixture.artifactReadRequests).toEqual([
			{
				caller: {
					principal: agentATrustedContext.principal,
					surfaceClass: 'protected_uds',
				},
				request,
			},
		]);
	});

	it('carries complete trusted context separately through one real client and the sole UDS projection', async () => {
		const fixture = composeRecordingProjections();
		const clientFixture = createGatewayRuntimeClientProjectionFixture(fixture);
		const matchedPublicRequest = {
			requests: [{ id: 'matched-list-a', limit: 20, namespaces: ['github'] }],
		};

		await clientFixture.client.connect();
		try {
			const directUdsResult = await fixture.composition.privateUdsProjection.portalOperations.list({
				publicRequest: matchedPublicRequest,
				trustedContext: agentATrustedContext,
			});
			const udsResult = await clientFixture.client.portal.list(
				matchedPublicRequest,
				trustedPortalRequestOptions(agentATrustedContext),
			);
			await clientFixture.client.portal.search(
				{
					requests: [
						{
							id: 'search-b',
							limit: 20,
							namespaces: ['github'],
							query: 'issues',
							schemaDetail: 'summary',
						},
					],
				},
				trustedPortalRequestOptions(agentBTrustedContext),
			);

			expect(udsResult).toEqual(directUdsResult);
			expect(clientFixture.connectedSocketPaths).toEqual([
				'/run/agent-vm/gateway-runtime/test-managed-plugin.sock',
			]);
			expect(clientFixture.attachmentHandshakes).toHaveLength(1);
			expect(clientFixture.wireRequests).toHaveLength(2);
			expect(clientFixture.wireRequests.map(({ method }) => method)).toEqual([
				'portal.list',
				'portal.search',
			]);
			expect(clientFixture.wireRequests.map(({ params }) => params)).toEqual([
				{
					publicRequest: matchedPublicRequest,
					trustedContext: agentATrustedContext,
				},
				{
					publicRequest: {
						requests: [
							{
								id: 'search-b',
								limit: 20,
								namespaces: ['github'],
								query: 'issues',
								schemaDetail: 'summary',
							},
						],
					},
					trustedContext: agentBTrustedContext,
				},
			]);
			for (const wireRequest of clientFixture.wireRequests) {
				expect(wireRequest.params).toHaveProperty('publicRequest');
				expect(wireRequest.params).toHaveProperty('trustedContext');
				expect(wireRequest.options ?? {}).not.toHaveProperty('trustedContext');
				if (!isRecord(wireRequest.params)) throw new Error('Expected wire params object.');
				expect(wireRequest.params['publicRequest']).not.toHaveProperty('agentId');
				expect(wireRequest.params['publicRequest']).not.toHaveProperty('authority');
				expect(wireRequest.params['publicRequest']).not.toHaveProperty('surfaceClass');
				expect(wireRequest.params['publicRequest']).not.toHaveProperty('trustedContext');
			}
			expect(fixture.backendPorts.mcpProvider.invocations.map(({ options }) => options)).toEqual([
				{ surfaceClass: 'protected_uds', trustedContext: agentATrustedContext },
				{ surfaceClass: 'protected_uds', trustedContext: agentATrustedContext },
				{ surfaceClass: 'protected_uds', trustedContext: agentBTrustedContext },
			]);
		} finally {
			await clientFixture.client.disconnect();
		}
	});

	it.each([
		{
			expectedMessage: 'Tool Portal agent "agent-c" is not configured.',
			label: 'an unconfigured agent',
			trustedContext: {
				...agentATrustedContext,
				principal: { ...agentATrustedContext.principal, agentId: 'agent-c' },
			},
		},
		{
			expectedMessage: 'Tool Portal trusted context does not match agent "agent-a".',
			label: 'a changed profile-assignment revision',
			trustedContext: {
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					profileAssignmentRevision: 'profile-assignment:agent-a:stale',
				},
			},
		},
		{
			expectedMessage: 'Tool Portal trusted context does not match agent "agent-a".',
			label: 'a cross-framework substitution',
			trustedContext: {
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a-profile' },
				},
			},
		},
	])('rejects $label from the real client before backend admission', async (testCase) => {
		const fixture = composeRecordingProjections();
		const clientFixture = createGatewayRuntimeClientProjectionFixture(fixture);

		await clientFixture.client.connect();
		try {
			await expect(
				clientFixture.client.portal.list(
					{
						requests: [{ id: 'rejected-client-list', limit: 20, namespaces: ['github'] }],
					},
					trustedPortalRequestOptions(testCase.trustedContext),
				),
			).rejects.toThrow(testCase.expectedMessage);
			expect(totalBackendInvocations(fixture)).toBe(0);
		} finally {
			await clientFixture.client.disconnect();
		}
	});

	it('binds the private-UDS surface internally and keeps trusted context out of public arguments', async () => {
		const fixture = composeRecordingProjections();
		const publicRequest = PortalDescribeRequestSchema.parse({
			requests: [{ id: 'describe-a', refs: ['github.get_issue'] }],
		});

		await fixture.composition.privateUdsProjection.portalOperations.describe({
			publicRequest,
			trustedContext: agentATrustedContext,
		});

		expect(fixture.backendPorts.mcpProvider.invocations).toHaveLength(1);
		expect(fixture.backendPorts.mcpProvider.invocations[0]?.options).toEqual({
			surfaceClass: 'protected_uds',
			trustedContext: agentATrustedContext,
		});
		expect(publicRequest).not.toHaveProperty('agentId');
		expect(publicRequest).not.toHaveProperty('surfaceClass');
		expect(publicRequest).not.toHaveProperty('trustedContext');
	});

	it.each([
		{
			label: 'an unconfigured agent',
			trustedContext: {
				...agentATrustedContext,
				principal: { ...agentATrustedContext.principal, agentId: 'agent-c' },
			},
		},
		{
			label: 'a changed profile-assignment revision',
			trustedContext: {
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					profileAssignmentRevision: 'profile-assignment:agent-a:stale',
				},
			},
		},
		{
			label: 'a cross-framework substitution',
			trustedContext: {
				...agentATrustedContext,
				principal: {
					...agentATrustedContext.principal,
					frameworkIdentity: { kind: 'hermes' as const, profileName: 'agent-a-profile' },
				},
			},
		},
	])('rejects $label before backend admission', async ({ trustedContext }) => {
		const fixture = composeRecordingProjections();

		await expect(
			fixture.composition.privateUdsProjection.portalOperations.list({
				publicRequest: PortalListRequestSchema.parse({
					requests: [{ id: 'rejected-list', namespaces: ['github'] }],
				}),
				trustedContext,
			}),
		).rejects.toThrow();
		expect(totalBackendInvocations(fixture)).toBe(0);
	});

	it.each([
		['agentId', 'agent-a'],
		['authenticatedSubjectId', 'subject-injected'],
		['profileAssignmentRevision', 'profile-assignment:agent-a:7'],
		['trustedContext', agentATrustedContext],
		['surfaceClass', 'protected_uds'],
		['authority', ['sandbox', 'controller']],
		['principal', 'principal-injected'],
		['clientKind', 'hermes-managed-plugin'],
	] as const)(
		'rejects public authority field %s before backend admission',
		async (fieldName, fieldValue) => {
			const fixture = composeRecordingProjections();

			await expect(
				fixture.composition.privateUdsProjection.portalOperations.call({
					publicRequest: {
						calls: [
							{
								arguments: {},
								id: 'rejected-call',
								namespace: 'github',
								name: 'get_issue',
							},
						],
						[fieldName]: fieldValue,
					},
					trustedContext: agentATrustedContext,
				}),
			).rejects.toThrow();
			expect(totalBackendInvocations(fixture)).toBe(0);
		},
	);
});
