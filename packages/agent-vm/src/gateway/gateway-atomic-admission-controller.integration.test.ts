import { describe, expect, it, vi } from 'vitest';

import type {
	GatewayExpectedAdmissionCohort,
	GatewayIngressRouteIdentity,
	GatewayReadinessVector,
} from './gateway-aggregate-admission-state.js';
import type {
	GatewayAtomicAdmissionCandidate,
	GatewayAtomicAdmissionController,
} from './gateway-atomic-admission-contract.js';
import { createGatewayAtomicAdmissionController } from './gateway-atomic-admission-controller.js';

const initialCohort = createExpectedCohort({
	controllerEpoch: 'controller-1',
	gatewayEpoch: 'gateway-1',
	vmId: 'gateway-vm-1',
});
const successorCohort = createExpectedCohort({
	controllerEpoch: 'controller-1',
	gatewayEpoch: 'gateway-2',
	vmId: 'gateway-vm-2',
});
const restartedControllerSuccessorCohort = createExpectedCohort({
	controllerEpoch: 'controller-2',
	gatewayEpoch: 'gateway-3',
	vmId: 'gateway-vm-3',
});

interface CandidateHarness {
	readonly candidate: GatewayAtomicAdmissionCandidate;
	readonly containGatewayVm: ReturnType<typeof vi.fn<() => Promise<void>>>;
	readonly replaceIngressRoutes: ReturnType<
		typeof vi.fn<(routes: readonly GatewayIngressRouteIdentity[]) => Promise<void>>
	>;
	readonly startGatewayVm: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createExpectedCohort(props: {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly vmId: string;
}): GatewayExpectedAdmissionCohort {
	const identitySuffix = `${props.gatewayEpoch}-${props.vmId}`;
	return {
		controlIdentity: {
			controllerEpoch: props.controllerEpoch,
			generationId: `control-generation-${identitySuffix}`,
			peerId: 'tool-portal-control',
			processEpoch: `tool-portal-process-${identitySuffix}`,
		},
		fence: {
			controllerEpoch: props.controllerEpoch,
			gatewayEpoch: props.gatewayEpoch,
			vmId: props.vmId,
			zoneId: 'zone-a',
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: `framework-${identitySuffix}`,
			frameworkKind: 'hermes',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 19_001,
				kind: 'tool-portal-control',
				prefix: '/_agent-vm/control',
				stripPrefix: true,
			},
			frameworkRootRoute: {
				guestPort: 18_789,
				kind: 'framework-root',
				prefix: '/',
				stripPrefix: true,
			},
		},
		providerRevision: 'provider-1',
		requiredBackendRevision: 'required-backends-1',
		semanticRevision: 'semantic-1',
		toolPortalIdentity: {
			processEpoch: `tool-portal-process-${identitySuffix}`,
			role: 'tool-portal',
			runtimeEpoch: `runtime-${identitySuffix}`,
			serviceId: `tool-portal-${identitySuffix}`,
		},
		udsIdentity: {
			frameworkEpoch: `framework-${identitySuffix}`,
			gatewayEpoch: props.gatewayEpoch,
			runtimeEpoch: `runtime-${identitySuffix}`,
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

function ready<TIdentity>(identity: TIdentity): {
	readonly identity: TIdentity;
	readonly kind: 'ready';
} {
	return { identity, kind: 'ready' };
}

function createReadyVector(
	cohort: GatewayExpectedAdmissionCohort,
	overrides: Partial<GatewayReadinessVector> = {},
): GatewayReadinessVector {
	return {
		authorityBearingControl: ready(cohort.controlIdentity),
		fatalEvidence: { kind: 'none' },
		frameworkIdentity: ready(cohort.frameworkIdentity),
		frameworkNativeReadiness: ready(cohort.frameworkIdentity),
		ingressRoutes: [cohort.ingressIntent.controlRoute],
		providerRevision: ready(cohort.providerRevision),
		requiredBackends: ready(cohort.requiredBackendRevision),
		semanticRevision: ready(cohort.semanticRevision),
		toolPortalIdentity: ready(cohort.toolPortalIdentity),
		toolPortalReadiness: ready(cohort.toolPortalIdentity),
		udsAttachment: ready({ ...cohort.frameworkIdentity, ...cohort.udsIdentity }),
		udsPublication: ready(cohort.udsIdentity),
		vmLiveness: ready(cohort.fence),
		...overrides,
	};
}

function createCandidateHarness(
	cohort: GatewayExpectedAdmissionCohort,
	events: string[],
): CandidateHarness {
	const startGatewayVm = vi.fn(async (): Promise<void> => {
		events.push(`start:${cohort.fence.vmId}`);
	});
	const replaceIngressRoutes = vi.fn(
		async (routes: readonly GatewayIngressRouteIdentity[]): Promise<void> => {
			events.push(
				`routes:${cohort.fence.vmId}:${routes.map((route) => route.kind).join(',') || 'none'}`,
			);
		},
	);
	const containGatewayVm = vi.fn(async (): Promise<void> => {
		events.push(`contain:${cohort.fence.vmId}`);
	});
	return {
		candidate: {
			containGatewayVm,
			expectedCohort: cohort,
			replaceIngressRoutes,
			startGatewayVm,
		},
		containGatewayVm,
		replaceIngressRoutes,
		startGatewayVm,
	};
}

function createController(options: {
	readonly events: string[];
	readonly successor: CandidateHarness;
}): GatewayAtomicAdmissionController {
	return createGatewayAtomicAdmissionController({
		createSuccessorCandidate: vi.fn(async ({ predecessorQuiescence }) => {
			options.events.push(`create-successor:${predecessorQuiescence.predecessor.fence.vmId}`);
			return options.successor.candidate;
		}),
	});
}

async function admitInitialCandidate(options: {
	readonly controller: GatewayAtomicAdmissionController;
	readonly initial: CandidateHarness;
}): Promise<void> {
	await options.controller.start(options.initial.candidate);
	await options.controller.observe(createReadyVector(initialCohort));
	await options.controller.observe(
		createReadyVector(initialCohort, {
			ingressRoutes: [
				initialCohort.ingressIntent.controlRoute,
				initialCohort.ingressIntent.frameworkRootRoute,
			],
		}),
	);
	expect(options.controller.getSnapshot().kind).toBe('admitted');
}

describe('Gateway atomic admission controller', () => {
	it.each([
		[
			'Tool Portal only',
			{
				frameworkIdentity: { kind: 'pending' } as const,
				frameworkNativeReadiness: { kind: 'pending' } as const,
				udsAttachment: { kind: 'pending' } as const,
			},
		],
		[
			'framework only',
			{
				authorityBearingControl: { kind: 'pending' } as const,
				providerRevision: { kind: 'pending' } as const,
				requiredBackends: { kind: 'pending' } as const,
				semanticRevision: { kind: 'pending' } as const,
				toolPortalIdentity: { kind: 'pending' } as const,
				toolPortalReadiness: { kind: 'pending' } as const,
				udsAttachment: { kind: 'pending' } as const,
				udsPublication: { kind: 'pending' } as const,
			},
		],
	] as const)(
		'contains a stable partial start without creating a successor: %s',
		async (_name, overrides) => {
			const events: string[] = [];
			const initial = createCandidateHarness(initialCohort, events);
			const successor = createCandidateHarness(successorCohort, events);
			const controller = createController({ events, successor });

			await controller.start(initial.candidate);
			await controller.observe(createReadyVector(initialCohort, overrides));
			const receipt = await controller.expireStartupJoin('startup-readiness-deadline');

			expect(receipt).toMatchObject({
				kind: 'startup-contained',
				predecessor: { fence: { gatewayEpoch: 'gateway-1', vmId: 'gateway-vm-1' } },
			});
			expect(events).toEqual([
				'start:gateway-vm-1',
				'routes:gateway-vm-1:tool-portal-control',
				'routes:gateway-vm-1:none',
				'contain:gateway-vm-1',
			]);
			expect(successor.startGatewayVm).not.toHaveBeenCalled();
			expect(controller.getSnapshot().kind).toBe('startup-failed');
		},
	);

	it('contains a possibly partial VM when start rejects', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		initial.startGatewayVm.mockImplementationOnce(async (): Promise<void> => {
			events.push('start:gateway-vm-1');
			throw new Error('VM start returned after a partial boot');
		});
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });

		await expect(controller.start(initial.candidate)).rejects.toThrow(
			'VM start returned after a partial boot',
		);

		expect(events).toEqual(['start:gateway-vm-1', 'contain:gateway-vm-1']);
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'startup-failed',
			receipt: { reason: 'gateway-vm-start-failed' },
		});
		expect(successor.startGatewayVm).not.toHaveBeenCalled();
	});

	it('contains a started VM when initial control-route application rejects', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		initial.replaceIngressRoutes.mockImplementationOnce(async (routes): Promise<void> => {
			events.push(
				`routes:${initialCohort.fence.vmId}:${routes.map((route) => route.kind).join(',')}`,
			);
			throw new Error('control route application failed');
		});
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });

		await expect(controller.start(initial.candidate)).rejects.toThrow(
			'control route application failed',
		);

		expect(events).toEqual([
			'start:gateway-vm-1',
			'routes:gateway-vm-1:tool-portal-control',
			'contain:gateway-vm-1',
		]);
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'startup-failed',
			receipt: { reason: 'initial-control-ingress-failed' },
		});
	});

	it('rejects a concurrent observation while an atomic transition is in progress', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await controller.start(initial.candidate);
		const publicationStarted = Promise.withResolvers<void>();
		const releasePublication = Promise.withResolvers<void>();
		initial.replaceIngressRoutes.mockImplementationOnce(async (routes): Promise<void> => {
			events.push(
				`routes:${initialCohort.fence.vmId}:${routes.map((route) => route.kind).join(',')}`,
			);
			publicationStarted.resolve();
			await releasePublication.promise;
		});

		const firstObservation = controller.observe(createReadyVector(initialCohort));
		await publicationStarted.promise;
		const concurrentObservation = controller.observe(createReadyVector(initialCohort));
		releasePublication.resolve();

		await expect(firstObservation).resolves.toMatchObject({ kind: 'publishing-ingress' });
		await expect(concurrentObservation).rejects.toThrow(
			'Gateway atomic admission transition is already in progress.',
		);
		expect(initial.replaceIngressRoutes).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot().kind).toBe('publishing-ingress');
	});

	it.each(['tool-portal-service', 'framework-service'] as const)(
		'replaces the whole VM after current-epoch %s fatal evidence',
		async (role) => {
			const events: string[] = [];
			const initial = createCandidateHarness(initialCohort, events);
			const successor = createCandidateHarness(successorCohort, events);
			const controller = createController({ events, successor });
			await admitInitialCandidate({ controller, initial });

			const result = await controller.observe(
				createReadyVector(initialCohort, {
					fatalEvidence: {
						kind: 'observed',
						observedGatewayEpoch: initialCohort.fence.gatewayEpoch,
						role,
					},
					ingressRoutes: [
						initialCohort.ingressIntent.controlRoute,
						initialCohort.ingressIntent.frameworkRootRoute,
					],
				}),
			);

			expect(result).toEqual({
				kind: 'replaced',
				predecessorQuiescence: {
					kind: 'predecessor-quiescence-proven',
					predecessor: initialCohort,
				},
				successor: successorCohort,
				trigger: 'aggregate-containment',
			});
			expect(events.slice(-5)).toEqual([
				'routes:gateway-vm-1:none',
				'contain:gateway-vm-1',
				'create-successor:gateway-vm-1',
				'start:gateway-vm-2',
				'routes:gateway-vm-2:tool-portal-control',
			]);
			expect(controller.getSnapshot()).toMatchObject({
				cohort: { fence: { vmId: 'gateway-vm-2' } },
				kind: 'joining',
			});
		},
	);

	it('ignores stale fatal evidence after admitting the current cohort', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await admitInitialCandidate({ controller, initial });
		const eventsBeforeStaleEvidence = [...events];

		const result = await controller.observe(
			createReadyVector(initialCohort, {
				fatalEvidence: {
					kind: 'observed',
					observedGatewayEpoch: 'gateway-stale',
					role: 'tool-portal-service',
				},
				ingressRoutes: [
					initialCohort.ingressIntent.controlRoute,
					initialCohort.ingressIntent.frameworkRootRoute,
				],
			}),
		);

		expect(result).toEqual({
			kind: 'admitted',
			routes: [
				initialCohort.ingressIntent.controlRoute,
				initialCohort.ingressIntent.frameworkRootRoute,
			],
		});
		expect(events).toEqual(eventsBeforeStaleEvidence);
		expect(successor.startGatewayVm).not.toHaveBeenCalled();
		expect(controller.getSnapshot()).toMatchObject({
			cohort: { fence: { gatewayEpoch: 'gateway-1', vmId: 'gateway-vm-1' } },
			kind: 'admitted',
		});
	});

	it('withdraws public ingress on control loss, then replaces after bounded recovery expires', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await admitInitialCandidate({ controller, initial });

		const loss = await controller.observe(
			createReadyVector(initialCohort, {
				authorityBearingControl: {
					identity: initialCohort.controlIdentity,
					kind: 'lost',
				},
				ingressRoutes: [
					initialCohort.ingressIntent.controlRoute,
					initialCohort.ingressIntent.frameworkRootRoute,
				],
			}),
		);

		expect(loss).toMatchObject({ kind: 'reconnecting', lostPlanes: ['authority-bearing-control'] });
		expect(controller.getSnapshot().kind).toBe('reconnecting');
		expect(events.at(-1)).toBe('routes:gateway-vm-1:tool-portal-control');

		const replacement = await controller.expireRecovery('control-recovery-exhausted');

		expect(replacement.kind).toBe('replaced');
		expect(events.slice(-5)).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'start:gateway-vm-2',
			'routes:gateway-vm-2:tool-portal-control',
		]);
	});

	it('immediately replaces the whole Gateway when the admitted VM dies', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await admitInitialCandidate({ controller, initial });

		const replacement = await controller.observe(
			createReadyVector(initialCohort, {
				ingressRoutes: [
					initialCohort.ingressIntent.controlRoute,
					initialCohort.ingressIntent.frameworkRootRoute,
				],
				vmLiveness: {
					identity: initialCohort.fence,
					kind: 'lost',
				},
			}),
		);

		expect(replacement).toMatchObject({
			kind: 'replaced',
			trigger: 'gateway-vm-death',
		});
		expect(events.slice(-5)).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'start:gateway-vm-2',
			'routes:gateway-vm-2:tool-portal-control',
		]);
		expect(controller.getSnapshot()).toMatchObject({
			cohort: { fence: { vmId: 'gateway-vm-2' } },
			kind: 'joining',
		});
	});

	it('restores full ingress when a bounded recovery rejoins the current cohort', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await admitInitialCandidate({ controller, initial });
		await controller.observe(
			createReadyVector(initialCohort, {
				authorityBearingControl: {
					identity: initialCohort.controlIdentity,
					kind: 'lost',
				},
				ingressRoutes: [
					initialCohort.ingressIntent.controlRoute,
					initialCohort.ingressIntent.frameworkRootRoute,
				],
			}),
		);

		await expect(controller.observe(createReadyVector(initialCohort))).resolves.toMatchObject({
			kind: 'publishing-ingress',
		});
		await expect(
			controller.observe(
				createReadyVector(initialCohort, {
					ingressRoutes: [
						initialCohort.ingressIntent.controlRoute,
						initialCohort.ingressIntent.frameworkRootRoute,
					],
				}),
			),
		).resolves.toMatchObject({ kind: 'admitted' });

		expect(events.slice(-2)).toEqual([
			'routes:gateway-vm-1:tool-portal-control',
			'routes:gateway-vm-1:tool-portal-control,framework-root',
		]);
		expect(successor.startGatewayVm).not.toHaveBeenCalled();
		expect(controller.getSnapshot().kind).toBe('admitted');
	});

	it('enters owner-unsafe and creates no successor when ingress withdrawal is unproven', async () => {
		const events: string[] = [];
		const initial = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });
		await admitInitialCandidate({ controller, initial });
		initial.replaceIngressRoutes.mockImplementationOnce(async (routes): Promise<void> => {
			events.push(
				`routes:${initialCohort.fence.vmId}:${routes.map((route) => route.kind).join(',')}`,
			);
			throw new Error('public ingress withdrawal failed');
		});

		await expect(
			controller.observe(
				createReadyVector(initialCohort, {
					authorityBearingControl: {
						identity: initialCohort.controlIdentity,
						kind: 'lost',
					},
					ingressRoutes: [
						initialCohort.ingressIntent.controlRoute,
						initialCohort.ingressIntent.frameworkRootRoute,
					],
				}),
			),
		).rejects.toThrow('public ingress withdrawal failed');

		expect(initial.containGatewayVm).toHaveBeenCalledOnce();
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'owner-unsafe',
			unsafeCohort: { fence: { vmId: 'gateway-vm-1' } },
		});
		expect(successor.startGatewayVm).not.toHaveBeenCalled();
	});

	it('does not create a successor before predecessor quiescence is positively proven', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const containment = Promise.withResolvers<void>();
		predecessor.containGatewayVm.mockImplementationOnce(async (): Promise<void> => {
			events.push('contain:gateway-vm-1');
			await containment.promise;
		});
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });

		const replacementPromise = controller.replaceRecordedPredecessor(
			predecessor.candidate,
			'controller-restart',
		);
		await vi.waitFor(() => expect(predecessor.containGatewayVm).toHaveBeenCalledOnce());

		expect(successor.startGatewayVm).not.toHaveBeenCalled();
		expect(events).toEqual(['routes:gateway-vm-1:none', 'contain:gateway-vm-1']);
		containment.resolve();
		await replacementPromise;
		expect(successor.startGatewayVm).toHaveBeenCalledOnce();
	});

	it('records a safe replacement failure when successor creation rejects after quiescence', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const controller = createGatewayAtomicAdmissionController({
			createSuccessorCandidate: vi.fn(async (): Promise<GatewayAtomicAdmissionCandidate> => {
				events.push('create-successor:gateway-vm-1');
				throw new Error('successor image preparation failed');
			}),
		});

		await expect(
			controller.replaceRecordedPredecessor(predecessor.candidate, 'controller-restart'),
		).rejects.toThrow('successor image preparation failed');

		expect(events).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
		]);
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'replacement-failed',
			predecessorQuiescence: {
				predecessor: { fence: { vmId: 'gateway-vm-1' } },
			},
			stage: 'successor-creation',
		});
	});

	it('contains a partially started successor and records a safe replacement failure', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		successor.startGatewayVm.mockImplementationOnce(async (): Promise<void> => {
			events.push('start:gateway-vm-2');
			throw new Error('successor start failed after partial boot');
		});
		const controller = createController({ events, successor });

		await expect(
			controller.replaceRecordedPredecessor(predecessor.candidate, 'controller-restart'),
		).rejects.toThrow('successor start failed after partial boot');

		expect(events).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'start:gateway-vm-2',
			'contain:gateway-vm-2',
		]);
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'replacement-failed',
			stage: 'successor-start',
			successor: { fence: { vmId: 'gateway-vm-2' } },
		});
	});

	it('contains a started successor when its control-route application rejects', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(successorCohort, events);
		successor.replaceIngressRoutes.mockImplementationOnce(async (routes): Promise<void> => {
			events.push(
				`routes:${successorCohort.fence.vmId}:${routes.map((route) => route.kind).join(',')}`,
			);
			throw new Error('successor control route application failed');
		});
		const controller = createController({ events, successor });

		await expect(
			controller.replaceRecordedPredecessor(predecessor.candidate, 'controller-restart'),
		).rejects.toThrow('successor control route application failed');

		expect(events).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'start:gateway-vm-2',
			'routes:gateway-vm-2:tool-portal-control',
			'contain:gateway-vm-2',
		]);
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'replacement-failed',
			stage: 'successor-control-ingress',
			successor: { fence: { vmId: 'gateway-vm-2' } },
		});
	});

	it('rejects and contains a successor that reuses predecessor identity', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const reusedSuccessor = createCandidateHarness(initialCohort, events);
		const controller = createController({ events, successor: reusedSuccessor });

		await expect(
			controller.replaceRecordedPredecessor(predecessor.candidate, 'controller-restart'),
		).rejects.toThrow(/Gateway successor reused predecessor identity/u);

		expect(events).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'contain:gateway-vm-1',
		]);
		expect(reusedSuccessor.startGatewayVm).not.toHaveBeenCalled();
		expect(controller.getSnapshot()).toMatchObject({
			kind: 'replacement-failed',
			stage: 'successor-identity',
			successor: { fence: { vmId: 'gateway-vm-1' } },
		});
	});

	it('contains a durable predecessor before starting a fresh controller-restart successor', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		const successor = createCandidateHarness(restartedControllerSuccessorCohort, events);
		const controller = createController({ events, successor });

		const result = await controller.replaceRecordedPredecessor(
			predecessor.candidate,
			'controller-restart',
		);

		expect(result).toMatchObject({
			kind: 'replaced',
			predecessorQuiescence: {
				predecessor: {
					fence: {
						controllerEpoch: 'controller-1',
						gatewayEpoch: 'gateway-1',
						vmId: 'gateway-vm-1',
					},
				},
			},
			successor: {
				fence: {
					controllerEpoch: 'controller-2',
					gatewayEpoch: 'gateway-3',
					vmId: 'gateway-vm-3',
				},
			},
		});
		expect(predecessor.startGatewayVm).not.toHaveBeenCalled();
		expect(events).toEqual([
			'routes:gateway-vm-1:none',
			'contain:gateway-vm-1',
			'create-successor:gateway-vm-1',
			'start:gateway-vm-3',
			'routes:gateway-vm-3:tool-portal-control',
		]);
	});

	it('enters owner-unsafe and creates no successor when predecessor quiescence is unproven', async () => {
		const events: string[] = [];
		const predecessor = createCandidateHarness(initialCohort, events);
		predecessor.containGatewayVm.mockRejectedValueOnce(
			new Error('recorded Gateway process identity still reports live'),
		);
		const successor = createCandidateHarness(successorCohort, events);
		const controller = createController({ events, successor });

		await expect(
			controller.replaceRecordedPredecessor(predecessor.candidate, 'controller-restart'),
		).rejects.toThrow('recorded Gateway process identity still reports live');

		expect(controller.getSnapshot()).toMatchObject({
			kind: 'owner-unsafe',
			unsafeCohort: { fence: { vmId: 'gateway-vm-1' } },
		});
		expect(successor.startGatewayVm).not.toHaveBeenCalled();
		expect(events).toEqual(['routes:gateway-vm-1:none']);
	});
});
