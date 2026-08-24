import type { GatewayRuntimeAttachmentMetadata } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { createGatewayRuntimeManagedToolPortalConfig } from '@agent-vm/config-contracts';
import {
	GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT,
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs,
	deriveGatewayRuntimeInputRevision,
	type GatewayRuntimePortalAdmissionMaterial,
	type ManagedAgentProjection,
} from '@agent-vm/gateway-control-contracts';
import type {
	GatewayZoneObservabilityConfig,
	ManagedGatewayBootContract,
} from '@agent-vm/gateway-lifecycle';
import {
	GatewayRuntimeServiceConfigSchema,
	type GatewayRuntimeServiceConfig,
} from '@agent-vm/gateway-runtime';

import type { GatewayControlSessionMaterial } from '../controller/control-session/index.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';
export const managedGatewayRuntimeRoot = '/run/agent-vm/gateway-runtime';
export const managedGatewayRuntimeMcpConfigPath = '/run/agent-vm/managed-gateway/mcp.config.json';

export interface ManagedGatewayRuntimeGeneratedIdentity {
	readonly attachmentGeneration: number;
	readonly frameworkEpoch: string;
	readonly runtimeEpoch: string;
}

export interface BuildManagedGatewayExpectedAdmissionCohortProps {
	readonly bootContract: ManagedGatewayBootContract;
	readonly controlSessionMaterial: GatewayControlSessionMaterial;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly generatedIdentity: ManagedGatewayRuntimeGeneratedIdentity;
	readonly portalAdmission: GatewayRuntimePortalAdmissionMaterial;
}

export interface GatewayRuntimeArtifactLimits {
	readonly maximumArtifactBytes: number;
	readonly maximumArtifactCount: number;
	readonly maximumLifetimeMs: number;
	readonly maximumTotalBytes: number;
}

export const controllerFixedGatewayRuntimeArtifactLimits = Object.freeze({
	maximumArtifactBytes: 1_024 * 1_024,
	maximumArtifactCount: 32,
	maximumLifetimeMs: 5 * 60 * 1_000,
	maximumTotalBytes: 8 * 1_024 * 1_024,
}) satisfies GatewayRuntimeArtifactLimits;

export interface BuildManagedGatewayRuntimeServiceConfigProps {
	readonly artifactLimits: GatewayRuntimeArtifactLimits;
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly controlSessionMaterial: GatewayControlSessionMaterial;
	readonly observability: GatewayZoneObservabilityConfig | undefined;
	readonly portalAdmission: GatewayRuntimePortalAdmissionMaterial;
}

export interface BuildManagedGatewayFrameworkAdapterMaterialProps {
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly portalAdmission: GatewayRuntimePortalAdmissionMaterial;
}

export interface ManagedGatewayFrameworkAdapterMaterial {
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly attachment: GatewayRuntimeAttachmentMetadata;
}

function frameworkClientKind(): GatewayRuntimeAttachmentMetadata['clientKind'] {
	return 'hermes-managed-plugin';
}

function buildManagedGatewayAttachmentMetadata(
	props: BuildManagedGatewayExpectedAdmissionCohortProps,
): GatewayRuntimeAttachmentMetadata {
	return Object.freeze({
		attachmentGeneration: props.generatedIdentity.attachmentGeneration,
		clientKind: frameworkClientKind(),
		configuredAgentIds: Object.freeze(
			Object.keys(props.portalAdmission.effectiveToolPortalConfig.agents).toSorted(),
		),
		frameworkEpoch: props.generatedIdentity.frameworkEpoch,
		gatewayEpoch: props.gatewayIdentity.generationId,
		protocolVersion: 1,
		projectionCohortDigest: props.portalAdmission.semanticSnapshot.projectionCohortDigest,
		runtimeEpoch: props.generatedIdentity.runtimeEpoch,
		schemaVersion: 1,
	});
}

export function buildManagedGatewayExpectedAdmissionCohort(
	props: BuildManagedGatewayExpectedAdmissionCohortProps,
): GatewayExpectedAdmissionCohort {
	const attachment = buildManagedGatewayAttachmentMetadata(props);
	const semanticSnapshot = props.portalAdmission.semanticSnapshot;
	return Object.freeze({
		controlIdentity: Object.freeze({
			controllerEpoch: props.controlSessionMaterial.controllerEpoch,
			generationId: props.controlSessionMaterial.generationId,
			peerId: props.controlSessionMaterial.peerId,
			processEpoch: props.controlSessionMaterial.processEpoch,
		}),
		fence: Object.freeze({
			controllerEpoch: props.gatewayIdentity.controllerEpoch,
			gatewayEpoch: props.gatewayIdentity.generationId,
			vmId: props.gatewayIdentity.gatewayVmId,
			zoneId: props.gatewayIdentity.zoneId,
		}),
		frameworkIdentity: Object.freeze({
			attachmentGeneration: attachment.attachmentGeneration,
			clientKind: attachment.clientKind,
			configuredAgentIds: attachment.configuredAgentIds,
			frameworkEpoch: attachment.frameworkEpoch,
			frameworkKind: props.bootContract.frameworkService.framework,
			projectionCohortDigest: attachment.projectionCohortDigest,
		}),
		ingressIntent: Object.freeze({
			controlRoute: Object.freeze({
				audience: 'gateway-control',
				guestPort: GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT.port,
				kind: 'tool-portal-control' as const,
				prefix: '/__agent-vm',
				stripPrefix: false,
			}),
			frameworkRootRoute: Object.freeze({
				guestPort: props.bootContract.frameworkService.ingress.guestPort,
				kind: 'framework-root' as const,
				prefix: '/',
				stripPrefix: true,
			}),
		}),
		providerRevision: semanticSnapshot.providerRevision,
		requiredBackendRevision: semanticSnapshot.bindingRevision,
		semanticRevision: semanticSnapshot.activeRevision,
		toolPortalIdentity: Object.freeze({
			processEpoch: props.controlSessionMaterial.processEpoch,
			role: 'tool-portal' as const,
			runtimeEpoch: attachment.runtimeEpoch,
			serviceId: `tool-portal-${props.gatewayIdentity.zoneId}`,
		}),
		udsIdentity: Object.freeze({
			frameworkEpoch: attachment.frameworkEpoch,
			gatewayEpoch: attachment.gatewayEpoch,
			runtimeEpoch: attachment.runtimeEpoch,
			socketPath: props.bootContract.toolPortalService.readiness.socketPath,
		}),
	});
}

export function buildManagedGatewayRuntimeAttachmentMetadata(
	cohort: GatewayExpectedAdmissionCohort,
): GatewayRuntimeAttachmentMetadata {
	return Object.freeze({
		attachmentGeneration: cohort.frameworkIdentity.attachmentGeneration,
		clientKind: cohort.frameworkIdentity.clientKind,
		configuredAgentIds: Object.freeze([...cohort.frameworkIdentity.configuredAgentIds]),
		frameworkEpoch: cohort.frameworkIdentity.frameworkEpoch,
		gatewayEpoch: cohort.fence.gatewayEpoch,
		protocolVersion: 1,
		projectionCohortDigest: cohort.frameworkIdentity.projectionCohortDigest,
		runtimeEpoch: cohort.toolPortalIdentity.runtimeEpoch,
		schemaVersion: 1,
	});
}

function sameExactAgentSet(
	leftAgentIds: readonly string[],
	rightAgentIds: readonly string[],
): boolean {
	const sortedLeftAgentIds = [...leftAgentIds].toSorted();
	const sortedRightAgentIds = [...rightAgentIds].toSorted();
	return (
		new Set(leftAgentIds).size === leftAgentIds.length &&
		new Set(rightAgentIds).size === rightAgentIds.length &&
		sortedLeftAgentIds.length === sortedRightAgentIds.length &&
		sortedLeftAgentIds.every((agentId, index) => agentId === sortedRightAgentIds[index])
	);
}

function frozenManagedAgentProjection(projection: ManagedAgentProjection): ManagedAgentProjection {
	return Object.freeze({
		...projection,
		frameworkIdentity: Object.freeze({ ...projection.frameworkIdentity }),
	});
}

export function buildManagedGatewayFrameworkAdapterMaterial(
	props: BuildManagedGatewayFrameworkAdapterMaterialProps,
): ManagedGatewayFrameworkAdapterMaterial {
	const attachment = buildManagedGatewayRuntimeAttachmentMetadata(props.cohort);
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
		mcpConfig: props.portalAdmission.effectiveMcpConfig,
		semanticSnapshot: props.portalAdmission.semanticSnapshot,
		toolPortalConfig: props.portalAdmission.effectiveToolPortalConfig,
	});
	const expectedClientKind = frameworkClientKind();
	if (attachment.clientKind !== expectedClientKind) {
		throw new Error('Managed Gateway adapter framework and client kind do not match.');
	}

	const configuredAgentIds = [...attachment.configuredAgentIds].toSorted();
	const toolPortalAgentIds = Object.keys(props.portalAdmission.effectiveToolPortalConfig.agents);
	const projectionAgentIds = Object.keys(props.portalAdmission.semanticSnapshot.agentProjections);
	if (
		!sameExactAgentSet(configuredAgentIds, toolPortalAgentIds) ||
		!sameExactAgentSet(configuredAgentIds, projectionAgentIds)
	) {
		throw new Error('Managed Gateway adapter agent sets must match exactly.');
	}
	if (
		attachment.projectionCohortDigest !==
		props.portalAdmission.semanticSnapshot.projectionCohortDigest
	) {
		throw new Error('Managed Gateway adapter projection cohort digest does not match.');
	}

	const agentProjectionEntries = configuredAgentIds.map((agentId) => {
		const configuredAgent = props.portalAdmission.effectiveToolPortalConfig.agents[agentId];
		const projection = props.portalAdmission.semanticSnapshot.agentProjections[agentId];
		if (configuredAgent === undefined || projection === undefined) {
			throw new Error(`Managed Gateway adapter requires a projection for agent '${agentId}'.`);
		}
		if (projection.frameworkIdentity.kind !== props.cohort.frameworkIdentity.frameworkKind) {
			throw new Error(
				`Managed Gateway adapter framework projection does not match for agent '${agentId}'.`,
			);
		}
		if (projection.toolPortalProfileId !== configuredAgent.profile) {
			throw new Error(
				`Managed Gateway adapter profile assignment does not match for agent '${agentId}'.`,
			);
		}
		if (projection.profileAssignmentRevision.trim() === '') {
			throw new Error(
				`Managed Gateway adapter requires a profile assignment revision for agent '${agentId}'.`,
			);
		}
		return [agentId, frozenManagedAgentProjection(projection)] as const;
	});

	return Object.freeze({
		agentProjections: Object.freeze(Object.fromEntries(agentProjectionEntries)),
		attachment,
	});
}

export function buildManagedGatewayRuntimeServiceConfig(
	props: BuildManagedGatewayRuntimeServiceConfigProps,
): GatewayRuntimeServiceConfig {
	const attachment = buildManagedGatewayRuntimeAttachmentMetadata(props.cohort);
	const observability =
		props.observability === undefined
			? ({ kind: 'disabled' } as const)
			: ({
					...props.observability.toolPortal,
					endpoint: `http://${props.observability.collector.host}:${props.observability.collector.httpPort}`,
					kind: 'otlp-http',
				} as const);
	const gatewayRuntimeToolPortalConfig = createGatewayRuntimeManagedToolPortalConfig(
		props.portalAdmission.effectiveToolPortalConfig,
	);
	return GatewayRuntimeServiceConfigSchema.parse({
		artifactLimits: props.artifactLimits,
		attachment: {
			attachmentGeneration: attachment.attachmentGeneration,
			clientKind: attachment.clientKind,
			configuredAgentIds: attachment.configuredAgentIds,
			frameworkEpoch: attachment.frameworkEpoch,
			gatewayEpoch: attachment.gatewayEpoch,
			projectionCohortDigest: attachment.projectionCohortDigest,
			runtimeEpoch: attachment.runtimeEpoch,
		},
		controlEndpoint: {
			authority: {
				callerContextAgentAuthorityKeys: props.controlSessionMaterial.agentAuthorityKeys,
				callerContextProofKey: props.controlSessionMaterial.callerContextProofKey,
				verifierPublicKeyPem: props.controlSessionMaterial.verifierPublicKeyPem,
			},
			identity: {
				bootId: props.controlSessionMaterial.bootId,
				controllerEpoch: props.controlSessionMaterial.controllerEpoch,
				generationId: props.controlSessionMaterial.generationId,
				peerId: props.controlSessionMaterial.peerId,
				processEpoch: props.controlSessionMaterial.processEpoch,
				zoneId: props.controlSessionMaterial.zoneId,
			},
			listen: GATEWAY_RUNTIME_TOOL_PORTAL_PRODUCTION_CONTROL_ENDPOINT,
		},
		gatewayRuntimeInputRevision: deriveGatewayRuntimeInputRevision({
			mcpConfig: props.portalAdmission.effectiveMcpConfig,
			toolPortalConfig: gatewayRuntimeToolPortalConfig,
		}),
		mcpConfigPath: managedGatewayRuntimeMcpConfigPath,
		observability,
		runtimeRoot: managedGatewayRuntimeRoot,
		schemaVersion: 1,
		semanticSnapshot: props.portalAdmission.semanticSnapshot,
		serviceIdentity: {
			processEpoch: props.cohort.toolPortalIdentity.processEpoch,
			role: props.cohort.toolPortalIdentity.role,
			serviceId: props.cohort.toolPortalIdentity.serviceId,
		},
		toolPortalConfig: gatewayRuntimeToolPortalConfig,
	});
}
