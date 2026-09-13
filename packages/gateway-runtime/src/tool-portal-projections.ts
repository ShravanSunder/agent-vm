import type {
	PortalCatalogOfferRequest,
	PortalCatalogOfferResult,
	PortalCatalogPrepareRequest,
	PortalCatalogPrepareResult,
	PortalCatalogReadRequest,
	PortalCatalogReadResult,
	PortalCatalogReleaseRequest,
	PortalCatalogReleaseResult,
	PortalArtifactReadRequest,
	PortalArtifactReadResult,
	PortalCallRequest,
	PortalCallResult,
	PortalDescribeRequest,
	PortalDescribeResult,
	PortalListRequest,
	PortalListResult,
	PortalSearchRequest,
	PortalSearchResult,
} from '@agent-vm/agent-portal-sdk';
import type {
	GatewayRuntimePortalSemanticSnapshot,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { deriveGatewayControlStablePrincipal } from '@agent-vm/gateway-control-contracts';
import type { ToolPortalApprovalPort, ToolPortalCapabilityCore } from '@agent-vm/tool-portal';
import { z } from 'zod';

import {
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactReader,
} from './artifacts/artifact-store.js';
import {
	createPreparedCatalogSourceCache,
	type PreparedCatalogSourceAuthority,
	type PreparedCatalogSourceCache,
} from './catalog/prepared-catalog-source-cache.js';

export const GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS = [
	'approval',
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

const ManagedPluginClientKindSchema = z.literal('hermes-managed-plugin');
const PrivateUdsOperationGroupSchema = z.enum(
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
);
export type GatewayRuntimeManagedPluginClientKind = z.infer<typeof ManagedPluginClientKindSchema>;
export type GatewayRuntimePrivateUdsOperationGroup = z.infer<typeof PrivateUdsOperationGroupSchema>;

export interface GatewayRuntimePortalCallInvocation {
	readonly publicRequest: PortalCallRequest;
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeArtifactReadInvocation {
	readonly publicRequest: PortalArtifactReadRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeArtifactProjectionOperations {
	readonly read: (
		invocation: GatewayRuntimeArtifactReadInvocation,
	) => Promise<PortalArtifactReadResult>;
}

export interface GatewayRuntimePortalDescribeInvocation {
	readonly publicRequest: PortalDescribeRequest;
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimePortalListInvocation {
	readonly publicRequest: PortalListRequest;
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimePortalSearchInvocation {
	readonly publicRequest: PortalSearchRequest;
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export type GatewayRuntimePortalProjectionResult =
	| PortalCallResult
	| PortalDescribeResult
	| PortalListResult
	| PortalSearchResult;

export interface GatewayRuntimePortalProjectionOperations {
	readonly call: (invocation: GatewayRuntimePortalCallInvocation) => Promise<PortalCallResult>;
	readonly describe: (
		invocation: GatewayRuntimePortalDescribeInvocation,
	) => Promise<PortalDescribeResult>;
	readonly list: (invocation: GatewayRuntimePortalListInvocation) => Promise<PortalListResult>;
	readonly search: (
		invocation: GatewayRuntimePortalSearchInvocation,
	) => Promise<PortalSearchResult>;
}

interface GatewayRuntimeCatalogInvocation<TPublicRequest> {
	readonly connectionId: string;
	readonly publicRequest: TPublicRequest;
	readonly signal?: AbortSignal;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimeCatalogProjectionOperations {
	readonly offer: (
		invocation: GatewayRuntimeCatalogInvocation<PortalCatalogOfferRequest>,
	) => Promise<PortalCatalogOfferResult>;
	readonly prepare: (
		invocation: GatewayRuntimeCatalogInvocation<PortalCatalogPrepareRequest>,
	) => Promise<PortalCatalogPrepareResult>;
	readonly read: (
		invocation: GatewayRuntimeCatalogInvocation<PortalCatalogReadRequest>,
	) => Promise<PortalCatalogReadResult>;
	readonly release: (
		invocation: GatewayRuntimeCatalogInvocation<PortalCatalogReleaseRequest>,
	) => Promise<PortalCatalogReleaseResult>;
}

export interface GatewayRuntimePortalProjectionCommonProps {
	readonly portalOperations: GatewayRuntimePortalProjectionOperations;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
}

export interface GatewayRuntimePrivateUdsProjectionFactoryProps extends GatewayRuntimePortalProjectionCommonProps {
	readonly authenticatedOperationGroups: readonly GatewayRuntimePrivateUdsOperationGroup[];
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
	readonly catalogOperations: GatewayRuntimeCatalogProjectionOperations;
}

export interface CreateGatewayRuntimeToolPortalCompositionProps<TUdsProjection> {
	readonly approvalPort: ToolPortalApprovalPort;
	readonly artifactReader: GatewayRuntimeArtifactReader;
	readonly authenticatedPrivateUdsOperationGroups: readonly GatewayRuntimePrivateUdsOperationGroup[];
	readonly createPrivateUdsProjection: (
		props: GatewayRuntimePrivateUdsProjectionFactoryProps,
	) => TUdsProjection;
	readonly createToolPortalCapabilityCore: (props: {
		readonly approvalPort: ToolPortalApprovalPort;
		readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	}) => ToolPortalCapabilityCore<'managed'>;
	readonly managedPluginAttachment: {
		readonly clientKind: GatewayRuntimeManagedPluginClientKind;
		readonly configuredAgentIds: readonly string[];
		readonly gatewayEpoch: string;
		readonly projectionCohortDigest: string;
	};
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly preparedCatalogSourceCache?: PreparedCatalogSourceCache;
}

function createProtectedUdsArtifactProjectionOperations(props: {
	readonly artifactReader: GatewayRuntimeArtifactReader;
}): GatewayRuntimeArtifactProjectionOperations {
	return {
		read: async (invocation) =>
			await props.artifactReader.read({
				caller: {
					principal: gatewayRuntimeArtifactStablePrincipalFromTrustedContext(
						invocation.trustedContext,
					),
					surfaceClass: 'protected_uds',
				},
				request: invocation.publicRequest,
			}),
	};
}

export interface GatewayRuntimeToolPortalComposition<TUdsProjection> {
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly privateUdsProjection: TUdsProjection;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}

function createCatalogSourceAuthority(props: {
	readonly connectionId: string;
	readonly gatewayEpoch: string;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}): PreparedCatalogSourceAuthority {
	const principal = props.trustedContext.principal;
	const correlation = props.trustedContext.correlation;
	const turnId =
		correlation !== undefined && 'turnId' in correlation && typeof correlation.turnId === 'string'
			? correlation.turnId
			: undefined;
	return {
		activeRevision: props.semanticSnapshot.activeRevision,
		catalogRevision: props.semanticSnapshot.catalogRevision,
		connectionId: props.connectionId,
		gatewayEpoch: props.gatewayEpoch,
		profileAssignmentRevision: principal.profileAssignmentRevision,
		profileId: principal.toolPortalProfileId,
		profilePolicyRevision: props.semanticSnapshot.profilePolicyRevision,
		providerRevision: props.semanticSnapshot.providerRevision,
		schemaRevision: props.semanticSnapshot.schemaRevision,
		...(props.trustedContext.correlation?.sessionId === undefined
			? {}
			: { sessionId: props.trustedContext.correlation.sessionId }),
		stablePrincipal: deriveGatewayControlStablePrincipal({ principal }),
		...(turnId === undefined ? {} : { turnId }),
	};
}

function catalogPreparationFlightKey(authority: PreparedCatalogSourceAuthority): string {
	return JSON.stringify({
		activeRevision: authority.activeRevision,
		catalogRevision: authority.catalogRevision,
		gatewayEpoch: authority.gatewayEpoch,
		profileAssignmentRevision: authority.profileAssignmentRevision,
		profileId: authority.profileId,
		profilePolicyRevision: authority.profilePolicyRevision,
		providerRevision: authority.providerRevision,
		schemaRevision: authority.schemaRevision,
		stablePrincipal: authority.stablePrincipal,
	});
}

function createCatalogProjectionOperations(props: {
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
	readonly gatewayEpoch: string;
	readonly preparedCatalogSourceCache: PreparedCatalogSourceCache;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): GatewayRuntimeCatalogProjectionOperations {
	const preparationFlights = new Map<string, Promise<PortalCatalogPrepareResult>>();
	const authority = (
		invocation: GatewayRuntimeCatalogInvocation<unknown>,
	): PreparedCatalogSourceAuthority =>
		createCatalogSourceAuthority({
			connectionId: invocation.connectionId,
			gatewayEpoch: props.gatewayEpoch,
			semanticSnapshot: props.semanticSnapshot,
			trustedContext: invocation.trustedContext,
		});
	return {
		offer: async (invocation) =>
			props.preparedCatalogSourceCache.offer({
				authority: authority(invocation),
				definitionFingerprint: invocation.publicRequest.definitionFingerprint,
			}),
		prepare: async (invocation) => {
			const sourceAuthority = authority(invocation);
			const flightKey = catalogPreparationFlightKey(sourceAuthority);
			const existingFlight = preparationFlights.get(flightKey);
			if (existingFlight !== undefined) return await existingFlight;
			const preparation = (async (): Promise<PortalCatalogPrepareResult> => {
				try {
					const preparedDefinitions = await props.capabilityCore.prepareCatalog({
						origin: { kind: 'managed', trustedContext: invocation.trustedContext },
						...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
						surfaceClass: 'protected_uds',
					});
					if (preparedDefinitions.kind === 'incomplete') {
						return {
							diagnostics: preparedDefinitions.diagnostics.slice(0, 64),
							kind: 'incomplete',
							reason: 'catalog-incomplete',
						};
					}
					return await props.preparedCatalogSourceCache.prepare({
						authority: sourceAuthority,
						input: { tools: preparedDefinitions.tools },
					});
				} catch {
					return {
						diagnostics: [
							{
								code: invocation.signal?.aborted === true ? 'cancelled' : 'provider_unavailable',
								level: 'error',
								safeMessage: 'Catalog preparation is unavailable.',
							},
						],
						kind: 'incomplete',
						reason: 'catalog-preparation-failed',
					};
				}
			})();
			preparationFlights.set(flightKey, preparation);
			try {
				return await preparation;
			} finally {
				if (preparationFlights.get(flightKey) === preparation) preparationFlights.delete(flightKey);
			}
		},
		read: async (invocation) =>
			props.preparedCatalogSourceCache.read({
				authority: authority(invocation),
				...invocation.publicRequest,
			}),
		release: async (invocation) =>
			props.preparedCatalogSourceCache.release({
				authority: authority(invocation),
				...invocation.publicRequest,
			}),
	};
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].toSorted();
}

function assertAttachmentMatchesSnapshot(props: {
	readonly configuredAgentIds: readonly string[];
	readonly projectionCohortDigest: string;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
}): void {
	if (new Set(props.configuredAgentIds).size !== props.configuredAgentIds.length) {
		throw new Error('Managed-plugin attachment contains a duplicate configured agent id.');
	}
	const configuredAgentIds = sortedUnique(props.configuredAgentIds);
	const snapshotAgentIds = Object.keys(props.semanticSnapshot.agentProjections).toSorted();
	if (
		configuredAgentIds.length !== snapshotAgentIds.length ||
		configuredAgentIds.some((agentId, index) => agentId !== snapshotAgentIds[index])
	) {
		throw new Error('Managed-plugin configured agents do not match the Tool Portal snapshot.');
	}
	if (props.projectionCohortDigest !== props.semanticSnapshot.projectionCohortDigest) {
		throw new Error(
			'Managed-plugin projection cohort digest does not match the Tool Portal snapshot.',
		);
	}
}

function createPortalProjectionOperations(props: {
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
}): GatewayRuntimePortalProjectionOperations {
	return {
		call: async (invocation) =>
			await props.capabilityCore.call(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
				surfaceClass: 'protected_uds',
			}),
		describe: async (invocation) =>
			await props.capabilityCore.describe(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
				surfaceClass: 'protected_uds',
			}),
		list: async (invocation) =>
			await props.capabilityCore.list(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
				surfaceClass: 'protected_uds',
			}),
		search: async (invocation) =>
			await props.capabilityCore.search(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
				surfaceClass: 'protected_uds',
			}),
	};
}

export function createGatewayRuntimeToolPortalComposition<TUdsProjection>(
	props: CreateGatewayRuntimeToolPortalCompositionProps<TUdsProjection>,
): GatewayRuntimeToolPortalComposition<TUdsProjection> {
	ManagedPluginClientKindSchema.parse(props.managedPluginAttachment.clientKind);
	assertAttachmentMatchesSnapshot({
		configuredAgentIds: props.managedPluginAttachment.configuredAgentIds,
		projectionCohortDigest: props.managedPluginAttachment.projectionCohortDigest,
		semanticSnapshot: props.semanticSnapshot,
	});
	const authenticatedOperationGroups = Object.freeze(
		props.authenticatedPrivateUdsOperationGroups.map((operationGroup) =>
			PrivateUdsOperationGroupSchema.parse(operationGroup),
		),
	);
	const capabilityCore = props.createToolPortalCapabilityCore({
		approvalPort: props.approvalPort,
		semanticSnapshot: props.semanticSnapshot,
	});
	const semanticSnapshot = capabilityCore.semanticSnapshot;
	const preparedCatalogSourceCache =
		props.preparedCatalogSourceCache ?? createPreparedCatalogSourceCache();
	const privateUdsProjection = props.createPrivateUdsProjection({
		authenticatedOperationGroups,
		artifactOperations: createProtectedUdsArtifactProjectionOperations({
			artifactReader: props.artifactReader,
		}),
		catalogOperations: createCatalogProjectionOperations({
			capabilityCore,
			gatewayEpoch: props.managedPluginAttachment.gatewayEpoch,
			preparedCatalogSourceCache,
			semanticSnapshot,
		}),
		portalOperations: createPortalProjectionOperations({ capabilityCore }),
		semanticSnapshot,
		capabilityCore,
	});

	return { capabilityCore, privateUdsProjection, semanticSnapshot };
}
