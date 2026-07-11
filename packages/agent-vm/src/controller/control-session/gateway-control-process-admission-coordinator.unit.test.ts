import { createGatewayControlAdmissionExecutor } from '@agent-vm/gateway-control-contracts';
import { describe, expect, it } from 'vitest';

import { createGatewayControlProcessAdmissionCoordinator } from './gateway-control-process-admission-coordinator.js';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function flushImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function sessionIdentity(
	zoneId: string,
	attachmentGeneration = 1,
	gatewayEpoch = `gateway-${zoneId}`,
): {
	readonly attachmentGeneration: number;
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly processEpoch: string;
	readonly zoneId: string;
} {
	return {
		attachmentGeneration,
		controllerEpoch: 'controller-a',
		gatewayEpoch,
		processEpoch: `process-${zoneId}`,
		zoneId,
	};
}

describe('Gateway control process admission coordinator', () => {
	it('returns typed session capacity refusal and releases capacity on exact unregister', () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			maxActiveSessions: 1,
		});
		const zoneA = coordinator.registerSession(sessionIdentity('zone-a'));
		expect(zoneA.status).toBe('admitted');
		expect(coordinator.registerSession(sessionIdentity('zone-b'))).toEqual({
			reason: 'session_capacity',
			status: 'capacity_refused',
		});
		if (zoneA.status !== 'admitted') {
			throw new Error('zone A was not admitted');
		}
		coordinator.unregisterSession(zoneA.registration, 'zone A closed');
		expect(coordinator.registerSession(sessionIdentity('zone-b')).status).toBe('admitted');
	});

	it('does not let stale S1 unregister drain replacement S2', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const first = coordinator.registerSession(sessionIdentity('zone-a', 1));
		const second = coordinator.registerSession(sessionIdentity('zone-a', 2));
		if (first.status !== 'admitted' || second.status !== 'admitted') {
			throw new Error('zone registration failed');
		}
		coordinator.unregisterSession(first.registration, 'stale S1 close');
		let executed = false;
		const localExecutor = createGatewayControlAdmissionExecutor<string>();
		const submission = coordinator.submit({
			localExecutor,
			registration: second.registration,
			request: {
				byteLength: 1,
				execute: async () => {
					executed = true;
				},
				id: 's2-safety',
				messageClass: 'safety',
				payload: 's2-safety',
			},
		});
		await flushImmediate();
		await flushImmediate();
		await expect(submission.completion).resolves.toEqual({ status: 'executed' });
		expect(executed).toBe(true);
	});

	it('refuses a delayed lower-generation registration without closing current S2', () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const current = coordinator.registerSession(sessionIdentity('zone-a', 2));
		if (current.status !== 'admitted') {
			throw new Error('current session registration failed');
		}
		expect(coordinator.registerSession(sessionIdentity('zone-a', 1))).toEqual({
			reason: 'stale_attachment',
			status: 'capacity_refused',
		});
		expect(coordinator.diagnostics().activeSessions).toBe(1);
		coordinator.unregisterSession(current.registration, 'test complete');
	});

	it('requires exact old-G unregister before admitting a different Gateway epoch', () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const oldGateway = coordinator.registerSession(sessionIdentity('zone-a', 5, 'gateway-old'));
		if (oldGateway.status !== 'admitted') {
			throw new Error('old Gateway registration failed');
		}
		expect(coordinator.registerSession(sessionIdentity('zone-a', 1, 'gateway-new'))).toEqual({
			reason: 'gateway_epoch_conflict',
			status: 'capacity_refused',
		});
		coordinator.unregisterSession(oldGateway.registration, 'old Gateway contained');
		expect(coordinator.registerSession(sessionIdentity('zone-a', 1, 'gateway-new')).status).toBe(
			'admitted',
		);
	});

	it('sheds global non-safety pressure without borrowing zone B safety reserve', async () => {
		const scheduled: Array<() => void> = [];
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			maxNonSafetyMessages: 1,
			scheduleImmediate: (callback) => scheduled.push(callback),
		});
		const zoneA = coordinator.registerSession(sessionIdentity('zone-a'));
		const zoneB = coordinator.registerSession(sessionIdentity('zone-b'));
		if (zoneA.status !== 'admitted' || zoneB.status !== 'admitted') {
			throw new Error('zone registration failed');
		}
		const localExecutor = createGatewayControlAdmissionExecutor<string>();
		const zoneAAuthority = coordinator.submit({
			localExecutor,
			registration: zoneA.registration,
			request: {
				byteLength: 1,
				execute: async () => undefined,
				id: 'zone-a-authority',
				messageClass: 'authority',
				payload: 'zone-a-authority',
				stablePrincipal: 'zone-a-principal',
			},
		});
		expect(zoneAAuthority.admission).toEqual({ status: 'admitted' });
		const zoneBLiveness = coordinator.submit({
			localExecutor,
			registration: zoneB.registration,
			request: {
				byteLength: 1,
				coalesceKey: 'zone-b-heartbeat',
				execute: async () => undefined,
				id: 'zone-b-liveness',
				messageClass: 'liveness',
				payload: 'zone-b-liveness',
			},
		});
		expect(zoneBLiveness.admission).toEqual({ reason: 'global_capacity', status: 'shed' });
		const zoneBSafety = coordinator.submit({
			localExecutor,
			registration: zoneB.registration,
			request: {
				byteLength: 1,
				execute: async () => undefined,
				id: 'zone-b-safety',
				messageClass: 'safety',
				payload: 'zone-b-safety',
			},
		});
		expect(zoneBSafety.admission).toEqual({ status: 'admitted' });
		expect(coordinator.diagnostics()).toMatchObject({
			activeSessions: 2,
			nonSafetyMessages: 1,
		});
		coordinator.unregisterSession(zoneA.registration, 'test complete');
		coordinator.unregisterSession(zoneB.registration, 'test complete');
	});

	it('lets zone B safety and liveness execute during zone A bidirectional authority pressure', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const zoneA = coordinator.registerSession(sessionIdentity('zone-a'));
		const zoneB = coordinator.registerSession(sessionIdentity('zone-b'));
		if (zoneA.status !== 'admitted' || zoneB.status !== 'admitted') {
			throw new Error('zone registration failed');
		}
		const heldAuthority = deferred();
		const zoneAIngress = createGatewayControlAdmissionExecutor<string>();
		const zoneAEgress = createGatewayControlAdmissionExecutor<string>();
		const zoneBExecutor = createGatewayControlAdmissionExecutor<string>();
		const zoneACompletions = Array.from({ length: 16 }, (_, index) => {
			const localExecutor = index % 2 === 0 ? zoneAIngress : zoneAEgress;
			return coordinator.submit({
				localExecutor,
				registration: zoneA.registration,
				request: {
					byteLength: 1,
					execute: async () => await heldAuthority.promise,
					id: `zone-a-authority-${String(index)}`,
					messageClass: 'authority',
					payload: `zone-a-authority-${String(index)}`,
					stablePrincipal: `principal-${String(index)}`,
				},
			}).completion;
		});
		const zoneBExecuted: string[] = [];
		const zoneBSafety = coordinator.submit({
			localExecutor: zoneBExecutor,
			registration: zoneB.registration,
			request: {
				byteLength: 1,
				execute: async () => {
					zoneBExecuted.push('safety');
				},
				id: 'zone-b-safety',
				messageClass: 'safety',
				payload: 'zone-b-safety',
			},
		});
		const zoneBLiveness = coordinator.submit({
			localExecutor: zoneBExecutor,
			registration: zoneB.registration,
			request: {
				byteLength: 1,
				coalesceKey: 'zone-b-heartbeat',
				execute: async () => {
					zoneBExecuted.push('liveness');
				},
				id: 'zone-b-liveness',
				messageClass: 'liveness',
				payload: 'zone-b-liveness',
			},
		});
		await flushImmediate();
		await flushImmediate();
		await expect(Promise.all([zoneBSafety.completion, zoneBLiveness.completion])).resolves.toEqual([
			{ status: 'executed' },
			{ status: 'executed' },
		]);
		expect(zoneBExecuted).toEqual(['safety', 'liveness']);

		coordinator.unregisterSession(zoneA.registration, 'zone A closed');
		await expect(Promise.all(zoneACompletions)).resolves.toEqual(
			Array.from({ length: 16 }, () => ({ reason: 'zone A closed', status: 'closed' })),
		);
		heldAuthority.resolve();
	});
});
