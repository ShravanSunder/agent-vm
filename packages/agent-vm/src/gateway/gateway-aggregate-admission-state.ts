import { isDeepStrictEqual } from 'node:util';

export type ManagedGatewayFrameworkKind = 'hermes';
export type ManagedGatewayClientKind = 'hermes-managed-plugin';

export interface GatewayAdmissionFence {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly vmId: string;
	readonly zoneId: string;
}

export interface GatewayToolPortalAdmissionIdentity {
	readonly processEpoch: string;
	readonly role: 'tool-portal';
	readonly runtimeEpoch: string;
	readonly serviceId: string;
}

export interface GatewayFrameworkAdmissionIdentity {
	readonly attachmentGeneration: number;
	readonly clientKind: ManagedGatewayClientKind;
	readonly configuredAgentIds: readonly string[];
	readonly frameworkEpoch: string;
	readonly frameworkKind: ManagedGatewayFrameworkKind;
	readonly projectionCohortDigest: string;
}

export interface GatewayUdsAdmissionIdentity {
	readonly frameworkEpoch: string;
	readonly gatewayEpoch: string;
	readonly runtimeEpoch: string;
	readonly socketPath: string;
}

export interface GatewayAcceptedUdsAttachmentIdentity
	extends GatewayFrameworkAdmissionIdentity, GatewayUdsAdmissionIdentity {}

export interface GatewayControlAdmissionIdentity {
	readonly controllerEpoch: string;
	readonly generationId: string;
	readonly peerId: string;
	readonly processEpoch: string;
}

interface GatewayIngressRouteIdentityBase {
	readonly guestPort: number;
	readonly prefix: string;
	readonly stripPrefix: boolean;
}

export interface GatewayFrameworkRootIngressRouteIdentity extends GatewayIngressRouteIdentityBase {
	readonly kind: 'framework-root';
}

export interface GatewayProtectedIngressRouteIdentity extends GatewayIngressRouteIdentityBase {
	readonly audience: string;
	readonly kind: 'tool-portal-control';
}

export type GatewayIngressRouteIdentity =
	| GatewayFrameworkRootIngressRouteIdentity
	| GatewayProtectedIngressRouteIdentity;

export interface GatewayIngressAdmissionIntent {
	readonly controlRoute: GatewayProtectedIngressRouteIdentity & {
		readonly kind: 'tool-portal-control';
	};
	readonly frameworkRootRoute: GatewayFrameworkRootIngressRouteIdentity;
}

export interface GatewayExpectedAdmissionCohort {
	readonly controlIdentity: GatewayControlAdmissionIdentity;
	readonly fence: GatewayAdmissionFence;
	readonly frameworkIdentity: GatewayFrameworkAdmissionIdentity;
	readonly ingressIntent: GatewayIngressAdmissionIntent;
	readonly providerRevision: string;
	readonly requiredBackendRevision: string;
	readonly semanticRevision: string;
	readonly toolPortalIdentity: GatewayToolPortalAdmissionIdentity;
	readonly udsIdentity: GatewayUdsAdmissionIdentity;
}

export type GatewayAdmissionPlaneObservation<TIdentity> =
	| { readonly identity: TIdentity; readonly kind: 'lost' }
	| { readonly kind: 'pending' }
	| { readonly identity: TIdentity; readonly kind: 'ready' };

export type GatewayFatalEvidenceObservation =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'observed';
			readonly observedGatewayEpoch: string;
			readonly role: 'framework-service' | 'tool-portal-service';
	  };

export interface GatewayReadinessVector {
	readonly authorityBearingControl: GatewayAdmissionPlaneObservation<GatewayControlAdmissionIdentity>;
	readonly fatalEvidence: GatewayFatalEvidenceObservation;
	readonly frameworkIdentity: GatewayAdmissionPlaneObservation<GatewayFrameworkAdmissionIdentity>;
	readonly frameworkNativeReadiness: GatewayAdmissionPlaneObservation<GatewayFrameworkAdmissionIdentity>;
	readonly ingressRoutes: readonly GatewayIngressRouteIdentity[];
	readonly providerRevision: GatewayAdmissionPlaneObservation<string>;
	readonly requiredBackends: GatewayAdmissionPlaneObservation<string>;
	readonly semanticRevision: GatewayAdmissionPlaneObservation<string>;
	readonly toolPortalIdentity: GatewayAdmissionPlaneObservation<GatewayToolPortalAdmissionIdentity>;
	readonly toolPortalReadiness: GatewayAdmissionPlaneObservation<GatewayToolPortalAdmissionIdentity>;
	readonly udsAttachment: GatewayAdmissionPlaneObservation<GatewayAcceptedUdsAttachmentIdentity>;
	readonly udsPublication: GatewayAdmissionPlaneObservation<GatewayUdsAdmissionIdentity>;
	readonly vmLiveness: GatewayAdmissionPlaneObservation<GatewayAdmissionFence>;
}

export type GatewayReadinessPlaneName =
	| 'vm-liveness'
	| 'tool-portal-identity'
	| 'tool-portal-readiness'
	| 'framework-identity'
	| 'framework-native-readiness'
	| 'semantic-revision'
	| 'provider-revision'
	| 'uds-publication'
	| 'uds-attachment'
	| 'authority-bearing-control'
	| 'required-backends';

export type GatewayAdmissionContainmentReason =
	| `${GatewayReadinessPlaneName}-mismatch`
	| 'framework-service-fatal'
	| 'missing-control-ingress-route'
	| 'premature-public-ingress'
	| 'tool-portal-service-fatal'
	| 'unexpected-ingress-route';

export type GatewayAdmissionEvaluationPhase = 'admitted' | 'joining' | 'publishing-ingress';

export interface GatewayAdmissionEvaluationInput {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly phase: GatewayAdmissionEvaluationPhase;
	readonly vector: GatewayReadinessVector;
}

export type GatewayAggregateAdmissionDecision =
	| {
			readonly kind: 'admitted';
			readonly routes: readonly GatewayIngressRouteIdentity[];
	  }
	| {
			readonly kind: 'contain';
			readonly reasons: readonly GatewayAdmissionContainmentReason[];
			readonly withdrawIngress: boolean;
	  }
	| {
			readonly kind: 'publish-ingress';
			readonly routes: readonly GatewayIngressRouteIdentity[];
	  }
	| {
			readonly kind: 'waiting';
			readonly pendingPlanes: readonly GatewayReadinessPlaneName[];
	  }
	| {
			readonly kind: 'withdraw-ingress';
			readonly lostPlanes: readonly GatewayReadinessPlaneName[];
			readonly retainRoutes: readonly GatewayIngressRouteIdentity[];
	  };

interface AdmissionEvaluationAccumulator {
	readonly lostPlanes: GatewayReadinessPlaneName[];
	readonly mismatchReasons: GatewayAdmissionContainmentReason[];
	readonly pendingPlanes: GatewayReadinessPlaneName[];
}

function observeAdmissionPlane<TIdentity>(props: {
	readonly accumulator: AdmissionEvaluationAccumulator;
	readonly expectedIdentity: TIdentity;
	readonly observation: GatewayAdmissionPlaneObservation<TIdentity>;
	readonly plane: GatewayReadinessPlaneName;
	readonly sameIdentity?: (leftIdentity: TIdentity, rightIdentity: TIdentity) => boolean;
}): void {
	const sameIdentity = props.sameIdentity ?? isDeepStrictEqual;
	if (props.observation.kind === 'pending') {
		props.accumulator.pendingPlanes.push(props.plane);
		return;
	}
	if (props.observation.kind === 'lost') {
		if (sameIdentity(props.observation.identity, props.expectedIdentity)) {
			props.accumulator.lostPlanes.push(props.plane);
		}
		return;
	}
	if (!sameIdentity(props.observation.identity, props.expectedIdentity)) {
		props.accumulator.mismatchReasons.push(`${props.plane}-mismatch`);
	}
}

function sameConfiguredAgentIdentity<TIdentity extends GatewayFrameworkAdmissionIdentity>(
	leftIdentity: TIdentity,
	rightIdentity: TIdentity,
): boolean {
	const { configuredAgentIds: leftAgentIds, ...leftFields } = leftIdentity;
	const { configuredAgentIds: rightAgentIds, ...rightFields } = rightIdentity;
	return (
		isDeepStrictEqual(leftFields, rightFields) &&
		isDeepStrictEqual([...leftAgentIds].toSorted(), [...rightAgentIds].toSorted())
	);
}

const routeKindOrder = {
	'tool-portal-control': 0,
	'framework-root': 1,
} as const satisfies Readonly<Record<GatewayIngressRouteIdentity['kind'], number>>;

function compareIngressRoutes(
	leftRoute: GatewayIngressRouteIdentity,
	rightRoute: GatewayIngressRouteIdentity,
): number {
	const kindDifference = routeKindOrder[leftRoute.kind] - routeKindOrder[rightRoute.kind];
	if (kindDifference !== 0) return kindDifference;
	const prefixDifference = leftRoute.prefix.localeCompare(rightRoute.prefix);
	if (prefixDifference !== 0) return prefixDifference;
	return leftRoute.guestPort - rightRoute.guestPort;
}

function sameIngressRoutes(
	leftRoutes: readonly GatewayIngressRouteIdentity[],
	rightRoutes: readonly GatewayIngressRouteIdentity[],
): boolean {
	return isDeepStrictEqual(
		[...leftRoutes].toSorted(compareIngressRoutes),
		[...rightRoutes].toSorted(compareIngressRoutes),
	);
}

function expectedFinalIngressRoutes(
	intent: GatewayIngressAdmissionIntent,
): readonly GatewayIngressRouteIdentity[] {
	return Object.freeze([intent.controlRoute, intent.frameworkRootRoute]);
}

function hasPublicIngress(routes: readonly GatewayIngressRouteIdentity[]): boolean {
	return routes.some((route) => route.kind !== 'tool-portal-control');
}

function frozenPlaneNames(
	planes: readonly GatewayReadinessPlaneName[],
): readonly GatewayReadinessPlaneName[] {
	return Object.freeze([...planes]);
}

function frozenReasons(
	reasons: readonly GatewayAdmissionContainmentReason[],
): readonly GatewayAdmissionContainmentReason[] {
	return Object.freeze([...reasons]);
}

export function evaluateGatewayAggregateAdmission(
	input: GatewayAdmissionEvaluationInput,
): GatewayAggregateAdmissionDecision {
	const accumulator: AdmissionEvaluationAccumulator = {
		lostPlanes: [],
		mismatchReasons: [],
		pendingPlanes: [],
	};
	const { expectedCohort, vector } = input;

	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.fence,
		observation: vector.vmLiveness,
		plane: 'vm-liveness',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.toolPortalIdentity,
		observation: vector.toolPortalIdentity,
		plane: 'tool-portal-identity',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.toolPortalIdentity,
		observation: vector.toolPortalReadiness,
		plane: 'tool-portal-readiness',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.frameworkIdentity,
		observation: vector.frameworkIdentity,
		plane: 'framework-identity',
		sameIdentity: sameConfiguredAgentIdentity,
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.frameworkIdentity,
		observation: vector.frameworkNativeReadiness,
		plane: 'framework-native-readiness',
		sameIdentity: sameConfiguredAgentIdentity,
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.semanticRevision,
		observation: vector.semanticRevision,
		plane: 'semantic-revision',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.providerRevision,
		observation: vector.providerRevision,
		plane: 'provider-revision',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.udsIdentity,
		observation: vector.udsPublication,
		plane: 'uds-publication',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: {
			...expectedCohort.frameworkIdentity,
			...expectedCohort.udsIdentity,
		},
		observation: vector.udsAttachment,
		plane: 'uds-attachment',
		sameIdentity: sameConfiguredAgentIdentity,
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.controlIdentity,
		observation: vector.authorityBearingControl,
		plane: 'authority-bearing-control',
	});
	observeAdmissionPlane({
		accumulator,
		expectedIdentity: expectedCohort.requiredBackendRevision,
		observation: vector.requiredBackends,
		plane: 'required-backends',
	});

	if (
		vector.fatalEvidence.kind === 'observed' &&
		vector.fatalEvidence.observedGatewayEpoch === expectedCohort.fence.gatewayEpoch
	) {
		accumulator.mismatchReasons.push(
			vector.fatalEvidence.role === 'tool-portal-service'
				? 'tool-portal-service-fatal'
				: 'framework-service-fatal',
		);
	}

	const expectedControlRoutes = [expectedCohort.ingressIntent.controlRoute];
	const finalRoutes = expectedFinalIngressRoutes(expectedCohort.ingressIntent);
	const controlRouteOnly = sameIngressRoutes(vector.ingressRoutes, expectedControlRoutes);
	const exactFinalRoutes = sameIngressRoutes(vector.ingressRoutes, finalRoutes);
	const publicIngressPresent = hasPublicIngress(vector.ingressRoutes);
	if (!controlRouteOnly && !exactFinalRoutes) {
		accumulator.mismatchReasons.push(
			vector.ingressRoutes.some((route) => route.kind === 'tool-portal-control')
				? 'unexpected-ingress-route'
				: 'missing-control-ingress-route',
		);
	}

	if (accumulator.mismatchReasons.length > 0) {
		return Object.freeze({
			kind: 'contain',
			reasons: frozenReasons(accumulator.mismatchReasons),
			withdrawIngress: publicIngressPresent,
		});
	}

	const unavailablePlanes = [...accumulator.pendingPlanes, ...accumulator.lostPlanes];
	if (input.phase === 'joining' && publicIngressPresent) {
		return Object.freeze({
			kind: 'contain',
			reasons: frozenReasons(['premature-public-ingress']),
			withdrawIngress: true,
		});
	}
	if (unavailablePlanes.length > 0) {
		if (input.phase === 'admitted' || input.phase === 'publishing-ingress') {
			return Object.freeze({
				kind: 'withdraw-ingress',
				lostPlanes: frozenPlaneNames(unavailablePlanes),
				retainRoutes: Object.freeze([expectedCohort.ingressIntent.controlRoute]),
			});
		}
		return Object.freeze({
			kind: 'waiting',
			pendingPlanes: frozenPlaneNames(unavailablePlanes),
		});
	}

	if (controlRouteOnly) {
		return Object.freeze({
			kind: 'publish-ingress',
			routes: finalRoutes,
		});
	}
	return Object.freeze({
		kind: 'admitted',
		routes: finalRoutes,
	});
}
