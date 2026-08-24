import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	PortalArtifactReadRequestSchema,
	type ArtifactReference,
	type PortalArtifactReadRequest,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimeManagedToolPortalConfig,
	ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import {
	createManagedToolPortalCapabilityCore,
	type ToolPortalApprovalPort,
	type ToolPortalBackendPort,
	type ToolPortalCapabilityCore,
	type ToolPortalTrustedInvocationContext,
} from '@agent-vm/tool-portal';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	createGatewayRuntimeArtifactCurrentAuthorityRegistry,
	createGatewayRuntimeArtifactReadAuthorityResolver,
} from './artifacts/artifact-read-authority.js';
import {
	createGatewayRuntimeArtifactStore,
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactReader,
} from './artifacts/artifact-store.js';
import { createGatewayRuntimeFileArtifactStorageBackend } from './artifacts/runtime-file-artifact-storage.js';
import {
	createGatewayRuntimeToolPortalComposition,
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
	agents: { 'agent-a': { profile: 'code-builder' } },
	mode: 'managed',
	profiles: {
		'code-builder': {
			namespaces: {
				github: {
					discovery: {},
					backend: { kind: 'mcp_provider' },
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['get_issue'], deny: [] },
					},
					tools: { allow: ['get_issue'], deny: [] },
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies GatewayRuntimeManagedToolPortalConfig;

const semanticSnapshot = {
	activeRevision: 'semantic:12',
	agentProjections: {
		'agent-a': {
			agentId: 'agent-a',
			frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
			profileAssignmentRevision: 'profile-assignment:agent-a:7',
			toolPortalNamespaces: [{ namespace: 'github' }],
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
		'code-builder': { github: ['protected_uds'] },
	},
} satisfies GatewayRuntimePortalSemanticSnapshot;

const agentATrustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-assignment:agent-a:7',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} satisfies ToolPortalTrustedInvocationContext;

type ArtifactPrivateUdsProjection = Pick<
	GatewayRuntimePrivateUdsProjectionFactoryProps,
	'artifactOperations' | 'capabilityCore'
>;

interface ArtifactCompositionFixture {
	readonly composition: {
		readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
		readonly privateUdsProjection: ArtifactPrivateUdsProjection;
	};
	readonly privateUdsFactoryCalls: readonly GatewayRuntimePrivateUdsProjectionFactoryProps[];
}

const temporaryArtifactSandboxRoots: string[] = [];

function unexpectedArtifactPortalOperation(): Promise<never> {
	return Promise.reject(
		new Error('Portal operation is not expected in artifact projection tests.'),
	);
}

function createUnusedBackendPort<TBackendKind extends ToolPortalBackendKind>(
	backendKind: TBackendKind,
): ToolPortalBackendPort<TBackendKind> {
	return {
		backendKind,
		call: unexpectedArtifactPortalOperation,
		describe: unexpectedArtifactPortalOperation,
		list: unexpectedArtifactPortalOperation,
		search: unexpectedArtifactPortalOperation,
	};
}

function composeArtifactProjections(
	artifactReader: GatewayRuntimeArtifactReader,
): ArtifactCompositionFixture {
	const approvalPort = {
		armDispatch: (): Promise<never> =>
			Promise.reject(new Error('Approval dispatch is not expected in artifact projection tests.')),
		reserveDispatch: (): Promise<never> =>
			Promise.reject(new Error('Approval admission is not expected in artifact projection tests.')),
	} satisfies ToolPortalApprovalPort;
	const controllerExecutionPort = createUnusedBackendPort('controller_execution');
	const mcpProviderPort = createUnusedBackendPort('mcp_provider');
	const toolVmRunnerPort = createUnusedBackendPort('tool_vm_runner');
	const privateUdsFactoryCalls: GatewayRuntimePrivateUdsProjectionFactoryProps[] = [];
	const composition = createGatewayRuntimeToolPortalComposition({
		approvalPort,
		artifactReader,
		authenticatedPrivateUdsOperationGroups: AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
		createPrivateUdsProjection: (props): ArtifactPrivateUdsProjection => {
			privateUdsFactoryCalls.push(props);
			return { artifactOperations: props.artifactOperations, capabilityCore: props.capabilityCore };
		},
		createToolPortalCapabilityCore: (props) =>
			createManagedToolPortalCapabilityCore({
				approvalPort: props.approvalPort,
				backendPorts: {
					controllerExecution: controllerExecutionPort,
					mcpProvider: mcpProviderPort,
					toolVmRunner: toolVmRunnerPort,
				},
				config: toolPortalConfig,
				semanticSnapshot: props.semanticSnapshot,
			}),
		managedPluginAttachment: {
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['agent-a'],
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
		},
		semanticSnapshot,
	});
	return { composition, privateUdsFactoryCalls };
}

function artifactReadRequest(reference: ArtifactReference): PortalArtifactReadRequest {
	return PortalArtifactReadRequestSchema.parse({
		maxBytes: reference.byteLength,
		offsetBytes: 0,
		reference,
	});
}

afterEach(async (): Promise<void> => {
	await Promise.all(
		temporaryArtifactSandboxRoots
			.splice(0)
			.map((sandboxRoot) => rm(sandboxRoot, { force: true, recursive: true })),
	);
});

describe('Gateway runtime Tool Portal artifact projections', () => {
	it('shares one real store while preserving principal authority for protected-UDS artifact references', async () => {
		// Arrange
		const sandboxRoot = await mkdtemp(
			path.join(os.tmpdir(), 'agent-vm-tool-portal-artifact-projections-'),
		);
		temporaryArtifactSandboxRoots.push(sandboxRoot);
		const storageBackend = await createGatewayRuntimeFileArtifactStorageBackend({
			artifactsDirectoryPath: path.join(sandboxRoot, 'gateway-runtime', 'artifacts'),
		});
		const currentAuthorityRegistry = createGatewayRuntimeArtifactCurrentAuthorityRegistry();
		const productionAuthorityResolver = createGatewayRuntimeArtifactReadAuthorityResolver({
			currentAuthority: currentAuthorityRegistry.currentAuthority,
		});
		const authorityResolver = { authorize: vi.fn(productionAuthorityResolver.authorize) };
		const generatedArtifactIds = ['agent-b-reference', 'protected-uds-reference'];
		const store = createGatewayRuntimeArtifactStore({
			authorityResolver,
			createArtifactId: () => generatedArtifactIds.shift() ?? 'unexpected-reference',
			epochId: 'gateway-epoch-7',
			limits: {
				maximumArtifactBytes: 1_024,
				maximumArtifactCount: 4,
				maximumLifetimeMs: 60_000,
				maximumTotalBytes: 4_096,
			},
			now: () => Date.parse('2026-07-13T18:00:00.000Z'),
			storageBackend,
		});
		const storeBackedArtifactReader = {
			read: vi.fn(
				async (readProps: Parameters<GatewayRuntimeArtifactReader['read']>[0]) =>
					await store.read(readProps),
			),
		} satisfies GatewayRuntimeArtifactReader;
		const fixture = composeArtifactProjections(storeBackedArtifactReader);
		const stablePrincipal =
			gatewayRuntimeArtifactStablePrincipalFromTrustedContext(agentATrustedContext);
		const sharedAuthorization = {
			...stablePrincipal,
			capability: { name: 'get_issue', namespace: 'github' },
			executionFingerprint: 'equivalent-artifact-execution',
			operationId: 'equivalent-artifact-operation',
			owningGeneration: 'gateway-generation-7',
		} as const;
		const otherPrincipalAuthorization = {
			...sharedAuthorization,
			agentId: 'agent-b',
			frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
			operationId: 'other-principal-artifact-operation',
			profileAssignmentRevision: 'profile-assignment:agent-b:4',
			toolPortalProfileId: 'code-builder',
			surfaceClass: 'protected_uds',
		} satisfies GatewayRuntimeArtifactAuthorization;
		const protectedUdsAuthorization = {
			...sharedAuthorization,
			surfaceClass: 'protected_uds',
		} satisfies GatewayRuntimeArtifactAuthorization;
		expect(currentAuthorityRegistry.register(otherPrincipalAuthorization)).toEqual({
			kind: 'registered',
		});
		expect(currentAuthorityRegistry.register(protectedUdsAuthorization)).toEqual({
			kind: 'registered',
		});
		const artifactBytes = Buffer.from('surface-equivalent artifact bytes', 'utf8');
		const otherPrincipalWrite = await store.beginWrite({
			authorization: otherPrincipalAuthorization,
			lifetimeMs: 30_000,
			maximumBytes: artifactBytes.byteLength,
			mediaType: 'application/octet-stream',
		});
		await otherPrincipalWrite.write(artifactBytes);
		const otherPrincipalReference = await otherPrincipalWrite.commit();
		const protectedUdsWrite = await store.beginWrite({
			authorization: protectedUdsAuthorization,
			lifetimeMs: 30_000,
			maximumBytes: artifactBytes.byteLength,
			mediaType: 'application/octet-stream',
		});
		await protectedUdsWrite.write(artifactBytes);
		const protectedUdsReference = await protectedUdsWrite.commit();

		try {
			// Act
			const protectedUdsResult =
				await fixture.composition.privateUdsProjection.artifactOperations.read({
					publicRequest: artifactReadRequest(protectedUdsReference),
					trustedContext: agentATrustedContext,
				});
			const protectedUdsReadingOtherPrincipalReference =
				fixture.composition.privateUdsProjection.artifactOperations.read({
					publicRequest: artifactReadRequest(otherPrincipalReference),
					trustedContext: agentATrustedContext,
				});

			// Assert
			expect(protectedUdsResult.contentBase64).toBe(artifactBytes.toString('base64'));
			expect(otherPrincipalReference.id).not.toBe(protectedUdsReference.id);
			expect(otherPrincipalReference.fingerprint).toBe(protectedUdsReference.fingerprint);
			await expect(protectedUdsReadingOtherPrincipalReference).rejects.toMatchObject({
				code: 'not-authorized',
			});
			expect(storeBackedArtifactReader.read).toHaveBeenCalledTimes(2);
			expect(authorityResolver.authorize).toHaveBeenCalledTimes(2);
			expect(fixture.privateUdsFactoryCalls[0]?.capabilityCore).toBe(
				fixture.composition.capabilityCore,
			);
		} finally {
			await store.retireEpoch();
		}
	});
});
