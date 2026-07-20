import type { GatewayRuntimeReadinessSnapshot } from '@agent-vm/gateway-control-contracts';

import type {
	GatewayAcceptedUdsAttachmentIdentity,
	GatewayAdmissionPlaneObservation,
	GatewayFrameworkAdmissionIdentity,
	GatewayToolPortalAdmissionIdentity,
	GatewayUdsAdmissionIdentity,
} from './gateway-aggregate-admission-state.js';

export type GatewayRuntimeRoleReadinessEvidence =
	| { readonly kind: 'pending' }
	| {
			readonly kind: 'current';
			readonly snapshot: GatewayRuntimeReadinessSnapshot;
	  }
	| {
			readonly kind: 'lost';
			readonly snapshot: GatewayRuntimeReadinessSnapshot;
	  };

export interface GatewayRuntimeReadinessPlaneObservations {
	readonly frameworkIdentity: GatewayAdmissionPlaneObservation<GatewayFrameworkAdmissionIdentity>;
	readonly providerRevision: GatewayAdmissionPlaneObservation<string>;
	readonly requiredBackends: GatewayAdmissionPlaneObservation<string>;
	readonly semanticRevision: GatewayAdmissionPlaneObservation<string>;
	readonly toolPortalIdentity: GatewayAdmissionPlaneObservation<GatewayToolPortalAdmissionIdentity>;
	readonly toolPortalReadiness: GatewayAdmissionPlaneObservation<GatewayToolPortalAdmissionIdentity>;
	readonly udsAttachment: GatewayAdmissionPlaneObservation<GatewayAcceptedUdsAttachmentIdentity>;
	readonly udsPublication: GatewayAdmissionPlaneObservation<GatewayUdsAdmissionIdentity>;
}

function pending<TIdentity>(): GatewayAdmissionPlaneObservation<TIdentity> {
	return { kind: 'pending' };
}

function ready<TIdentity>(identity: TIdentity): GatewayAdmissionPlaneObservation<TIdentity> {
	return { identity, kind: 'ready' };
}

function lost<TIdentity>(identity: TIdentity): GatewayAdmissionPlaneObservation<TIdentity> {
	return { identity, kind: 'lost' };
}

function frameworkKindFromClientKind(
	clientKind: GatewayRuntimeReadinessSnapshot['uds']['attachment']['expected']['clientKind'],
): GatewayFrameworkAdmissionIdentity['frameworkKind'] {
	return clientKind === 'openclaw-managed-plugin' ? 'openclaw' : 'hermes';
}

function actualReadinessIdentities(snapshot: GatewayRuntimeReadinessSnapshot): {
	readonly framework: GatewayFrameworkAdmissionIdentity;
	readonly toolPortal: GatewayToolPortalAdmissionIdentity;
	readonly uds: GatewayUdsAdmissionIdentity;
	readonly udsAttachment: GatewayAcceptedUdsAttachmentIdentity;
} {
	const expectedAttachment = snapshot.uds.attachment.expected;
	const framework = {
		attachmentGeneration: expectedAttachment.attachmentGeneration,
		clientKind: expectedAttachment.clientKind,
		configuredAgentIds: expectedAttachment.configuredAgentIds,
		frameworkEpoch: expectedAttachment.frameworkEpoch,
		frameworkKind: frameworkKindFromClientKind(expectedAttachment.clientKind),
		projectionCohortDigest: expectedAttachment.projectionCohortDigest,
	} satisfies GatewayFrameworkAdmissionIdentity;
	const uds = {
		frameworkEpoch: expectedAttachment.frameworkEpoch,
		gatewayEpoch: expectedAttachment.gatewayEpoch,
		runtimeEpoch: expectedAttachment.runtimeEpoch,
		socketPath: snapshot.uds.publication.socketPath,
	} satisfies GatewayUdsAdmissionIdentity;
	return {
		framework,
		toolPortal: {
			processEpoch: snapshot.serviceIdentity.processEpoch,
			role: 'tool-portal',
			runtimeEpoch: expectedAttachment.runtimeEpoch,
			serviceId: snapshot.serviceIdentity.serviceId,
		},
		uds,
		udsAttachment: { ...framework, ...uds },
	};
}

export function mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes(props: {
	readonly evidence: GatewayRuntimeRoleReadinessEvidence;
}): GatewayRuntimeReadinessPlaneObservations {
	if (props.evidence.kind === 'pending') {
		return {
			frameworkIdentity: pending(),
			providerRevision: pending(),
			requiredBackends: pending(),
			semanticRevision: pending(),
			toolPortalIdentity: pending(),
			toolPortalReadiness: pending(),
			udsAttachment: pending(),
			udsPublication: pending(),
		};
	}

	const snapshot = props.evidence.snapshot;
	const identities = actualReadinessIdentities(snapshot);
	const lifecycleLost =
		props.evidence.kind === 'lost' || snapshot.uds.publication.status === 'retired';
	const observe = lifecycleLost ? lost : ready;
	const attachmentStatus = snapshot.uds.attachment.status;
	const attachmentObservation =
		attachmentStatus === 'awaiting-attachment'
			? pending<GatewayAcceptedUdsAttachmentIdentity>()
			: attachmentStatus === 'attached' && !lifecycleLost
				? ready(identities.udsAttachment)
				: lost(identities.udsAttachment);
	const frameworkObservation =
		attachmentStatus === 'awaiting-attachment'
			? pending<GatewayFrameworkAdmissionIdentity>()
			: attachmentStatus === 'attached' && !lifecycleLost
				? ready(identities.framework)
				: lost(identities.framework);

	return {
		frameworkIdentity: frameworkObservation,
		providerRevision: observe(snapshot.providerRevision),
		requiredBackends: observe(snapshot.requiredBackends.revision),
		semanticRevision: observe(snapshot.semanticRevision),
		toolPortalIdentity: observe(identities.toolPortal),
		toolPortalReadiness: observe(identities.toolPortal),
		udsAttachment: attachmentObservation,
		udsPublication: observe(identities.uds),
	};
}
