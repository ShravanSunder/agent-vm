import {
	evaluateGatewayAggregateAdmission,
	type GatewayAdmissionContainmentReason,
	type GatewayAdmissionEvaluationPhase,
	type GatewayIngressRouteIdentity,
	type GatewayReadinessPlaneName,
	type GatewayReadinessVector,
} from './gateway-aggregate-admission-state.js';
import type {
	CreateGatewayAtomicAdmissionControllerOptions,
	GatewayAtomicAdmissionCandidate,
	GatewayAtomicAdmissionController,
	GatewayAtomicAdmissionFailureStage,
	GatewayAtomicAdmissionSnapshot,
	GatewayAtomicObservationResult,
	GatewayAtomicRecoveryTrigger,
	GatewayAtomicReplacementReceipt,
	GatewayAtomicStartupContainmentReceipt,
	GatewayPredecessorQuiescenceReceipt,
} from './gateway-atomic-admission-contract.js';
import { assertFreshGatewaySuccessor } from './gateway-successor-identity-policy.js';

interface ActiveGatewayAtomicAdmissionState {
	readonly candidate: GatewayAtomicAdmissionCandidate;
	readonly kind: 'admitted' | 'joining' | 'publishing-ingress';
}

interface ReconnectingGatewayAtomicAdmissionState {
	readonly candidate: GatewayAtomicAdmissionCandidate;
	readonly kind: 'reconnecting';
	readonly lostPlanes: readonly GatewayReadinessPlaneName[];
}

type InternalGatewayAtomicAdmissionState =
	| { readonly kind: 'idle' }
	| ActiveGatewayAtomicAdmissionState
	| ReconnectingGatewayAtomicAdmissionState
	| {
			readonly kind: 'replacing';
			readonly predecessor: GatewayAtomicAdmissionCandidate;
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
			readonly successor?: GatewayAtomicAdmissionCandidate;
	  }
	| {
			readonly error: unknown;
			readonly kind: 'owner-unsafe';
			readonly stage: GatewayAtomicAdmissionFailureStage;
			readonly unsafeCandidate: GatewayAtomicAdmissionCandidate;
	  };

function freezeRoutes(
	routes: readonly GatewayIngressRouteIdentity[],
): readonly GatewayIngressRouteIdentity[] {
	return Object.freeze(routes.map((route) => Object.freeze({ ...route })));
}

async function applyIngressRoutes(props: {
	readonly candidate: GatewayAtomicAdmissionCandidate;
	readonly routes: readonly GatewayIngressRouteIdentity[];
}): Promise<readonly GatewayIngressRouteIdentity[]> {
	const expectedRoutes = freezeRoutes(props.routes);
	await props.candidate.replaceIngressRoutes(expectedRoutes);
	return expectedRoutes;
}

function activeCandidate(
	state: InternalGatewayAtomicAdmissionState,
): GatewayAtomicAdmissionCandidate {
	switch (state.kind) {
		case 'admitted':
		case 'joining':
		case 'publishing-ingress':
		case 'reconnecting':
			return state.candidate;
		case 'idle':
		case 'owner-unsafe':
		case 'replacement-failed':
		case 'replacing':
		case 'startup-failed':
			throw new Error(
				`Gateway atomic admission has no observable active candidate in '${state.kind}'.`,
			);
	}
}

function evaluationPhase(
	state: ActiveGatewayAtomicAdmissionState | ReconnectingGatewayAtomicAdmissionState,
): GatewayAdmissionEvaluationPhase {
	switch (state.kind) {
		case 'admitted':
			return 'admitted';
		case 'publishing-ingress':
			return 'publishing-ingress';
		case 'joining':
		case 'reconnecting':
			return 'joining';
	}
}

function containmentReason(reasons: readonly GatewayAdmissionContainmentReason[]): string {
	return reasons.length === 0 ? 'aggregate-containment' : reasons.join(',');
}

export function createGatewayAtomicAdmissionController(
	options: CreateGatewayAtomicAdmissionControllerOptions,
): GatewayAtomicAdmissionController {
	let state: InternalGatewayAtomicAdmissionState = { kind: 'idle' };
	let transitionInProgress = false;

	const runAtomicTransition = async <TResult>(
		transition: () => Promise<TResult>,
	): Promise<TResult> => {
		if (transitionInProgress) {
			throw new Error('Gateway atomic admission transition is already in progress.');
		}
		transitionInProgress = true;
		try {
			return await transition();
		} finally {
			transitionInProgress = false;
		}
	};

	const enterOwnerUnsafe = (props: {
		readonly error: unknown;
		readonly stage: GatewayAtomicAdmissionFailureStage;
		readonly unsafeCandidate: GatewayAtomicAdmissionCandidate;
	}): never => {
		state = {
			error: props.error,
			kind: 'owner-unsafe',
			stage: props.stage,
			unsafeCandidate: props.unsafeCandidate,
		};
		throw props.error;
	};

	const containAfterFailure = async (props: {
		readonly candidate: GatewayAtomicAdmissionCandidate;
		readonly failure: unknown;
		readonly unsafeStage: GatewayAtomicAdmissionFailureStage;
	}): Promise<void> => {
		try {
			await props.candidate.containGatewayVm();
		} catch (containmentError: unknown) {
			enterOwnerUnsafe({
				error: new AggregateError(
					[props.failure, containmentError],
					'Gateway failure and subsequent containment both failed.',
				),
				stage: props.unsafeStage,
				unsafeCandidate: props.candidate,
			});
		}
	};

	const recordStartupFailure = (
		candidate: GatewayAtomicAdmissionCandidate,
		reason: string,
	): GatewayAtomicStartupContainmentReceipt => {
		const receipt = Object.freeze({
			kind: 'startup-contained' as const,
			predecessor: candidate.expectedCohort,
			reason,
		});
		state = { kind: 'startup-failed', receipt };
		return receipt;
	};

	const recordReplacementFailure = (props: {
		readonly error: unknown;
		readonly predecessorQuiescence: GatewayPredecessorQuiescenceReceipt;
		readonly stage: GatewayAtomicAdmissionFailureStage;
		readonly successor?: GatewayAtomicAdmissionCandidate;
	}): void => {
		state = {
			error: props.error,
			kind: 'replacement-failed',
			predecessorQuiescence: props.predecessorQuiescence,
			stage: props.stage,
			...(props.successor === undefined ? {} : { successor: props.successor }),
		};
	};

	const startCandidate = async (props: {
		readonly candidate: GatewayAtomicAdmissionCandidate;
		readonly predecessorQuiescence?: GatewayPredecessorQuiescenceReceipt;
	}): Promise<void> => {
		const isSuccessor = props.predecessorQuiescence !== undefined;
		try {
			await props.candidate.startGatewayVm();
		} catch (error: unknown) {
			await containAfterFailure({
				candidate: props.candidate,
				failure: error,
				unsafeStage: isSuccessor ? 'successor-containment' : 'startup-containment',
			});
			if (props.predecessorQuiescence === undefined) {
				recordStartupFailure(props.candidate, 'gateway-vm-start-failed');
			} else {
				recordReplacementFailure({
					error,
					predecessorQuiescence: props.predecessorQuiescence,
					stage: 'successor-start',
					successor: props.candidate,
				});
			}
			throw error;
		}
		try {
			await applyIngressRoutes({
				candidate: props.candidate,
				routes: [props.candidate.expectedCohort.ingressIntent.controlRoute],
			});
		} catch (error: unknown) {
			await containAfterFailure({
				candidate: props.candidate,
				failure: error,
				unsafeStage: isSuccessor ? 'successor-containment' : 'startup-containment',
			});
			if (props.predecessorQuiescence === undefined) {
				recordStartupFailure(props.candidate, 'initial-control-ingress-failed');
			} else {
				recordReplacementFailure({
					error,
					predecessorQuiescence: props.predecessorQuiescence,
					stage: 'successor-control-ingress',
					successor: props.candidate,
				});
			}
			throw error;
		}
		state = { candidate: props.candidate, kind: 'joining' };
	};

	const containStartup = async (
		candidate: GatewayAtomicAdmissionCandidate,
		reason: string,
	): Promise<GatewayAtomicStartupContainmentReceipt> => {
		try {
			await applyIngressRoutes({ candidate, routes: [] });
		} catch (error: unknown) {
			await containAfterFailure({
				candidate,
				failure: error,
				unsafeStage: 'startup-containment',
			});
			enterOwnerUnsafe({
				error,
				stage: 'startup-ingress-withdrawal',
				unsafeCandidate: candidate,
			});
		}
		try {
			await candidate.containGatewayVm();
		} catch (error: unknown) {
			enterOwnerUnsafe({ error, stage: 'startup-containment', unsafeCandidate: candidate });
		}
		return recordStartupFailure(candidate, reason);
	};

	const replaceCandidate = async (props: {
		readonly predecessor: GatewayAtomicAdmissionCandidate;
		readonly trigger: GatewayAtomicRecoveryTrigger;
	}): Promise<GatewayAtomicReplacementReceipt> => {
		state = {
			kind: 'replacing',
			predecessor: props.predecessor,
			trigger: props.trigger,
		};
		try {
			await applyIngressRoutes({ candidate: props.predecessor, routes: [] });
		} catch (error: unknown) {
			await containAfterFailure({
				candidate: props.predecessor,
				failure: error,
				unsafeStage: 'predecessor-containment',
			});
			enterOwnerUnsafe({
				error,
				stage: 'replacement-ingress-withdrawal',
				unsafeCandidate: props.predecessor,
			});
		}
		try {
			await props.predecessor.containGatewayVm();
		} catch (error: unknown) {
			enterOwnerUnsafe({
				error,
				stage: 'predecessor-containment',
				unsafeCandidate: props.predecessor,
			});
		}
		const predecessorQuiescence = Object.freeze({
			kind: 'predecessor-quiescence-proven' as const,
			predecessor: props.predecessor.expectedCohort,
		});
		let successorCandidate: GatewayAtomicAdmissionCandidate;
		try {
			successorCandidate = await options.createSuccessorCandidate({
				predecessorQuiescence,
				trigger: props.trigger,
			});
		} catch (error: unknown) {
			recordReplacementFailure({
				error,
				predecessorQuiescence,
				stage: 'successor-creation',
			});
			throw error;
		}
		try {
			assertFreshGatewaySuccessor({
				predecessor: props.predecessor.expectedCohort,
				successor: successorCandidate.expectedCohort,
			});
		} catch (error: unknown) {
			await containAfterFailure({
				candidate: successorCandidate,
				failure: error,
				unsafeStage: 'successor-containment',
			});
			recordReplacementFailure({
				error,
				predecessorQuiescence,
				stage: 'successor-identity',
				successor: successorCandidate,
			});
			throw error;
		}
		await startCandidate({ candidate: successorCandidate, predecessorQuiescence });
		return Object.freeze({
			kind: 'replaced' as const,
			predecessorQuiescence,
			successor: successorCandidate.expectedCohort,
			trigger: props.trigger,
		});
	};

	const stateTransitionOperations: GatewayAtomicAdmissionController = {
		async expireRecovery(trigger): Promise<GatewayAtomicReplacementReceipt> {
			if (state.kind !== 'reconnecting') {
				throw new Error(
					`Gateway recovery expiry requires reconnecting state, received '${state.kind}'.`,
				);
			}
			return await replaceCandidate({ predecessor: state.candidate, trigger });
		},
		async expireStartupJoin(reason): Promise<GatewayAtomicStartupContainmentReceipt> {
			if (state.kind !== 'joining' && state.kind !== 'publishing-ingress') {
				throw new Error(`Gateway startup expiry requires joining state, received '${state.kind}'.`);
			}
			return await containStartup(state.candidate, reason);
		},
		getSnapshot(): GatewayAtomicAdmissionSnapshot {
			switch (state.kind) {
				case 'idle':
					return Object.freeze({ kind: 'idle' });
				case 'admitted':
				case 'joining':
				case 'publishing-ingress':
					return Object.freeze({ cohort: state.candidate.expectedCohort, kind: state.kind });
				case 'reconnecting':
					return Object.freeze({
						cohort: state.candidate.expectedCohort,
						kind: 'reconnecting',
						lostPlanes: state.lostPlanes,
					});
				case 'replacing':
					return Object.freeze({
						kind: 'replacing',
						predecessor: state.predecessor.expectedCohort,
						trigger: state.trigger,
					});
				case 'startup-failed':
					return Object.freeze({ kind: 'startup-failed', receipt: state.receipt });
				case 'replacement-failed':
					return Object.freeze({
						error: state.error,
						kind: 'replacement-failed',
						predecessorQuiescence: state.predecessorQuiescence,
						stage: state.stage,
						...(state.successor === undefined ? {} : { successor: state.successor.expectedCohort }),
					});
				case 'owner-unsafe':
					return Object.freeze({
						error: state.error,
						kind: 'owner-unsafe',
						stage: state.stage,
						unsafeCohort: state.unsafeCandidate.expectedCohort,
					});
			}
		},
		async observe(vector): Promise<GatewayAtomicObservationResult> {
			if (
				state.kind !== 'admitted' &&
				state.kind !== 'joining' &&
				state.kind !== 'publishing-ingress' &&
				state.kind !== 'reconnecting'
			) {
				throw new Error(`Gateway readiness cannot be observed in '${state.kind}' state.`);
			}
			const candidate = activeCandidate(state);
			const decision = evaluateGatewayAggregateAdmission({
				expectedCohort: candidate.expectedCohort,
				phase: evaluationPhase(state),
				vector,
			});
			switch (decision.kind) {
				case 'waiting':
					return decision;
				case 'publish-ingress': {
					let routes: readonly GatewayIngressRouteIdentity[];
					try {
						routes = await applyIngressRoutes({
							candidate,
							routes: decision.routes,
						});
					} catch (error: unknown) {
						await containAfterFailure({
							candidate,
							failure: error,
							unsafeStage: 'startup-containment',
						});
						recordStartupFailure(candidate, 'public-ingress-publication-failed');
						throw error;
					}
					state = { candidate, kind: 'publishing-ingress' };
					return Object.freeze({ kind: 'publishing-ingress', routes });
				}
				case 'admitted':
					state = { candidate, kind: 'admitted' };
					return decision;
				case 'withdraw-ingress': {
					if (decision.lostPlanes.includes('vm-liveness')) {
						return await replaceCandidate({
							predecessor: candidate,
							trigger: 'gateway-vm-death',
						});
					}
					try {
						await applyIngressRoutes({
							candidate,
							routes: decision.retainRoutes,
						});
					} catch (error: unknown) {
						await containAfterFailure({
							candidate,
							failure: error,
							unsafeStage: 'predecessor-containment',
						});
						enterOwnerUnsafe({
							error,
							stage: 'admitted-ingress-withdrawal',
							unsafeCandidate: candidate,
						});
					}
					const lostPlanes = Object.freeze([...decision.lostPlanes]);
					state = { candidate, kind: 'reconnecting', lostPlanes };
					return Object.freeze({ kind: 'reconnecting', lostPlanes });
				}
				case 'contain':
					if (state.kind === 'joining' || state.kind === 'publishing-ingress') {
						return await containStartup(candidate, containmentReason(decision.reasons));
					}
					return await replaceCandidate({
						predecessor: candidate,
						trigger: 'aggregate-containment',
					});
			}
		},
		async replaceRecordedPredecessor(
			predecessor,
			trigger,
		): Promise<GatewayAtomicReplacementReceipt> {
			if (state.kind !== 'idle') {
				throw new Error(
					`Recorded predecessor replacement requires idle state, received '${state.kind}'.`,
				);
			}
			return await replaceCandidate({ predecessor, trigger });
		},
		async start(candidate): Promise<void> {
			if (state.kind !== 'idle') {
				throw new Error(
					`Gateway atomic admission start requires idle state, received '${state.kind}'.`,
				);
			}
			await startCandidate({ candidate });
		},
	};

	return Object.freeze({
		expireRecovery(
			trigger: Exclude<
				GatewayAtomicRecoveryTrigger,
				'aggregate-containment' | 'controller-restart'
			>,
		): Promise<GatewayAtomicReplacementReceipt> {
			return runAtomicTransition(
				async () => await stateTransitionOperations.expireRecovery(trigger),
			);
		},
		expireStartupJoin(reason: string): Promise<GatewayAtomicStartupContainmentReceipt> {
			return runAtomicTransition(
				async () => await stateTransitionOperations.expireStartupJoin(reason),
			);
		},
		getSnapshot(): GatewayAtomicAdmissionSnapshot {
			return stateTransitionOperations.getSnapshot();
		},
		observe(vector: GatewayReadinessVector): Promise<GatewayAtomicObservationResult> {
			return runAtomicTransition(async () => await stateTransitionOperations.observe(vector));
		},
		replaceRecordedPredecessor(
			predecessor: GatewayAtomicAdmissionCandidate,
			trigger: 'controller-restart',
		): Promise<GatewayAtomicReplacementReceipt> {
			return runAtomicTransition(
				async () =>
					await stateTransitionOperations.replaceRecordedPredecessor(predecessor, trigger),
			);
		},
		start(candidate: GatewayAtomicAdmissionCandidate): Promise<void> {
			return runAtomicTransition(async () => await stateTransitionOperations.start(candidate));
		},
	});
}
