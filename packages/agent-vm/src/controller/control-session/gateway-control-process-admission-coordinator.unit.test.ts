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

	it('retains predecessor process capacity until active cleanup settles', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			maxNonSafetyMessages: 1,
		});
		const first = coordinator.registerSession(sessionIdentity('zone-a', 1));
		if (first.status !== 'admitted') throw new Error('first session registration failed');
		const blocked = deferred();
		const firstExecutor = createGatewayControlAdmissionExecutor<string>();
		const firstSubmission = coordinator.submit({
			localExecutor: firstExecutor,
			registration: first.registration,
			request: {
				byteLength: 1,
				execute: async () => await blocked.promise,
				id: 'first-authority',
				messageClass: 'authority',
				payload: 'first-authority',
				retainProcessAdmissionUntilCleanup: true,
				stablePrincipal: 'principal-a',
			},
		});
		await flushImmediate();
		await flushImmediate();
		coordinator.unregisterSession(first.registration, 'first retired');
		firstExecutor.close('first retired');
		await expect(firstSubmission.completion).resolves.toEqual({
			reason: 'first retired',
			status: 'closed',
		});

		const second = coordinator.registerSession(sessionIdentity('zone-a', 2));
		if (second.status !== 'admitted') throw new Error('second session registration failed');
		const secondExecutor = createGatewayControlAdmissionExecutor<string>();
		const refused = coordinator.submit({
			localExecutor: secondExecutor,
			registration: second.registration,
			request: {
				byteLength: 1,
				execute: async () => undefined,
				id: 'second-authority-refused',
				messageClass: 'authority',
				payload: 'second-authority-refused',
				stablePrincipal: 'principal-a',
			},
		});
		expect(refused.admission).toEqual({ reason: 'global_capacity', status: 'refused' });
		expect(coordinator.diagnostics().nonSafetyMessages).toBe(1);

		blocked.resolve();
		await firstSubmission.cleanup;
		const recovered = coordinator.submit({
			localExecutor: secondExecutor,
			registration: second.registration,
			request: {
				byteLength: 1,
				execute: async () => undefined,
				id: 'second-authority-recovered',
				messageClass: 'authority',
				payload: 'second-authority-recovered',
				stablePrincipal: 'principal-a',
			},
		});
		expect(recovered.admission).toEqual({ status: 'admitted' });
	});

	it('cancels only the exact configured CLI operation owner and makes duplicates inert', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const registered = coordinator.registerSession(sessionIdentity('zone-a', 3));
		if (registered.status !== 'admitted') throw new Error('session registration failed');
		const cleanup = deferred();
		let observedSignal: AbortSignal | undefined;
		const executor = createGatewayControlAdmissionExecutor<string>();
		const submission = coordinator.submit({
			localExecutor: executor,
			registration: registered.registration,
			request: {
				byteLength: 1,
				cancellableOperation: {
					activeOperationId: '11111111-1111-4111-8111-111111111111',
					attachmentGeneration: 3,
					connectionId: '22222222-2222-4222-8222-222222222222',
					sessionId: '33333333-3333-4333-8333-333333333333',
					stablePrincipal: 'principal-a',
				},
				execute: async ({ cancellationSignal }) => {
					observedSignal = cancellationSignal;
					await cleanup.promise;
				},
				id: 'configured-cli-a',
				messageClass: 'authority',
				payload: 'configured-cli-a',
				retainProcessAdmissionUntilCleanup: true,
				stablePrincipal: 'principal-a',
			},
		});
		await flushImmediate();
		await flushImmediate();
		expect(
			coordinator.cancelOperation({
				activeOperationId: '11111111-1111-4111-8111-111111111111',
				attachmentGeneration: 3,
				connectionId: '22222222-2222-4222-8222-222222222222',
				registration: registered.registration,
				sessionId: '33333333-3333-4333-8333-333333333333',
				stablePrincipal: 'principal-b',
			}),
		).toEqual({ status: 'not_owned' });
		expect(observedSignal?.aborted).toBe(false);
		const exactCancellation = {
			activeOperationId: '11111111-1111-4111-8111-111111111111',
			attachmentGeneration: 3,
			connectionId: '22222222-2222-4222-8222-222222222222',
			registration: registered.registration,
			sessionId: '33333333-3333-4333-8333-333333333333',
			stablePrincipal: 'principal-a',
		} as const;
		expect(coordinator.cancelOperation(exactCancellation)).toEqual({ status: 'cancelled' });
		expect(observedSignal?.aborted).toBe(true);
		expect(coordinator.cancelOperation(exactCancellation)).toEqual({
			status: 'already_cancelled',
		});
		expect(coordinator.diagnostics().nonSafetyMessages).toBe(1);
		cleanup.resolve();
		await submission.cleanup;
		expect(coordinator.diagnostics().nonSafetyMessages).toBe(0);
	});

	it('bounds repeated retained replacements by both process count and bytes then recovers', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			maxNonSafetyBytes: 2,
			maxNonSafetyMessages: 2,
		});
		const heldCleanup = [deferred(), deferred()] as const;
		const retainReplacement = async (
			index: number,
			held: ReturnType<typeof deferred>,
		): Promise<ReturnType<typeof coordinator.submit>> => {
			const registration = coordinator.registerSession(sessionIdentity('zone-a', index + 1));
			if (registration.status !== 'admitted') throw new Error('replacement registration failed');
			const executor = createGatewayControlAdmissionExecutor<string>();
			const submission = coordinator.submit({
				localExecutor: executor,
				registration: registration.registration,
				request: {
					byteLength: 1,
					execute: async () => await held.promise,
					id: `retained-${String(index)}`,
					messageClass: 'authority',
					payload: `retained-${String(index)}`,
					retainProcessAdmissionUntilCleanup: true,
					stablePrincipal: `principal-${String(index)}`,
				},
			});
			await flushImmediate();
			await flushImmediate();
			coordinator.unregisterSession(registration.registration, 'replacement retained');
			executor.close('replacement retained');
			return submission;
		};
		const retainedSubmissions = [
			await retainReplacement(0, heldCleanup[0]),
			await retainReplacement(1, heldCleanup[1]),
		];
		expect(coordinator.diagnostics()).toMatchObject({
			nonSafetyBytes: 2,
			nonSafetyMessages: 2,
		});
		const third = coordinator.registerSession(sessionIdentity('zone-a', 3));
		if (third.status !== 'admitted') throw new Error('third registration failed');
		const thirdExecutor = createGatewayControlAdmissionExecutor<string>();
		const refused = coordinator.submit({
			localExecutor: thirdExecutor,
			registration: third.registration,
			request: {
				byteLength: 1,
				execute: async () => undefined,
				id: 'third-refused',
				messageClass: 'authority',
				payload: 'third-refused',
				retainProcessAdmissionUntilCleanup: true,
				stablePrincipal: 'principal-third',
			},
		});
		expect(refused.admission).toEqual({ reason: 'global_capacity', status: 'refused' });

		for (const held of heldCleanup) held.resolve();
		await Promise.all(retainedSubmissions.map((submission) => submission.cleanup));
		expect(coordinator.diagnostics()).toMatchObject({
			nonSafetyBytes: 0,
			nonSafetyMessages: 0,
		});
		expect(
			coordinator.submit({
				localExecutor: thirdExecutor,
				registration: third.registration,
				request: {
					byteLength: 1,
					execute: async () => undefined,
					id: 'third-recovered',
					messageClass: 'authority',
					payload: 'third-recovered',
					stablePrincipal: 'principal-third',
				},
			}).admission,
		).toEqual({ status: 'admitted' });
	});

	it('keeps the zone registered until every retired predecessor cleanup settles', async () => {
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const heldCleanup = [deferred(), deferred()] as const;
		const retainRetiredSession = async (
			index: number,
			held: ReturnType<typeof deferred>,
		): Promise<ReturnType<typeof coordinator.submit>> => {
			const registration = coordinator.registerSession(sessionIdentity('zone-a', index + 1));
			if (registration.status !== 'admitted') throw new Error('session registration failed');
			const executor = createGatewayControlAdmissionExecutor<string>();
			const submission = coordinator.submit({
				localExecutor: executor,
				registration: registration.registration,
				request: {
					byteLength: 1,
					execute: async () => await held.promise,
					id: `retired-${String(index)}`,
					messageClass: 'authority',
					payload: `retired-${String(index)}`,
					retainProcessAdmissionUntilCleanup: true,
					stablePrincipal: `principal-${String(index)}`,
				},
			});
			await flushImmediate();
			await flushImmediate();
			coordinator.unregisterSession(registration.registration, 'retired');
			executor.close('retired');
			return submission;
		};
		const submissions = [
			await retainRetiredSession(0, heldCleanup[0]),
			await retainRetiredSession(1, heldCleanup[1]),
		];
		const emptySuccessor = coordinator.registerSession(sessionIdentity('zone-a', 3));
		if (emptySuccessor.status !== 'admitted') {
			throw new Error('empty successor registration failed');
		}
		coordinator.unregisterSession(emptySuccessor.registration, 'empty successor retired');
		expect(coordinator.diagnostics()).toMatchObject({
			activeSessions: 1,
			nonSafetyMessages: 2,
		});
		heldCleanup[0].resolve();
		await submissions[0]?.cleanup;
		expect(coordinator.diagnostics()).toMatchObject({
			activeSessions: 1,
			nonSafetyMessages: 1,
		});
		heldCleanup[1].resolve();
		await submissions[1]?.cleanup;
		expect(coordinator.diagnostics()).toMatchObject({
			activeSessions: 0,
			nonSafetyMessages: 0,
		});
	});

	it('releases displaced coalesced work cleanup without waiting for a dequeue', async () => {
		const scheduled: Array<() => void> = [];
		const coordinator = createGatewayControlProcessAdmissionCoordinator({
			scheduleImmediate: (callback) => scheduled.push(callback),
		});
		const registration = coordinator.registerSession(sessionIdentity('zone-a'));
		if (registration.status !== 'admitted') throw new Error('session registration failed');
		const executor = createGatewayControlAdmissionExecutor<string>();
		const submit = (id: string): ReturnType<typeof coordinator.submit> =>
			coordinator.submit({
				localExecutor: executor,
				registration: registration.registration,
				request: {
					byteLength: 1,
					coalesceKey: 'same-liveness',
					execute: async () => undefined,
					id,
					messageClass: 'liveness',
					payload: id,
				},
			});
		const first = submit('first');
		const second = submit('second');
		await expect(first.completion).resolves.toEqual({ status: 'replaced' });
		await first.cleanup;
		coordinator.unregisterSession(registration.registration, 'closed before pump');
		scheduled.shift()?.();
		await second.cleanup;
		expect(coordinator.diagnostics()).toMatchObject({
			activeSessions: 0,
			nonSafetyMessages: 0,
		});
	});
});
