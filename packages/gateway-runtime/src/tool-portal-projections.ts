import type {
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
import type { ToolPortalApprovalPort, ToolPortalCapabilityCore } from '@agent-vm/tool-portal';
import { z } from 'zod';

import {
	gatewayRuntimeArtifactStablePrincipalFromTrustedContext,
	type GatewayRuntimeArtifactReader,
} from './artifacts/artifact-store.js';

export const GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS = [
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

const ManagedPluginClientKindSchema = z.enum(['openclaw-managed-plugin', 'hermes-managed-plugin']);
const PrivateUdsOperationGroupSchema = z.enum(
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
);
export type GatewayRuntimeManagedPluginClientKind = z.infer<typeof ManagedPluginClientKindSchema>;
export type GatewayRuntimePrivateUdsOperationGroup = z.infer<typeof PrivateUdsOperationGroupSchema>;

export interface GatewayRuntimePortalCallInvocation {
	readonly publicRequest: PortalCallRequest;
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
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimePortalListInvocation {
	readonly publicRequest: PortalListRequest;
	readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
}

export interface GatewayRuntimePortalSearchInvocation {
	readonly publicRequest: PortalSearchRequest;
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

export interface GatewayRuntimePortalProjectionCommonProps {
	readonly portalOperations: GatewayRuntimePortalProjectionOperations;
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
	readonly capabilityCore: ToolPortalCapabilityCore<'managed'>;
}

export interface GatewayRuntimePrivateUdsProjectionFactoryProps extends GatewayRuntimePortalProjectionCommonProps {
	readonly authenticatedOperationGroups: readonly GatewayRuntimePrivateUdsOperationGroup[];
	readonly artifactOperations: GatewayRuntimeArtifactProjectionOperations;
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
		readonly projectionCohortDigest: string;
	};
	readonly semanticSnapshot: GatewayRuntimePortalSemanticSnapshot;
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
				surfaceClass: 'protected_uds',
			}),
		describe: async (invocation) =>
			await props.capabilityCore.describe(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				surfaceClass: 'protected_uds',
			}),
		list: async (invocation) =>
			await props.capabilityCore.list(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
				surfaceClass: 'protected_uds',
			}),
		search: async (invocation) =>
			await props.capabilityCore.search(invocation.publicRequest, {
				origin: { kind: 'managed', trustedContext: invocation.trustedContext },
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
	const privateUdsProjection = props.createPrivateUdsProjection({
		authenticatedOperationGroups,
		artifactOperations: createProtectedUdsArtifactProjectionOperations({
			artifactReader: props.artifactReader,
		}),
		portalOperations: createPortalProjectionOperations({ capabilityCore }),
		semanticSnapshot,
		capabilityCore,
	});

	return { capabilityCore, privateUdsProjection, semanticSnapshot };
}
