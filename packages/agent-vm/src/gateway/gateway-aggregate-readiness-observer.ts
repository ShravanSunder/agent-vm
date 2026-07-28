import type { GatewayDisposableControlSessionDiagnostics } from '../controller/control-session/gateway-disposable-control-session-client.js';
import type {
	GatewayAdmissionFence,
	GatewayAdmissionPlaneObservation,
	GatewayControlAdmissionIdentity,
	GatewayExpectedAdmissionCohort,
	GatewayFatalEvidenceObservation,
	GatewayFrameworkAdmissionIdentity,
	GatewayIngressRouteIdentity,
	GatewayReadinessVector,
} from './gateway-aggregate-admission-state.js';
import type { GatewayHealthProbeResult } from './gateway-health-check.js';
import {
	mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes,
	type GatewayRuntimeRoleReadinessEvidence,
} from './gateway-runtime-readiness-plane-mapper.js';

export type GatewayVmLivenessEvidence =
	| { readonly kind: 'pending' }
	| { readonly identity: GatewayAdmissionFence; readonly kind: 'current' | 'lost' };

export type GatewayFrameworkNativeReadinessEvidence =
	| { readonly kind: 'pending' }
	| {
			readonly identity: GatewayFrameworkAdmissionIdentity;
			readonly kind: 'current';
			readonly probe: GatewayHealthProbeResult;
	  }
	| {
			readonly identity: GatewayFrameworkAdmissionIdentity;
			readonly kind: 'lost';
			readonly probe?: GatewayHealthProbeResult;
	  };

export type GatewayControlSessionReadinessEvidence =
	| { readonly kind: 'pending' }
	| {
			readonly diagnostics: GatewayDisposableControlSessionDiagnostics;
			readonly identity: GatewayControlAdmissionIdentity;
			readonly kind: 'current';
	  }
	| {
			readonly diagnostics: GatewayDisposableControlSessionDiagnostics;
			readonly identity: GatewayControlAdmissionIdentity;
			readonly kind: 'lost';
	  };

export interface GatewayAggregateReadinessCompositionInput {
	readonly appliedIngressRoutes: readonly GatewayIngressRouteIdentity[];
	readonly controlSessionEvidence?: GatewayControlSessionReadinessEvidence | undefined;
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly fatalEvidence: GatewayFatalEvidenceObservation;
	readonly frameworkNativeReadinessEvidence?: GatewayFrameworkNativeReadinessEvidence | undefined;
	readonly runtimeReadinessEvidence?: GatewayRuntimeRoleReadinessEvidence | undefined;
	readonly vmLivenessEvidence?: GatewayVmLivenessEvidence | undefined;
}

export interface GatewayAggregateReadinessEvidenceSources {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly readAppliedIngressRoutes: () => readonly GatewayIngressRouteIdentity[];
	readonly readControlSessionEvidence: () => GatewayControlSessionReadinessEvidence | undefined;
	readonly readFatalEvidence: () => GatewayFatalEvidenceObservation;
	readonly readFrameworkNativeReadinessEvidence: () =>
		| GatewayFrameworkNativeReadinessEvidence
		| undefined;
	readonly readRuntimeReadinessEvidence: () => GatewayRuntimeRoleReadinessEvidence | undefined;
	readonly readVmLivenessEvidence: () => GatewayVmLivenessEvidence | undefined;
}

export interface GatewayAggregateReadinessObserver {
	getSnapshot(): GatewayReadinessVector;
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

function deepFreeze<TValue>(value: TValue): TValue {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const childValue of Object.values(value)) {
		deepFreeze(childValue);
	}
	return Object.freeze(value);
}

function freezeSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
	return deepFreeze(structuredClone(snapshot));
}

function mapVmLivenessEvidence(
	evidence: GatewayVmLivenessEvidence | undefined,
): GatewayAdmissionPlaneObservation<GatewayAdmissionFence> {
	if (evidence === undefined || evidence.kind === 'pending') return pending();
	return evidence.kind === 'current' ? ready(evidence.identity) : lost(evidence.identity);
}

function mapFrameworkNativeReadinessEvidence(
	evidence: GatewayFrameworkNativeReadinessEvidence | undefined,
): GatewayAdmissionPlaneObservation<GatewayFrameworkAdmissionIdentity> {
	if (evidence === undefined || evidence.kind === 'pending') return pending();
	if (evidence.kind === 'lost' || !evidence.probe.ok) return lost(evidence.identity);
	return ready(evidence.identity);
}

function hasNoAcceptedControlSessionEvidence(
	diagnostics: GatewayDisposableControlSessionDiagnostics,
): boolean {
	return (
		!diagnostics.accepted &&
		!diagnostics.ready &&
		diagnostics.helloCount === 0 &&
		diagnostics.lastHelloResponse === undefined &&
		!diagnostics.reconnectExhausted
	);
}

function diagnosticsMatchAcceptedControlIdentity(props: {
	readonly diagnostics: GatewayDisposableControlSessionDiagnostics;
	readonly identity: GatewayControlAdmissionIdentity;
}): boolean {
	const response = props.diagnostics.lastHelloResponse;
	return (
		props.diagnostics.accepted &&
		props.diagnostics.connected &&
		props.diagnostics.ready &&
		response?.outcome === 'accepted' &&
		response.controllerEpoch === props.identity.controllerEpoch &&
		response.attachmentGeneration === props.diagnostics.attachmentGeneration
	);
}

function mapControlSessionEvidence(
	evidence: GatewayControlSessionReadinessEvidence | undefined,
): GatewayAdmissionPlaneObservation<GatewayControlAdmissionIdentity> {
	if (evidence === undefined || evidence.kind === 'pending') return pending();
	if (evidence.kind === 'lost') return lost(evidence.identity);
	if (diagnosticsMatchAcceptedControlIdentity(evidence)) return ready(evidence.identity);
	return hasNoAcceptedControlSessionEvidence(evidence.diagnostics)
		? pending()
		: lost(evidence.identity);
}

export function composeGatewayReadinessVector(
	input: GatewayAggregateReadinessCompositionInput,
): GatewayReadinessVector {
	const runtimePlanes = mapGatewayRuntimeReadinessEvidenceToAdmissionPlanes({
		evidence: input.runtimeReadinessEvidence ?? { kind: 'pending' },
	});
	const vector = {
		authorityBearingControl: mapControlSessionEvidence(input.controlSessionEvidence),
		fatalEvidence: input.fatalEvidence,
		frameworkIdentity: runtimePlanes.frameworkIdentity,
		frameworkNativeReadiness: mapFrameworkNativeReadinessEvidence(
			input.frameworkNativeReadinessEvidence,
		),
		ingressRoutes: input.appliedIngressRoutes,
		providerRevision: runtimePlanes.providerRevision,
		requiredBackends: runtimePlanes.requiredBackends,
		semanticRevision: runtimePlanes.semanticRevision,
		toolPortalIdentity: runtimePlanes.toolPortalIdentity,
		toolPortalReadiness: runtimePlanes.toolPortalReadiness,
		udsAttachment: runtimePlanes.udsAttachment,
		udsPublication: runtimePlanes.udsPublication,
		vmLiveness: mapVmLivenessEvidence(input.vmLivenessEvidence),
	} satisfies GatewayReadinessVector;
	return freezeSnapshot(vector);
}

export function createGatewayAggregateReadinessObserver(
	sources: GatewayAggregateReadinessEvidenceSources,
): GatewayAggregateReadinessObserver {
	return Object.freeze({
		getSnapshot(): GatewayReadinessVector {
			return composeGatewayReadinessVector({
				appliedIngressRoutes: sources.readAppliedIngressRoutes(),
				controlSessionEvidence: sources.readControlSessionEvidence(),
				expectedCohort: sources.expectedCohort,
				fatalEvidence: sources.readFatalEvidence(),
				frameworkNativeReadinessEvidence: sources.readFrameworkNativeReadinessEvidence(),
				runtimeReadinessEvidence: sources.readRuntimeReadinessEvidence(),
				vmLivenessEvidence: sources.readVmLivenessEvidence(),
			});
		},
	});
}
