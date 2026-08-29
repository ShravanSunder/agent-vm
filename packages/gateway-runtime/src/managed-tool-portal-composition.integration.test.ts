import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	type ArtifactReference,
	PortalArtifactReadRequestSchema,
	PortalCallRequestSchema,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalBackendDescribeResult,
	type PortalBackendListResult,
	type PortalBackendSearchResult,
	PortalDescribeRequestSchema,
	type PortalDescribeRequest,
	type PortalDescribeResult,
	PortalListRequestSchema,
	type PortalListRequest,
	type PortalListResult,
	PortalSearchRequestSchema,
	type PortalSearchRequest,
	type PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	deriveGatewayRuntimeApprovalFingerprint,
	deriveGatewayRuntimeApprovalId,
	type GatewayRuntimeApprovalChallengeIntent,
	type GatewayRuntimePortalSemanticSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type {
	ToolPortalApprovalPort,
	ToolPortalBackendCallOptions,
	ToolPortalBackendPort,
	ToolPortalInvocationOptions,
	ToolPortalCapabilityCore,
} from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import type {
	GatewayRuntimeArtifactAuthorityRetirement,
	GatewayRuntimeArtifactCurrentAuthorityRegistry,
} from './artifacts/artifact-read-authority.js';
import {
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactStore,
} from './artifacts/artifact-store.js';
import {
	createGatewayRuntimeManagedToolPortalComposition,
	type GatewayRuntimeManagedToolPortalBackendFactoryRuntime,
} from './index.js';
import type {
	GatewayRuntimeArtifactProjectionOperations,
	GatewayRuntimePortalProjectionOperations,
	GatewayRuntimePrivateUdsProjectionFactoryProps,
} from './tool-portal-projections.js';

const artifactNowMs = Date.parse('2026-07-13T12:00:00.000Z');
const artifactBytes = Buffer.from('production composition artifact bytes', 'utf8');

const toolPortalConfig = {
	agents: {
		'agent-a': { profile: 'code-builder' },
	},
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: ['create_issue'], deny: [] },
						withoutApproval: { allow: ['backend_error', 'get_issue'], deny: [] },
					},
					tools: { allow: ['backend_error', 'create_issue', 'get_issue'], deny: [] },
				},
				private_github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['private_probe'], deny: [] },
					},
					tools: { allow: ['private_probe'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'semantic:managed-composition:1',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
			profileAssignmentRevision: 'profile-assignment:agent-a:1',
			toolPortalNamespaces: [{ namespace: 'github' }, { namespace: 'private_github' }],
			toolPortalProfileId: 'code-builder',
		},
	},
	bindingRevision: 'binding:managed-composition:1',
	catalogRevision: 'catalog:managed-composition:1',
	desiredRevision: 'semantic:managed-composition:1',
	profilePolicyRevision: 'profile-policy:managed-composition:1',
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	providerRevision: 'provider:managed-composition:1',
	schemaRevision: 'schema:managed-composition:1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'code-builder': {
			github: ['protected_uds'],
			private_github: ['protected_uds'],
		},
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const trustedContext = {
	correlation: {
		runId: 'run-managed-composition',
		sessionId: 'session-managed-composition',
		toolCallId: 'tool-call-managed-composition',
	},
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-a' },
		profileAssignmentRevision: 'profile-assignment:agent-a:1',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const;

const approvalPort = {
	armDispatch: (): Promise<never> =>
		Promise.reject(new Error('Approval dispatch is not expected in this composition proof.')),
	reserveDispatch: (): Promise<never> =>
		Promise.reject(new Error('Approval admission is not expected in this composition proof.')),
} satisfies ToolPortalApprovalPort;

function createUnusedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
): ToolPortalBackendPort<TBackendKind> {
	return {
		backendKind,
		call: (): Promise<never> =>
			Promise.reject(new Error('Backend call is not expected in this composition proof.')),
		describe: (): Promise<never> =>
			Promise.reject(new Error('Backend describe is not expected in this composition proof.')),
		list: (): Promise<never> =>
			Promise.reject(new Error('Backend list is not expected in this composition proof.')),
		search: (): Promise<never> =>
			Promise.reject(new Error('Backend search is not expected in this composition proof.')),
	};
}

interface CapturedPrivateUdsProjection {
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly portalOperations: GatewayRuntimePortalProjectionOperations;
}

function createPrivateUdsProjection(
	props: GatewayRuntimePrivateUdsProjectionFactoryProps,
): CapturedPrivateUdsProjection {
	return {
		artifactOperations: props.artifactOperations,
		capabilityCore: props.capabilityCore,
		portalOperations: props.portalOperations,
	};
}

function artifactAuthorization(
	surfaceClass: GatewayRuntimeArtifactAuthorization['surfaceClass'],
): GatewayRuntimeArtifactAuthorization {
	return {
		...gatewayRuntimeArtifactStablePrincipalFromTrustedContext(trustedContext),
		capability: { name: 'get_issue', namespace: 'github' },
		executionFingerprint: `execution-fingerprint-${surfaceClass}`,
		operationId: `operation-${surfaceClass}`,
		owningGeneration: semanticSnapshot.activeRevision,
		surfaceClass,
	};
}

async function writeArtifact(props: {
	readonly artifactStore: GatewayRuntimeArtifactStore;
	readonly authorization: GatewayRuntimeArtifactAuthorization;
}): Promise<ArtifactReference> {
	const writeHandle = await props.artifactStore.beginWrite({
		authorization: props.authorization,
		lifetimeMs: 60_000,
		maximumBytes: artifactBytes.byteLength,
		mediaType: 'text/plain',
	});
	await writeHandle.write(artifactBytes);
	return await writeHandle.commit();
}

type MatchedPortalResult =
	| PortalCallResult
	| PortalDescribeResult
	| PortalListResult
	| PortalSearchResult;

type MatchedPortalRequest =
	| PortalCallRequest
	| PortalDescribeRequest
	| PortalListRequest
	| PortalSearchRequest;

interface MatchedProviderInvocation {
	readonly operation: 'call' | 'describe' | 'list' | 'search';
	readonly options: ToolPortalInvocationOptions;
	readonly request: MatchedPortalRequest;
}

const APPROVAL_AUTHORITY_CONTEXT = {
	controllerEpoch: 'controller-epoch-managed-composition-1',
	frameworkEpoch: 'framework-epoch-managed-composition-1',
	gatewayEpoch: 'gateway-epoch-managed-composition-1',
	runtimeEpoch: 'runtime-epoch-managed-composition-1',
	zoneId: 'zone-a',
} as const;

function operationIdFromBackendCallOptions(
	options: ToolPortalBackendCallOptions<'mcp_provider'>,
): string {
	switch (options.dispatchAuthority.kind) {
		case 'without-approval':
			return options.dispatchAuthority.operationId;
		case 'approval-grant':
			return options.dispatchAuthority.grant.operationId;
		default:
			throw new Error('Unexpected MCP-provider dispatch authority.');
	}
}

function createMatchedMcpProviderPort(
	invocations: MatchedProviderInvocation[],
): ToolPortalBackendPort<'mcp_provider'> {
	return {
		backendKind: 'mcp_provider',
		call: (request, options): Promise<PortalCallResult> => {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			invocations.push({ operation: 'call', options, request: parsedRequest });
			if (parsedRequest.calls.some((call) => call.name === 'backend_error')) {
				throw new Error('PRIVATE_PROVIDER_DETAIL_MUST_NOT_REACH_MODEL');
			}
			return Promise.resolve({
				items: parsedRequest.calls.map((call) => ({
					id: call.id,
					operationId: operationIdFromBackendCallOptions(options),
					outcome: {
						certainty: 'proven' as const,
						completion: 'succeeded' as const,
						kind: 'completed' as const,
						retryClass: 'forbidden' as const,
					},
					owningGeneration: semanticSnapshot.activeRevision,
					status: 'ok' as const,
					value: { providerRuntime: 'shared-mcp-provider-runtime' },
				})),
				ok: true,
			});
		},
		describe: (request, options): Promise<PortalBackendDescribeResult> => {
			const parsedRequest = PortalDescribeRequestSchema.parse(request);
			invocations.push({ operation: 'describe', options, request: parsedRequest });
			return Promise.resolve({
				items: parsedRequest.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { tools: [] },
				})),
				ok: true,
			});
		},
		list: (request, options): Promise<PortalBackendListResult> => {
			const parsedRequest = PortalListRequestSchema.parse(request);
			invocations.push({ operation: 'list', options, request: parsedRequest });
			return Promise.resolve({
				items: parsedRequest.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { namespaces: ['github'], tools: [] },
				})),
				ok: true,
			});
		},
		search: (request, options): Promise<PortalBackendSearchResult> => {
			const parsedRequest = PortalSearchRequestSchema.parse(request);
			invocations.push({ operation: 'search', options, request: parsedRequest });
			return Promise.resolve({
				items: parsedRequest.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { tools: [] },
				})),
				ok: true,
			});
		},
	};
}

function createMatchedApprovalPort(
	approvalIntents: GatewayRuntimeApprovalChallengeIntent[],
): ToolPortalApprovalPort {
	return {
		armDispatch: (): Promise<never> =>
			Promise.reject(new Error('Approval dispatch is not expected in parity proof.')),
		reserveDispatch: ({ intent }) => {
			approvalIntents.push(intent);
			const fingerprint = deriveGatewayRuntimeApprovalFingerprint({
				authorityContext: APPROVAL_AUTHORITY_CONTEXT,
				intent,
			});
			return Promise.resolve({
				challenge: {
					approvalId: deriveGatewayRuntimeApprovalId(fingerprint),
					createdAt: '2026-07-13T17:00:00.000Z',
					expiresAt: '2026-07-13T18:00:00.000Z',
					fingerprint,
					intent,
				},
				kind: 'approval-required' as const,
			});
		},
	};
}

async function invokePortalProjection(props: {
	readonly method: string;
	readonly operations: GatewayRuntimePortalProjectionOperations;
	readonly publicRequest: unknown;
}): Promise<MatchedPortalResult> {
	switch (props.method) {
		case 'portal.call':
			return await props.operations.call({
				publicRequest: PortalCallRequestSchema.parse(props.publicRequest),
				trustedContext,
			});
		case 'portal.describe':
			return await props.operations.describe({
				publicRequest: PortalDescribeRequestSchema.parse(props.publicRequest),
				trustedContext,
			});
		case 'portal.list':
			return await props.operations.list({
				publicRequest: PortalListRequestSchema.parse(props.publicRequest),
				trustedContext,
			});
		case 'portal.search':
			return await props.operations.search({
				publicRequest: PortalSearchRequestSchema.parse(props.publicRequest),
				trustedContext,
			});
		default:
			throw new Error(`Unexpected portal projection method: ${props.method}`);
	}
}

describe('Gateway runtime managed Tool Portal production composition', () => {
	it('routes the protected-UDS cohort through one production service and provider runtime', async () => {
		// Arrange
		const sandboxRoot = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-tool-portal-parity-'),
		);
		const approvalIntents: GatewayRuntimeApprovalChallengeIntent[] = [];
		const providerInvocations: MatchedProviderInvocation[] = [];
		const providerRuntimeIdentities: GatewayRuntimeManagedToolPortalBackendFactoryRuntime[] = [];
		const mcpProviderPort = createMatchedMcpProviderPort(providerInvocations);
		const mcpProviderFactory = vi.fn(
			(runtime: GatewayRuntimeManagedToolPortalBackendFactoryRuntime) => {
				providerRuntimeIdentities.push(runtime);
				return mcpProviderPort;
			},
		);
		const matchedCohort = [
			{
				expectedStatus: 'ok',
				label: 'list success',
				method: 'portal.list',
				publicRequest: {
					requests: [{ id: 'matched-list', limit: 20, namespaces: ['github'] }],
				},
			},
			{
				expectedStatus: 'ok',
				label: 'search success',
				method: 'portal.search',
				publicRequest: {
					requests: [
						{
							id: 'matched-search',
							limit: 20,
							namespaces: ['github'],
							query: 'issues',
							schemaDetail: 'summary',
						},
					],
				},
			},
			{
				expectedStatus: 'ok',
				label: 'describe success',
				method: 'portal.describe',
				publicRequest: {
					requests: [{ id: 'matched-describe', refs: ['github.get_issue'] }],
				},
			},
			{
				expectedStatus: 'ok',
				label: 'call success',
				method: 'portal.call',
				publicRequest: {
					calls: [
						{
							arguments: { issueNumber: 42 },
							id: 'matched-call',
							namespace: 'github',
							name: 'get_issue',
						},
					],
				},
			},
			{
				expectedStatus: 'error',
				label: 'model-safe backend error',
				method: 'portal.call',
				publicRequest: {
					calls: [
						{
							arguments: {},
							id: 'matched-backend-error',
							namespace: 'github',
							name: 'backend_error',
						},
					],
				},
			},
			{
				expectedStatus: 'approval_required',
				label: 'approval required',
				method: 'portal.call',
				publicRequest: {
					calls: [
						{
							arguments: { title: 'Review parity' },
							id: 'matched-approval',
							namespace: 'github',
							name: 'create_issue',
						},
					],
				},
			},
			{
				expectedStatus: 'error',
				label: 'common policy denial',
				method: 'portal.call',
				publicRequest: {
					calls: [
						{
							arguments: {},
							id: 'matched-denial',
							namespace: 'github',
							name: 'delete_issue',
						},
					],
				},
			},
		] as const;
		const matchedResults: MatchedPortalResult[] = [];

		try {
			const composition = await createGatewayRuntimeManagedToolPortalComposition({
				approvalPort: createMatchedApprovalPort(approvalIntents),
				artifactRuntime: {
					artifactsDirectoryPath: path.join(sandboxRoot, 'runtime', 'artifacts'),
					epochId: 'runtime-epoch-managed-composition-parity',
					limits: {
						maximumArtifactBytes: 1_024,
						maximumArtifactCount: 4,
						maximumLifetimeMs: 300_000,
						maximumTotalBytes: 4_096,
					},
					now: () => artifactNowMs,
				},
				authenticatedPrivateUdsOperationGroups: ['portal', 'artifact.read'],
				backendPortFactories: {
					controllerExecution: () => createUnusedBackendPort('controller_execution'),
					mcpProvider: mcpProviderFactory,
					toolVmRunner: () => createUnusedBackendPort('tool_vm_runner'),
				},
				createPrivateUdsProjection,
				managedPluginAttachment: {
					clientKind: 'hermes-managed-plugin',
					configuredAgentIds: ['agent-a'],
					projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				},
				semanticSnapshot,
				toolPortalConfig,
			});

			// Act
			const cohortResults = await Promise.all(
				matchedCohort.map(async (cohortCase) => {
					const protectedUdsResult = await invokePortalProjection({
						method: cohortCase.method,
						operations: composition.privateUdsProjection.portalOperations,
						publicRequest: cohortCase.publicRequest,
					});
					return { cohortCase, protectedUdsResult };
				}),
			);
			for (const { cohortCase, protectedUdsResult } of cohortResults) {
				matchedResults.push(protectedUdsResult);

				// Assert
				expect(protectedUdsResult.items[0]?.status, cohortCase.label).toBe(
					cohortCase.expectedStatus,
				);
				if (cohortCase.label === 'model-safe backend error') {
					expect(protectedUdsResult.items[0]).toMatchObject({
						error: { code: 'execution_failed' },
						outcome: {
							certainty: 'side-effects-and-termination-unknown',
							kind: 'ambiguous',
							retryClass: 'forbidden',
						},
					});
				}
			}

			const intentionalSurfaceDenialRequest = {
				calls: [
					{
						arguments: {},
						id: 'intentional-surface-denial',
						namespace: 'private_github',
						name: 'private_probe',
					},
				],
			};
			const protectedUdsAllowedResult =
				await composition.privateUdsProjection.portalOperations.call({
					publicRequest: intentionalSurfaceDenialRequest,
					trustedContext,
				});

			// Assert
			expect(protectedUdsAllowedResult.items[0]?.status).toBe('ok');
			expect(composition.service.mode).toBe('managed');
			expect(composition.service.capabilityCore).toBe(composition.capabilityCore);
			expect(Object.keys(composition.service).toSorted()).toEqual([
				'capabilityCore',
				'mode',
				'ownedComponents',
			]);
			expect(composition.service.ownedComponents.artifactStore).toBe(composition.artifactStore);
			expect(composition.service.ownedComponents.privateUdsProjection).toBe(
				composition.privateUdsProjection,
			);
			expect(composition.privateUdsProjection.capabilityCore).toBe(composition.capabilityCore);
			expect(Object.keys(composition).toSorted()).toEqual([
				'artifactStore',
				'capabilityCore',
				'privateUdsProjection',
				'registerArtifactAuthority',
				'retireArtifactAuthority',
				'retireEpoch',
				'semanticSnapshot',
				'service',
			]);
			expect(composition.semanticSnapshot).toBe(composition.capabilityCore.semanticSnapshot);
			expect(mcpProviderFactory).toHaveBeenCalledTimes(1);
			expect(providerRuntimeIdentities).toHaveLength(1);
			expect(providerRuntimeIdentities[0]?.artifactStore).toBe(composition.artifactStore);
			expect(providerRuntimeIdentities[0]?.registerArtifactAuthority).toBe(
				composition.registerArtifactAuthority,
			);
			expect(providerInvocations).toHaveLength(6);
			expect(new Set(providerInvocations.map(({ options }) => options.surfaceClass))).toEqual(
				new Set(['protected_uds']),
			);
			expect(JSON.stringify(matchedResults)).not.toContain(
				'PRIVATE_PROVIDER_DETAIL_MUST_NOT_REACH_MODEL',
			);
			expect(approvalIntents).toHaveLength(1);
			expect(approvalIntents.map(({ semanticRevisions }) => semanticRevisions)).toEqual(
				Array.from({ length: 1 }, () => ({
					activeRevision: semanticSnapshot.activeRevision,
					bindingRevision: semanticSnapshot.bindingRevision,
					catalogRevision: semanticSnapshot.catalogRevision,
					profilePolicyRevision: semanticSnapshot.profilePolicyRevision,
					providerRevision: semanticSnapshot.providerRevision,
					schemaRevision: semanticSnapshot.schemaRevision,
				})),
			);
			expect(approvalIntents.map(({ surfaceClass }) => surfaceClass).toSorted()).toEqual([
				'protected_uds',
			]);
			expect(
				matchedCohort.every(
					({ publicRequest }) =>
						!('authority' in publicRequest) &&
						!('surfaceClass' in publicRequest) &&
						!('trustedContext' in publicRequest),
				),
			).toBe(true);
			await composition.retireEpoch();
		} finally {
			await rm(sandboxRoot, { force: true, recursive: true });
		}
	});

	it('owns one service and one file artifact authority lifecycle through private UDS', async () => {
		// Arrange
		const sandboxRoot = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-managed-tool-portal-composition-'),
		);
		const artifactsDirectoryPath = path.join(sandboxRoot, 'runtime', 'artifacts');
		const protectedUdsAuthorization = artifactAuthorization('protected_uds');
		const retainedProtectedUdsAuthorization = {
			...artifactAuthorization('protected_uds'),
			executionFingerprint: 'execution-fingerprint-protected-uds-retained',
			operationId: 'operation-protected-uds-retained',
		} satisfies GatewayRuntimeArtifactAuthorization;
		const observedServiceSurfaceClasses: ToolPortalInvocationOptions['surfaceClass'][] = [];
		const controllerExecutionPort = createUnusedBackendPort('controller_execution');
		const mcpProviderPort = {
			...createUnusedBackendPort('mcp_provider'),
			list: async (request, options) => {
				observedServiceSurfaceClasses.push(options.surfaceClass);
				return {
					items: request.requests.map((item) => ({
						id: item.id,
						status: 'ok' as const,
						value: { namespaces: ['github'], tools: [] },
					})),
					ok: true,
				};
			},
		} satisfies ToolPortalBackendPort<'mcp_provider'>;
		const toolVmRunnerPort = createUnusedBackendPort('tool_vm_runner');

		try {
			// Act
			const composition = await createGatewayRuntimeManagedToolPortalComposition({
				approvalPort,
				artifactRuntime: {
					artifactsDirectoryPath,
					epochId: 'runtime-epoch-managed-composition-1',
					limits: {
						maximumArtifactBytes: 1_024,
						maximumArtifactCount: 4,
						maximumLifetimeMs: 300_000,
						maximumTotalBytes: 4_096,
					},
					now: () => artifactNowMs,
				},
				authenticatedPrivateUdsOperationGroups: ['portal', 'artifact.read'],
				backendPortFactories: {
					controllerExecution: () => controllerExecutionPort,
					mcpProvider: () => mcpProviderPort,
					toolVmRunner: () => toolVmRunnerPort,
				},
				createPrivateUdsProjection,
				managedPluginAttachment: {
					clientKind: 'hermes-managed-plugin',
					configuredAgentIds: ['agent-a'],
					projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
				},
				semanticSnapshot,
				toolPortalConfig,
			});
			const artifactStore: GatewayRuntimeArtifactStore = composition.artifactStore;
			const registerArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['register'] =
				composition.registerArtifactAuthority;
			const retireArtifactAuthority: GatewayRuntimeArtifactCurrentAuthorityRegistry['retire'] =
				composition.retireArtifactAuthority;
			const retireEpoch: () => Promise<void> = composition.retireEpoch;
			await composition.privateUdsProjection.capabilityCore.list(
				{ requests: [{ id: 'protected-uds-list', limit: 20, namespaces: ['github'] }] },
				{
					origin: { kind: 'managed', trustedContext },
					surfaceClass: 'protected_uds',
				},
			);

			expect(registerArtifactAuthority(protectedUdsAuthorization)).toEqual({
				kind: 'registered',
			});
			expect(registerArtifactAuthority(retainedProtectedUdsAuthorization)).toEqual({
				kind: 'registered',
			});
			const retainedProtectedUdsReference = await writeArtifact({
				artifactStore,
				authorization: retainedProtectedUdsAuthorization,
			});
			const protectedUdsReference = await writeArtifact({
				artifactStore,
				authorization: protectedUdsAuthorization,
			});
			const retainedProtectedUdsReadRequest = PortalArtifactReadRequestSchema.parse({
				maxBytes: artifactBytes.byteLength,
				offsetBytes: 0,
				reference: retainedProtectedUdsReference,
			});
			const protectedUdsReadRequest = PortalArtifactReadRequestSchema.parse({
				maxBytes: artifactBytes.byteLength,
				offsetBytes: 0,
				reference: protectedUdsReference,
			});
			const retainedProtectedUdsReadResult =
				await composition.privateUdsProjection.artifactOperations.read({
					publicRequest: retainedProtectedUdsReadRequest,
					trustedContext,
				});
			const protectedUdsReadResult = await composition.privateUdsProjection.artifactOperations.read(
				{
					publicRequest: protectedUdsReadRequest,
					trustedContext,
				},
			);

			// Assert
			expect(composition.privateUdsProjection.capabilityCore).toBe(composition.capabilityCore);
			expect(observedServiceSurfaceClasses).toEqual(['protected_uds']);
			expect(Buffer.from(retainedProtectedUdsReadResult.contentBase64, 'base64')).toEqual(
				artifactBytes,
			);
			expect(Buffer.from(protectedUdsReadResult.contentBase64, 'base64')).toEqual(artifactBytes);
			expect((await readdir(artifactsDirectoryPath)).toSorted()).toHaveLength(2);

			const retirement = {
				kind: 'operation',
				operationId: protectedUdsAuthorization.operationId,
			} satisfies GatewayRuntimeArtifactAuthorityRetirement;
			expect(retireArtifactAuthority(retirement)).toEqual({
				affectedAuthorizationCount: 1,
				kind: 'retired',
			});
			expect(registerArtifactAuthority(protectedUdsAuthorization)).toEqual({
				kind: 'rejected',
				reason: 'operation',
			});
			await expect(
				composition.privateUdsProjection.artifactOperations.read({
					publicRequest: protectedUdsReadRequest,
					trustedContext,
				}),
			).rejects.toMatchObject({ code: 'not-authorized' });
			await expect(
				composition.privateUdsProjection.artifactOperations.read({
					publicRequest: retainedProtectedUdsReadRequest,
					trustedContext,
				}),
			).resolves.toMatchObject({ reference: retainedProtectedUdsReference });

			await retireEpoch();
			expect(await readdir(artifactsDirectoryPath)).toEqual([]);
			await expect(
				artifactStore.beginWrite({
					authorization: retainedProtectedUdsAuthorization,
					lifetimeMs: 60_000,
					maximumBytes: artifactBytes.byteLength,
				}),
			).rejects.toMatchObject({ code: 'retired' });
			await expect(
				composition.privateUdsProjection.artifactOperations.read({
					publicRequest: retainedProtectedUdsReadRequest,
					trustedContext,
				}),
			).rejects.toMatchObject({ code: 'retired' });
		} finally {
			await rm(sandboxRoot, { force: true, recursive: true });
		}
	});
});
