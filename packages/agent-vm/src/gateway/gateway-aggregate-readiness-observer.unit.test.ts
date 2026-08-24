import {
	createGatewayRuntimeReadinessSnapshot,
	type GatewayRuntimeReadinessSnapshotInput,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import {
	evaluateGatewayAggregateAdmission,
	type GatewayExpectedAdmissionCohort,
	type GatewayFatalEvidenceObservation,
	type GatewayIngressRouteIdentity,
} from './gateway-aggregate-admission-state.js';
import {
	composeGatewayReadinessVector,
	createGatewayAggregateReadinessObserver,
	type GatewayAggregateReadinessCompositionInput,
	type GatewayControlSessionReadinessEvidence,
	type GatewayFrameworkNativeReadinessEvidence,
	type GatewayVmLivenessEvidence,
} from './gateway-aggregate-readiness-observer.js';

const expectedCohort = {
	controlIdentity: {
		controllerEpoch: 'controller-1',
		generationId: 'gateway-1',
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
		configuredAgentIds: ['agent-a'],
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

function createRuntimeReadinessSnapshotInput(
	props: {
		readonly attachmentStatus?: GatewayRuntimeReadinessSnapshotInput['uds']['attachment']['status'];
	} = {},
): GatewayRuntimeReadinessSnapshotInput {
	const attachmentStatus = props.attachmentStatus ?? 'attached';
	const connectionIdentity =
		attachmentStatus === 'attached' || attachmentStatus === 'attachment-lost'
			? { connectionId: '11111111-1111-4111-8111-111111111111' }
			: {};
	return {
		controlEndpoint: {
			identity: {
				bootId: 'tool-portal-process-1',
				controllerEpoch: 'controller-1',
				generationId: 'gateway-1',
				peerId: 'tool-portal-control',
				processEpoch: 'tool-portal-process-1',
				zoneId: 'zone-a',
			},
			listener: {
				host: '127.0.0.1',
				port: 19_001,
				readyPath: '/__agent-vm/ready',
				socketPath: '/__agent-vm/gateway-control',
			},
		},
		kind: 'tool-portal-role-readiness',
		providerRevision: 'provider-1',
		requiredBackends: {
			readyBackendKinds: ['controller_execution', 'mcp_provider', 'tool_vm_runner'],
			revision: 'required-backends-1',
			status: 'ready',
		},
		semanticRevision: 'semantic-1',
		serviceIdentity: {
			processEpoch: 'tool-portal-process-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-service-1',
		},
		snapshotVersion: 1,
		uds: {
			attachment: {
				...connectionIdentity,
				expected: {
					attachmentGeneration: 1,
					clientKind: 'hermes-managed-plugin',
					configuredAgentIds: ['agent-a'],
					frameworkEpoch: 'framework-1',
					gatewayEpoch: 'gateway-1',
					protocolVersion: 1,
					projectionCohortDigest:
						'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					runtimeEpoch: 'runtime-1',
					schemaVersion: 1,
				},
				observationSequence: 1,
				snapshotVersion: 1,
				status: attachmentStatus,
			},
			publication: {
				identity: 'managed-plugin-private-uds',
				protocolVersion: 1,
				schemaVersion: 1,
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
				status: attachmentStatus === 'retired' ? 'retired' : 'published',
			},
		},
	};
}

function createReadyControlEvidence(
	identity: GatewayExpectedAdmissionCohort['controlIdentity'] = expectedCohort.controlIdentity,
): Extract<GatewayControlSessionReadinessEvidence, { readonly kind: 'current' }> {
	return {
		diagnostics: {
			accepted: true,
			attachmentGeneration: 1,
			connected: true,
			endpointPath: '/__agent-vm/gateway-control',
			helloCount: 1,
			lastHelloResponse: {
				attachmentGeneration: 1,
				connectionId: '22222222-2222-4222-8222-222222222222',
				controllerEpoch: identity.controllerEpoch,
				outcome: 'accepted',
				sessionId: '33333333-3333-4333-8333-333333333333',
			},
			ready: true,
			reconnectAttempts: 0,
			reconnectExhausted: false,
			transportName: 'websocket',
		},
		identity,
		kind: 'current',
	};
}

function createFrameworkProbeEvidence(
	overrides: Partial<GatewayFrameworkNativeReadinessEvidence> = {},
): GatewayFrameworkNativeReadinessEvidence {
	return {
		identity: expectedCohort.frameworkIdentity,
		kind: 'current',
		probe: {
			exitCode: 0,
			observation: 'http 200',
			ok: true,
			path: '/readyz',
			port: 18_789,
			statusCode: 200,
			stderr: '',
			stdout: '200',
		},
		...overrides,
	};
}

function createReadyCompositionInput(
	overrides: Partial<GatewayAggregateReadinessCompositionInput> = {},
): GatewayAggregateReadinessCompositionInput {
	return {
		appliedIngressRoutes: [expectedCohort.ingressIntent.controlRoute],
		controlSessionEvidence: createReadyControlEvidence(),
		expectedCohort,
		fatalEvidence: { kind: 'none' },
		frameworkNativeReadinessEvidence: createFrameworkProbeEvidence(),
		runtimeReadinessEvidence: {
			kind: 'current',
			snapshot: createGatewayRuntimeReadinessSnapshot(createRuntimeReadinessSnapshotInput()),
		},
		vmLivenessEvidence: { identity: expectedCohort.fence, kind: 'current' },
		...overrides,
	};
}

describe('Gateway aggregate readiness observer', () => {
	it('keeps absent evidence pending instead of fabricating ready planes', () => {
		const vector = composeGatewayReadinessVector({
			appliedIngressRoutes: [expectedCohort.ingressIntent.controlRoute],
			expectedCohort,
			fatalEvidence: { kind: 'none' },
		});

		expect(vector).toEqual({
			authorityBearingControl: { kind: 'pending' },
			fatalEvidence: { kind: 'none' },
			frameworkIdentity: { kind: 'pending' },
			frameworkNativeReadiness: { kind: 'pending' },
			ingressRoutes: [expectedCohort.ingressIntent.controlRoute],
			providerRevision: { kind: 'pending' },
			requiredBackends: { kind: 'pending' },
			semanticRevision: { kind: 'pending' },
			toolPortalIdentity: { kind: 'pending' },
			toolPortalReadiness: { kind: 'pending' },
			udsAttachment: { kind: 'pending' },
			udsPublication: { kind: 'pending' },
			vmLiveness: { kind: 'pending' },
		});
	});

	it('composes the fully ready vector from positive typed evidence', () => {
		const vector = composeGatewayReadinessVector(createReadyCompositionInput());

		expect(vector).toMatchObject({
			authorityBearingControl: { kind: 'ready' },
			frameworkIdentity: { kind: 'ready' },
			frameworkNativeReadiness: { kind: 'ready' },
			providerRevision: { identity: 'provider-1', kind: 'ready' },
			requiredBackends: { identity: 'required-backends-1', kind: 'ready' },
			semanticRevision: { identity: 'semantic-1', kind: 'ready' },
			toolPortalReadiness: { kind: 'ready' },
			udsAttachment: { kind: 'ready' },
			vmLiveness: { kind: 'ready' },
		});
		expect(evaluateGatewayAggregateAdmission({ expectedCohort, phase: 'joining', vector })).toEqual(
			{
				kind: 'publish-ingress',
				routes: [
					expectedCohort.ingressIntent.controlRoute,
					expectedCohort.ingressIntent.frameworkRootRoute,
				],
			},
		);
	});

	it.each([
		['awaiting-attachment', 'pending'],
		['attachment-lost', 'lost'],
	] as const)(
		'derives framework identity only from a %s UDS attachment',
		(status, expectedKind) => {
			const vector = composeGatewayReadinessVector(
				createReadyCompositionInput({
					runtimeReadinessEvidence: {
						kind: 'current',
						snapshot: createGatewayRuntimeReadinessSnapshot(
							createRuntimeReadinessSnapshotInput({ attachmentStatus: status }),
						),
					},
				}),
			);

			expect(vector.frameworkIdentity.kind).toBe(expectedKind);
			expect(vector.udsAttachment.kind).toBe(expectedKind);
			expect(vector.frameworkNativeReadiness.kind).toBe('ready');
			expect(vector.toolPortalReadiness.kind).toBe('ready');
		},
	);

	it('maps lost runtime evidence to lost Tool Portal and attachment planes', () => {
		const vector = composeGatewayReadinessVector(
			createReadyCompositionInput({
				runtimeReadinessEvidence: {
					kind: 'lost',
					snapshot: createGatewayRuntimeReadinessSnapshot(createRuntimeReadinessSnapshotInput()),
				},
			}),
		);

		expect(vector.toolPortalIdentity.kind).toBe('lost');
		expect(vector.toolPortalReadiness.kind).toBe('lost');
		expect(vector.udsPublication.kind).toBe('lost');
		expect(vector.udsAttachment.kind).toBe('lost');
	});

	it('preserves current fatal evidence for aggregate epoch containment', () => {
		const vector = composeGatewayReadinessVector(
			createReadyCompositionInput({
				fatalEvidence: {
					kind: 'observed',
					observedGatewayEpoch: 'gateway-1',
					role: 'tool-portal-service',
				},
			}),
		);

		expect(vector.fatalEvidence).toEqual({
			kind: 'observed',
			observedGatewayEpoch: 'gateway-1',
			role: 'tool-portal-service',
		});
		expect(Object.isFrozen(vector.fatalEvidence)).toBe(true);
	});

	it.each([
		['pending', undefined, 'pending'],
		[
			'lost',
			{
				diagnostics: createReadyControlEvidence().diagnostics,
				identity: expectedCohort.controlIdentity,
				kind: 'lost',
			} satisfies GatewayControlSessionReadinessEvidence,
			'lost',
		],
	] as const)(
		'maps %s control-session evidence without inventing authority',
		(_label, evidence, kind) => {
			const vector = composeGatewayReadinessVector(
				createReadyCompositionInput({ controlSessionEvidence: evidence }),
			);

			expect(vector.authorityBearingControl.kind).toBe(kind);
		},
	);

	it('requires accepted, connected, ready diagnostics with the accepted hello identity', () => {
		const readyEvidence = createReadyControlEvidence();
		if (readyEvidence.kind !== 'current') throw new Error('expected current control evidence');
		const vector = composeGatewayReadinessVector(
			createReadyCompositionInput({
				controlSessionEvidence: {
					...readyEvidence,
					diagnostics: { ...readyEvidence.diagnostics, connected: false },
				},
			}),
		);

		expect(vector.authorityBearingControl).toEqual({
			identity: expectedCohort.controlIdentity,
			kind: 'lost',
		});
	});

	it('maps explicit VM and failed framework-probe observations to lost planes', () => {
		const failedProbe = createFrameworkProbeEvidence();
		if (failedProbe.kind !== 'current') throw new Error('expected current framework probe');
		const vector = composeGatewayReadinessVector(
			createReadyCompositionInput({
				frameworkNativeReadinessEvidence: {
					...failedProbe,
					probe: { ...failedProbe.probe, observation: 'http 503', ok: false, statusCode: 503 },
				},
				vmLivenessEvidence: { identity: expectedCohort.fence, kind: 'lost' },
			}),
		);

		expect(vector.vmLiveness).toEqual({ identity: expectedCohort.fence, kind: 'lost' });
		expect(vector.frameworkNativeReadiness).toEqual({
			identity: expectedCohort.frameworkIdentity,
			kind: 'lost',
		});
	});

	it('copies and freezes current ingress inventory and every returned evidence snapshot', () => {
		const routes: GatewayIngressRouteIdentity[] = [expectedCohort.ingressIntent.controlRoute];
		const vector = composeGatewayReadinessVector(
			createReadyCompositionInput({ appliedIngressRoutes: routes }),
		);
		routes.push(expectedCohort.ingressIntent.frameworkRootRoute);

		expect(vector.ingressRoutes).toEqual([expectedCohort.ingressIntent.controlRoute]);
		expect(Object.isFrozen(vector)).toBe(true);
		expect(Object.isFrozen(vector.ingressRoutes)).toBe(true);
		expect(Object.isFrozen(vector.ingressRoutes[0])).toBe(true);
		expect(Object.isFrozen(vector.frameworkIdentity)).toBe(true);
		if (vector.frameworkIdentity.kind !== 'ready') throw new Error('expected framework identity');
		expect(Object.isFrozen(vector.frameworkIdentity.identity)).toBe(true);
		expect(Object.isFrozen(vector.frameworkIdentity.identity.configuredAgentIds)).toBe(true);
	});

	it.each([
		[
			'VM',
			{
				vmLivenessEvidence: {
					identity: { ...expectedCohort.fence, vmId: 'gateway-vm-other' },
					kind: 'current',
				} satisfies GatewayVmLivenessEvidence,
			},
			'vm-liveness-mismatch',
		],
		[
			'framework probe',
			{
				frameworkNativeReadinessEvidence: createFrameworkProbeEvidence({
					identity: { ...expectedCohort.frameworkIdentity, frameworkEpoch: 'framework-other' },
				}),
			},
			'framework-native-readiness-mismatch',
		],
		[
			'control session',
			{
				controlSessionEvidence: createReadyControlEvidence({
					...expectedCohort.controlIdentity,
					peerId: 'tool-portal-control-other',
				}),
			},
			'authority-bearing-control-mismatch',
		],
	] as const)(
		'preserves observed %s identity for aggregate containment',
		(_label, overrides, reason) => {
			const vector = composeGatewayReadinessVector(createReadyCompositionInput(overrides));

			expect(
				evaluateGatewayAggregateAdmission({ expectedCohort, phase: 'joining', vector }),
			).toMatchObject({ kind: 'contain', reasons: [reason] });
		},
	);

	it('reads a fresh immutable observer snapshot for each health or admission observation', () => {
		let vmLivenessEvidence: GatewayVmLivenessEvidence = {
			identity: expectedCohort.fence,
			kind: 'current',
		};
		const runtimeReadinessEvidence = createReadyCompositionInput().runtimeReadinessEvidence;
		const observer = createGatewayAggregateReadinessObserver({
			expectedCohort,
			readAppliedIngressRoutes: () => [expectedCohort.ingressIntent.controlRoute],
			readControlSessionEvidence: () => createReadyControlEvidence(),
			readFatalEvidence: (): GatewayFatalEvidenceObservation => ({ kind: 'none' }),
			readFrameworkNativeReadinessEvidence: () => createFrameworkProbeEvidence(),
			readRuntimeReadinessEvidence: () => runtimeReadinessEvidence,
			readVmLivenessEvidence: () => vmLivenessEvidence,
		});

		const readySnapshot = observer.getSnapshot();
		vmLivenessEvidence = { identity: expectedCohort.fence, kind: 'lost' };
		const lostSnapshot = observer.getSnapshot();

		expect(readySnapshot.vmLiveness.kind).toBe('ready');
		expect(lostSnapshot.vmLiveness.kind).toBe('lost');
		expect(readySnapshot).not.toBe(lostSnapshot);
		expect(Object.isFrozen(lostSnapshot)).toBe(true);
	});
});
