import { describe, expect, it } from 'vitest';

import {
	evaluateGatewayAggregateAdmission,
	type GatewayAggregateAdmissionDecision,
	type GatewayAdmissionEvaluationInput,
	type GatewayExpectedAdmissionCohort,
	type GatewayReadinessVector,
} from './gateway-aggregate-admission-state.js';

const expectedCohort = {
	controlIdentity: {
		controllerEpoch: 'controller-1',
		generationId: 'control-generation-1',
		peerId: 'tool-portal-control',
		processEpoch: 'tool-portal-process-1',
	},
	fence: {
		controllerEpoch: 'controller-1',
		gatewayEpoch: 'gateway-1',
		vmId: 'gateway-vm-1',
		zoneId: 'zone-a',
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['agent-a', 'agent-b'],
		frameworkEpoch: 'framework-1',
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
		processEpoch: 'tool-portal-process-1',
		role: 'tool-portal',
		runtimeEpoch: 'runtime-1',
		serviceId: 'tool-portal-service-1',
	},
	udsIdentity: {
		frameworkEpoch: 'framework-1',
		gatewayEpoch: 'gateway-1',
		runtimeEpoch: 'runtime-1',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
} satisfies GatewayExpectedAdmissionCohort;

function ready<TIdentity>(identity: TIdentity): {
	readonly identity: TIdentity;
	readonly kind: 'ready';
} {
	return { identity, kind: 'ready' };
}

function createReadyVector(
	overrides: Partial<GatewayReadinessVector> = {},
): GatewayReadinessVector {
	return {
		authorityBearingControl: ready(expectedCohort.controlIdentity),
		fatalEvidence: { kind: 'none' },
		frameworkIdentity: ready(expectedCohort.frameworkIdentity),
		frameworkNativeReadiness: ready(expectedCohort.frameworkIdentity),
		ingressRoutes: [expectedCohort.ingressIntent.controlRoute],
		providerRevision: ready(expectedCohort.providerRevision),
		requiredBackends: ready(expectedCohort.requiredBackendRevision),
		semanticRevision: ready(expectedCohort.semanticRevision),
		toolPortalIdentity: ready(expectedCohort.toolPortalIdentity),
		toolPortalReadiness: ready(expectedCohort.toolPortalIdentity),
		udsAttachment: ready({
			...expectedCohort.frameworkIdentity,
			...expectedCohort.udsIdentity,
		}),
		udsPublication: ready(expectedCohort.udsIdentity),
		vmLiveness: ready(expectedCohort.fence),
		...overrides,
	};
}

function evaluate(
	vector: GatewayReadinessVector,
	phase: GatewayAdmissionEvaluationInput['phase'] = 'joining',
): GatewayAggregateAdmissionDecision {
	return evaluateGatewayAggregateAdmission({ expectedCohort, phase, vector });
}

describe('Gateway aggregate admission state', () => {
	it('waits for every independent internal plane before publishing ingress', () => {
		const vector = createReadyVector({
			authorityBearingControl: { kind: 'pending' },
			frameworkIdentity: { kind: 'pending' },
			frameworkNativeReadiness: { kind: 'pending' },
			providerRevision: { kind: 'pending' },
			requiredBackends: { kind: 'pending' },
			semanticRevision: { kind: 'pending' },
			udsAttachment: { kind: 'pending' },
			udsPublication: { kind: 'pending' },
		});

		expect(evaluate(vector)).toEqual({
			kind: 'waiting',
			pendingPlanes: [
				'framework-identity',
				'framework-native-readiness',
				'semantic-revision',
				'provider-revision',
				'uds-publication',
				'uds-attachment',
				'authority-bearing-control',
				'required-backends',
			],
		});
	});

	it('publishes only the exact final route inventory after the internal join', () => {
		const decision = evaluate(createReadyVector());

		expect(decision).toEqual({
			kind: 'publish-ingress',
			routes: [
				expectedCohort.ingressIntent.controlRoute,
				expectedCohort.ingressIntent.frameworkRootRoute,
			],
		});
	});

	it('admits only after exact ingress publication is positively receipted', () => {
		const vector = createReadyVector({
			ingressRoutes: [
				expectedCohort.ingressIntent.controlRoute,
				expectedCohort.ingressIntent.frameworkRootRoute,
			],
		});

		expect(evaluate(vector, 'publishing-ingress')).toEqual({
			kind: 'admitted',
			routes: vector.ingressRoutes,
		});
	});

	it('keeps a delayed accepted UDS attachment out of admission', () => {
		const pending = createReadyVector({ udsAttachment: { kind: 'pending' } });

		expect(evaluate(pending)).toEqual({
			kind: 'waiting',
			pendingPlanes: ['uds-attachment'],
		});
		expect(
			evaluate(
				createReadyVector({
					udsAttachment: ready({
						...expectedCohort.frameworkIdentity,
						...expectedCohort.udsIdentity,
					}),
				}),
			).kind,
		).toBe('publish-ingress');
	});

	it.each([
		['semantic-revision', { semanticRevision: ready('semantic-stale') }],
		['provider-revision', { providerRevision: ready('provider-stale') }],
		[
			'authority-bearing-control',
			{
				authorityBearingControl: ready({
					...expectedCohort.controlIdentity,
					generationId: 'stale-control-generation',
				}),
			},
		],
		[
			'uds-attachment',
			{
				udsAttachment: ready({
					...expectedCohort.frameworkIdentity,
					...expectedCohort.udsIdentity,
					attachmentGeneration: 2,
				}),
			},
		],
	] as const)('contains an identity mismatch on %s', (plane, overrides) => {
		expect(evaluate(createReadyVector(overrides))).toEqual({
			kind: 'contain',
			reasons: [`${plane}-mismatch`],
			withdrawIngress: false,
		});
	});

	it('ignores stale fatal evidence but contains current fatal evidence', () => {
		expect(
			evaluate(
				createReadyVector({
					fatalEvidence: {
						kind: 'observed',
						observedGatewayEpoch: 'gateway-0',
						role: 'tool-portal-service',
					},
				}),
			).kind,
		).toBe('publish-ingress');
		expect(
			evaluate(
				createReadyVector({
					fatalEvidence: {
						kind: 'observed',
						observedGatewayEpoch: expectedCohort.fence.gatewayEpoch,
						role: 'tool-portal-service',
					},
				}),
			),
		).toEqual({
			kind: 'contain',
			reasons: ['tool-portal-service-fatal'],
			withdrawIngress: false,
		});
		expect(
			evaluate(
				createReadyVector({
					fatalEvidence: {
						kind: 'observed',
						observedGatewayEpoch: expectedCohort.fence.gatewayEpoch,
						role: 'framework-service',
					},
				}),
			),
		).toEqual({
			kind: 'contain',
			reasons: ['framework-service-fatal'],
			withdrawIngress: false,
		});
	});

	it('treats configured agent ids as a canonical set across framework observations', () => {
		const reversedFrameworkIdentity = {
			...expectedCohort.frameworkIdentity,
			configuredAgentIds: [...expectedCohort.frameworkIdentity.configuredAgentIds].toReversed(),
		};

		expect(
			evaluate(
				createReadyVector({
					frameworkIdentity: ready(reversedFrameworkIdentity),
					frameworkNativeReadiness: ready(reversedFrameworkIdentity),
					udsAttachment: ready({
						...reversedFrameworkIdentity,
						...expectedCohort.udsIdentity,
					}),
				}),
			),
		).toEqual({
			kind: 'publish-ingress',
			routes: [
				expectedCohort.ingressIntent.controlRoute,
				expectedCohort.ingressIntent.frameworkRootRoute,
			],
		});
	});

	it('contains an attachment from the wrong exact projection cohort', () => {
		const wrongProjectionIdentity = {
			...expectedCohort.frameworkIdentity,
			projectionCohortDigest:
				'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		};

		expect(
			evaluate(
				createReadyVector({
					frameworkIdentity: ready(wrongProjectionIdentity),
					udsAttachment: ready({
						...wrongProjectionIdentity,
						...expectedCohort.udsIdentity,
					}),
				}),
			),
		).toEqual({
			kind: 'contain',
			reasons: ['framework-identity-mismatch', 'uds-attachment-mismatch'],
			withdrawIngress: false,
		});
	});

	it('contains a missing protected control route', () => {
		expect(
			evaluate(
				createReadyVector({
					ingressRoutes: [],
				}),
			),
		).toEqual({
			kind: 'contain',
			reasons: ['missing-control-ingress-route'],
			withdrawIngress: false,
		});
	});

	it('rejects an unexpected route outside the exact ingress inventory', () => {
		const unexpectedFrameworkRoute = {
			guestPort: 18_790,
			kind: 'framework-root' as const,
			prefix: '/unexpected',
			stripPrefix: true,
		};

		expect(
			evaluate(
				createReadyVector({
					ingressRoutes: [expectedCohort.ingressIntent.controlRoute, unexpectedFrameworkRoute],
				}),
			),
		).toEqual({
			kind: 'contain',
			reasons: ['unexpected-ingress-route'],
			withdrawIngress: true,
		});
	});

	it('withdraws public ingress immediately when an admitted required plane is lost', () => {
		const admittedRoutes = [
			expectedCohort.ingressIntent.controlRoute,
			expectedCohort.ingressIntent.frameworkRootRoute,
		];
		const decision = evaluate(
			createReadyVector({
				ingressRoutes: admittedRoutes,
				udsAttachment: {
					identity: {
						...expectedCohort.frameworkIdentity,
						...expectedCohort.udsIdentity,
					},
					kind: 'lost',
				},
			}),
			'admitted',
		);

		expect(decision).toEqual({
			kind: 'withdraw-ingress',
			lostPlanes: ['uds-attachment'],
			retainRoutes: [expectedCohort.ingressIntent.controlRoute],
		});
	});

	it('withdraws public ingress when current authority-bearing control is lost', () => {
		const admittedRoutes = [
			expectedCohort.ingressIntent.controlRoute,
			expectedCohort.ingressIntent.frameworkRootRoute,
		];

		expect(
			evaluate(
				createReadyVector({
					authorityBearingControl: {
						identity: expectedCohort.controlIdentity,
						kind: 'lost',
					},
					ingressRoutes: admittedRoutes,
				}),
				'admitted',
			),
		).toEqual({
			kind: 'withdraw-ingress',
			lostPlanes: ['authority-bearing-control'],
			retainRoutes: [expectedCohort.ingressIntent.controlRoute],
		});
	});

	it('ignores a stale loss without withdrawing the current admitted cohort', () => {
		const admittedRoutes = [
			expectedCohort.ingressIntent.controlRoute,
			expectedCohort.ingressIntent.frameworkRootRoute,
		];

		const decision = evaluate(
			createReadyVector({
				ingressRoutes: admittedRoutes,
				udsAttachment: {
					identity: {
						...expectedCohort.frameworkIdentity,
						...expectedCohort.udsIdentity,
						attachmentGeneration: expectedCohort.frameworkIdentity.attachmentGeneration - 1,
					},
					kind: 'lost',
				},
			}),
			'admitted',
		);

		expect(decision).toEqual({ kind: 'admitted', routes: admittedRoutes });
	});

	it('contains premature public ingress instead of accepting a partial join', () => {
		const decision = evaluate(
			createReadyVector({
				ingressRoutes: [
					expectedCohort.ingressIntent.controlRoute,
					expectedCohort.ingressIntent.frameworkRootRoute,
				],
				udsAttachment: { kind: 'pending' },
			}),
		);

		expect(decision).toEqual({
			kind: 'contain',
			reasons: ['premature-public-ingress'],
			withdrawIngress: true,
		});
	});
});
