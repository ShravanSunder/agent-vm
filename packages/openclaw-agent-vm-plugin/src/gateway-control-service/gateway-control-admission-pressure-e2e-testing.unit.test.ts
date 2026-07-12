import {
	createGatewayControlAdmissionExecutor,
	type GatewayControlRpcMessage,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV,
	GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT,
	createGatewayControlAdmissionPressureE2eActuator,
	getGatewayControlAdmissionPressureE2eActuator,
	registerGatewayControlAdmissionPressureE2eActuator,
} from './gateway-control-admission-pressure-e2e-testing.js';
import { createGatewayControlApplicationMessageRuntime } from './gateway-control-application-message-runtime.js';
import type { GatewayControlAcceptedSession } from './gateway-control-service-contracts.js';

const acceptedSession = {
	attachmentGeneration: 7,
	bootId: 'process-a',
	connectionId: 'connection-a',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'gateway-a',
	peerId: 'peer-a',
	processEpoch: 'process-a',
	sessionId: 'session-a',
	zoneId: 'zone-a',
} satisfies GatewayControlAcceptedSession;

afterEach(() => {
	vi.unstubAllEnvs();
});

function createFixture(): {
	readonly actuator: ReturnType<typeof createGatewayControlAdmissionPressureE2eActuator>;
	setAcceptedSession(session: GatewayControlAcceptedSession | undefined): void;
} {
	let currentAcceptedSession: GatewayControlAcceptedSession | undefined = acceptedSession;
	const ingress = createGatewayControlAdmissionExecutor<GatewayControlRpcMessage>();
	const egress = createGatewayControlAdmissionExecutor<GatewayControlRpcMessage>();
	return {
		actuator: createGatewayControlAdmissionPressureE2eActuator({
			getAcceptedSession: () => currentAcceptedSession,
			getEgress: () => egress,
			getIngress: () => ingress,
		}),
		setAcceptedSession: (session) => {
			currentAcceptedSession = session;
		},
	};
}

describe('gateway control admission pressure E2E actuator', () => {
	it('registers only behind its explicit E2E environment gate', () => {
		const fixture = createFixture();

		const unregisterDisabled = registerGatewayControlAdmissionPressureE2eActuator(fixture.actuator);

		expect(getGatewayControlAdmissionPressureE2eActuator()).toBeUndefined();
		unregisterDisabled();

		vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV, '1');
		const unregisterEnabled = registerGatewayControlAdmissionPressureE2eActuator(fixture.actuator);

		expect(getGatewayControlAdmissionPressureE2eActuator()).toBe(fixture.actuator);
		unregisterEnabled();
		expect(getGatewayControlAdmissionPressureE2eActuator()).toBeUndefined();
	});

	it('holds only non-authoritative work and exposes real drop and queue diagnostics', async () => {
		const fixture = createFixture();

		const before = fixture.actuator.snapshot(acceptedSession.attachmentGeneration);
		const hold = await fixture.actuator.hold({
			attachmentGeneration: acceptedSession.attachmentGeneration,
			direction: 'ingress',
			messageClass: 'diagnostic',
		});
		const duringHold = fixture.actuator.snapshot(acceptedSession.attachmentGeneration);
		const pressure = await fixture.actuator.submitBatch({
			attachmentGeneration: acceptedSession.attachmentGeneration,
			batchSize: 65,
			byteLength: 1,
			coalesceKeyPrefix: 'diagnostic-pressure',
			direction: 'ingress',
			messageClass: 'diagnostic',
		});

		expect(before.ingress.activeByClass).toEqual({
			authority: 0,
			diagnostic: 0,
			liveness: 0,
			safety: 0,
		});
		expect(duringHold.ingress.activeByClass.diagnostic).toBe(1);
		expect(pressure.admissions.filter((result) => result.status === 'dropped')).toHaveLength(2);
		expect(pressure.snapshot.ingress.scheduler.diagnosticMessages).toBe(64);
		expect(pressure.snapshot.ingress.queuedByClass.diagnostic).toBe(63);
		expect(pressure.snapshot.ingress.scheduler.droppedMessages).toBe(2);
		expect(pressure.snapshot.highWater.ingress.diagnostic).toBe(64);
		expect(pressure.snapshot.ingress.activeByClass.authority).toBe(0);
		expect(pressure.snapshot.ingress.activeByClass.safety).toBe(0);

		await fixture.actuator.release({
			attachmentGeneration: acceptedSession.attachmentGeneration,
			holdId: hold.holdId,
		});
		const after = fixture.actuator.snapshot(acceptedSession.attachmentGeneration);
		expect(after.ingress.activeByClass.diagnostic).toBe(0);
		expect(after.ingress.scheduler.diagnosticMessages).toBe(0);
	});

	it('fails closed after the exact accepted attachment generation changes', async () => {
		const fixture = createFixture();
		const hold = await fixture.actuator.hold({
			attachmentGeneration: acceptedSession.attachmentGeneration,
			direction: 'egress',
			messageClass: 'liveness',
		});
		fixture.setAcceptedSession({ ...acceptedSession, attachmentGeneration: 8 });

		expect(() => fixture.actuator.snapshot(acceptedSession.attachmentGeneration)).toThrow(
			'generation is stale',
		);
		await expect(
			fixture.actuator.submitBatch({
				attachmentGeneration: acceptedSession.attachmentGeneration,
				batchSize: 1,
				byteLength: 1,
				coalesceKeyPrefix: 'stale',
				direction: 'egress',
				messageClass: 'liveness',
			}),
		).rejects.toThrow('generation is stale');
		await expect(
			fixture.actuator.release({
				attachmentGeneration: acceptedSession.attachmentGeneration,
				holdId: hold.holdId,
			}),
		).rejects.toThrow('generation is stale');
	});

	it('rejects batches above the hard E2E pressure bound', async () => {
		const fixture = createFixture();

		await expect(
			fixture.actuator.submitBatch({
				attachmentGeneration: acceptedSession.attachmentGeneration,
				batchSize: GATEWAY_CONTROL_ADMISSION_PRESSURE_BATCH_LIMIT + 1,
				byteLength: 1,
				coalesceKeyPrefix: 'oversized',
				direction: 'ingress',
				messageClass: 'diagnostic',
			}),
		).rejects.toThrow('batch size must be between');
	});

	it('registers the actuator from the real application-message runtime only under the E2E gate', () => {
		vi.stubEnv(AGENT_VM_E2E_CONTROL_ADMISSION_PRESSURE_ENV, '1');

		createGatewayControlApplicationMessageRuntime({
			assertInboundEnvelopeMatchesAcceptedSession: () => undefined,
			closeForProtocolFailure: () => undefined,
			closeForResponseFailure: () => undefined,
			commandResultTimeoutMsFor: () => 1_000,
			getAcceptedSession: () => acceptedSession,
			getAcceptedSocket: () => undefined,
			getLastSeenControllerSequence: () => 0,
			pendingCommandResults: new Map(),
			recordLastSeenControllerSequence: () => undefined,
			recordLastSeenPeerSequence: () => undefined,
			reservePeerSequence: () => 1,
		});

		expect(
			getGatewayControlAdmissionPressureE2eActuator()?.snapshot(
				acceptedSession.attachmentGeneration,
			).acceptedAttachmentGeneration,
		).toBe(acceptedSession.attachmentGeneration);
	});
});
