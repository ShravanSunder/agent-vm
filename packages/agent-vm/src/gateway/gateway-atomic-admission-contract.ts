import type {
	GatewayExpectedAdmissionCohort,
	GatewayIngressRouteIdentity,
	GatewayReadinessPlaneName,
	GatewayReadinessVector,
} from './gateway-aggregate-admission-state.js';

export interface GatewayAtomicAdmissionCandidate {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	/** Starts the already-materialized Gateway VM without guest-process authority. */
	readonly startGatewayVm: () => Promise<void>;
	/** Atomically replaces the controller-owned ingress inventory. */
	readonly replaceIngressRoutes: (routes: readonly GatewayIngressRouteIdentity[]) => Promise<void>;
	/** Positively contains the complete Gateway VM subtree before resolving. */
	readonly containGatewayVm: () => Promise<void>;
}

export type GatewayAtomicRecoveryTrigger =
	| 'aggregate-containment'
	| 'control-recovery-exhausted'
	| 'controller-restart'
	| 'framework-recovery-exhausted'
	| 'gateway-vm-death'
	| 'uds-recovery-exhausted';

export interface GatewayPredecessorQuiescenceReceipt {
	readonly kind: 'predecessor-quiescence-proven';
	readonly predecessor: GatewayExpectedAdmissionCohort;
}

export interface GatewayAtomicReplacementReceipt {
	readonly kind: 'replaced';
	readonly predecessorQuiescence: GatewayPredecessorQuiescenceReceipt;
	readonly successor: GatewayExpectedAdmissionCohort;
	readonly trigger: GatewayAtomicRecoveryTrigger;
}

export interface GatewayAtomicStartupContainmentReceipt {
	readonly kind: 'startup-contained';
	readonly predecessor: GatewayExpectedAdmissionCohort;
	readonly reason: string;
}

export type GatewayAtomicAdmissionFailureStage =
	| 'admitted-ingress-withdrawal'
	| 'initial-control-ingress'
	| 'initial-vm-start'
	| 'predecessor-containment'
	| 'replacement-ingress-withdrawal'
	| 'startup-containment'
	| 'startup-ingress-withdrawal'
	| 'startup-public-ingress'
	| 'successor-containment'
	| 'successor-control-ingress'
	| 'successor-creation'
	| 'successor-identity'
	| 'successor-start';

export type GatewayAtomicAdmissionSnapshot =
	| { readonly kind: 'idle' }
	| {
			readonly cohort: GatewayExpectedAdmissionCohort;
			readonly kind: 'joining' | 'publishing-ingress' | 'admitted';
	  }
	| {
			readonly cohort: GatewayExpectedAdmissionCohort;
			readonly kind: 'reconnecting';
			readonly lostPlanes: readonly GatewayReadinessPlaneName[];
	  }
	| {
			readonly kind: 'replacing';
			readonly predecessor: GatewayExpectedAdmissionCohort;
			readonly trigger: GatewayAtomicRecoveryTrigger;
	  }
	| {
			readonly kind: 'startup-failed';
			readonly receipt: GatewayAtomicStartupContainmentReceipt;
	  }
	| {
			readonly error: unknown;
			readonly kind: 'replacement-failed';
			readonly predecessorQuiescence: GatewayPredecessorQuiescenceReceipt;
			readonly stage: GatewayAtomicAdmissionFailureStage;
			readonly successor?: GatewayExpectedAdmissionCohort;
	  }
	| {
			readonly error: unknown;
			readonly kind: 'owner-unsafe';
			readonly stage: GatewayAtomicAdmissionFailureStage;
			readonly unsafeCohort: GatewayExpectedAdmissionCohort;
	  };

export type GatewayAtomicObservationResult =
	| GatewayAtomicReplacementReceipt
	| GatewayAtomicStartupContainmentReceipt
	| { readonly kind: 'admitted'; readonly routes: readonly GatewayIngressRouteIdentity[] }
	| { readonly kind: 'publishing-ingress'; readonly routes: readonly GatewayIngressRouteIdentity[] }
	| {
			readonly kind: 'reconnecting';
			readonly lostPlanes: readonly GatewayReadinessPlaneName[];
	  }
	| { readonly kind: 'waiting'; readonly pendingPlanes: readonly GatewayReadinessPlaneName[] };

export interface CreateGatewayAtomicAdmissionControllerOptions {
	readonly createSuccessorCandidate: (props: {
		readonly predecessorQuiescence: GatewayPredecessorQuiescenceReceipt;
		readonly trigger: GatewayAtomicRecoveryTrigger;
	}) => Promise<GatewayAtomicAdmissionCandidate>;
}

export interface GatewayAtomicAdmissionController {
	expireRecovery(
		trigger: Exclude<GatewayAtomicRecoveryTrigger, 'aggregate-containment' | 'controller-restart'>,
	): Promise<GatewayAtomicReplacementReceipt>;
	expireStartupJoin(reason: string): Promise<GatewayAtomicStartupContainmentReceipt>;
	getSnapshot(): GatewayAtomicAdmissionSnapshot;
	observe(vector: GatewayReadinessVector): Promise<GatewayAtomicObservationResult>;
	replaceRecordedPredecessor(
		predecessor: GatewayAtomicAdmissionCandidate,
		trigger: 'controller-restart',
	): Promise<GatewayAtomicReplacementReceipt>;
	start(candidate: GatewayAtomicAdmissionCandidate): Promise<void>;
}
