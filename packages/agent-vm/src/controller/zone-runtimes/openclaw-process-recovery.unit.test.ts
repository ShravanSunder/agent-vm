import { describe, expect, it, vi } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	createOpenClawProcessRecoveryCoordinator,
	type OpenClawProcessRecoveryAttemptBudget,
	type OpenClawProcessRecoveryBinding,
} from './openclaw-process-recovery.js';

const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const GATEWAY_TWO = {
	bootId: 'gateway-boot-2',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-2',
	gatewayVmId: 'gateway-vm-2',
	generationId: 'gateway-generation-2',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

function createDeferred(): {
	readonly promise: Promise<void>;
	readonly reject: (error: Error) => void;
	readonly resolve: () => void;
} {
	let rejectPromise!: (error: Error) => void;
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		reject: rejectPromise,
		resolve: resolvePromise,
	};
}

interface ProcessRecoveryStabilityBinding {
	readonly gateway: GatewayEpochIdentity;
	readonly processEpoch: string;
}

function invokeRequiredCoordinatorMethod(
	coordinator: object,
	methodName: 'recordControlHeartbeat' | 'recordPopulatedProcessObservation',
	binding: ProcessRecoveryStabilityBinding,
): void {
	const method = Reflect.get(coordinator, methodName);
	if (typeof method !== 'function') {
		throw new TypeError(`process recovery coordinator must expose ${methodName}()`);
	}
	Reflect.apply(method, coordinator, [binding]);
}

function recordStableSuccess(options: {
	readonly advanceNowMs: (durationMs: number) => void;
	readonly binding: ProcessRecoveryStabilityBinding;
	readonly coordinator: object;
}): void {
	for (let heartbeatIndex = 0; heartbeatIndex < 5; heartbeatIndex += 1) {
		invokeRequiredCoordinatorMethod(options.coordinator, 'recordControlHeartbeat', options.binding);
	}
	for (let observationIndex = 0; observationIndex < 2; observationIndex += 1) {
		invokeRequiredCoordinatorMethod(
			options.coordinator,
			'recordPopulatedProcessObservation',
			options.binding,
		);
	}
	options.advanceNowMs(60_000);
	invokeRequiredCoordinatorMethod(options.coordinator, 'recordControlHeartbeat', options.binding);
	invokeRequiredCoordinatorMethod(
		options.coordinator,
		'recordPopulatedProcessObservation',
		options.binding,
	);
}

describe('createOpenClawProcessRecoveryCoordinator', () => {
	it('single-flights concurrent control and observer triggers for the same exact G/P', async () => {
		const recovery = createDeferred();
		const recoverCurrentProcess = vi.fn(() => recovery.promise);
		const escalateGatewayRecovery = vi.fn();
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
		});

		const controlRequest = coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'control-reconnect-exhausted',
			processEpoch: 'process-1',
		});
		const observerRequest = coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed',
			processEpoch: 'process-1',
		});

		expect(observerRequest).toBe(controlRequest);
		expect(recoverCurrentProcess).toHaveBeenCalledExactlyOnceWith(
			{
				gateway: GATEWAY_ONE,
				kind: 'control-reconnect-exhausted',
				processEpoch: 'process-1',
			},
			expect.objectContaining({ selectSuccessorAttempt: expect.any(Function) }),
		);
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();

		recovery.resolve();
		await expect(controlRequest).resolves.toBeUndefined();
	});

	it.each([
		['stale Gateway', GATEWAY_TWO, 'process-1'],
		['stale process', GATEWAY_ONE, 'process-stale'],
	] as const)('ignores a %s trigger', async (_label, gateway, processEpoch) => {
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {});
		const escalateGatewayRecovery = vi.fn();
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
		});

		await expect(
			coordinator.requestRecovery({
				gateway,
				kind: 'control-reconnect-exhausted',
				processEpoch,
			}),
		).resolves.toBeUndefined();

		expect(recoverCurrentProcess).not.toHaveBeenCalled();
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();
	});

	it('ignores a stale P1 callback after successful P2 publication', async () => {
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-2' };
			},
		);
		const escalateGatewayRecovery = vi.fn();
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			recoverCurrentProcess,
		});
		const p1Trigger = {
			gateway: GATEWAY_ONE,
			kind: 'control-reconnect-exhausted' as const,
			processEpoch: 'process-1',
		};

		await coordinator.requestRecovery(p1Trigger);
		await coordinator.requestRecovery(p1Trigger);

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();
	});

	it('escalates one failed flight exactly once without recursively retrying the process', async () => {
		const recovery = createDeferred();
		const recoveryError = new Error('P1 containment was not proven');
		const callOrder: string[] = [];
		const recoverCurrentProcess = vi.fn(() => {
			callOrder.push('recover');
			return recovery.promise;
		});
		const escalateGatewayRecovery = vi.fn(async (error: unknown): Promise<void> => {
			callOrder.push('escalate');
			expect(error).toBe(recoveryError);
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		const firstRequest = coordinator.requestRecovery(trigger);
		const joinedRequest = coordinator.requestRecovery(trigger);
		expect(joinedRequest).toBe(firstRequest);
		expect(callOrder).toEqual(['recover']);

		recovery.reject(recoveryError);
		await expect(firstRequest).resolves.toBeUndefined();
		await expect(coordinator.requestRecovery(trigger)).resolves.toBeUndefined();

		expect(callOrder).toEqual(['recover', 'escalate']);
		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('does not invoke whole-G recovery after a successful process flight', async () => {
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
			},
		);
		const escalateGatewayRecovery = vi.fn();
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
		});

		await coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'control-reconnect-exhausted',
			processEpoch: 'process-1',
		});

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();
	});

	it('admits exactly three successor selections inside one process recovery flight', async () => {
		const selectedAttempts: boolean[] = [];
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				for (let selectionIndex = 0; selectionIndex < 4; selectionIndex += 1) {
					selectedAttempts.push(attemptBudget.selectSuccessorAttempt());
				}
			},
		);
		const escalateGatewayRecovery = vi.fn();
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			nowMs: () => 123_456,
			recoverCurrentProcess,
		});

		await coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed',
			processEpoch: 'process-1',
		});

		expect(selectedAttempts).toEqual([true, true, true, false]);
		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();
	});

	it('does not accelerate a pending five-second whole-G retry for the same G/P trigger', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecoveryError = new Error('whole-G recovery failed');
		const scheduledRetryCallbacks: Array<() => void> = [];
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {
			throw processRecoveryError;
		});
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {
			throw gatewayRecoveryError;
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
			scheduleGatewayEscalationRetry: (callback, delayMs) => {
				expect(delayMs).toBe(5_000);
				scheduledRetryCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		await expect(coordinator.requestRecovery(trigger)).rejects.toBe(gatewayRecoveryError);
		await expect(coordinator.requestRecovery(trigger)).resolves.toBeUndefined();

		expect(scheduledRetryCallbacks).toHaveLength(1);
		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('drops a scheduled whole-G retry when its callback observes a different current G/P', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecoveryError = new Error('whole-G recovery failed');
		let currentBinding: OpenClawProcessRecoveryBinding = {
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
		};
		let scheduledRetryCallback: (() => void) | undefined;
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {
			throw processRecoveryError;
		});
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {
			throw gatewayRecoveryError;
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			recoverCurrentProcess,
			scheduleGatewayEscalationRetry: (callback) => {
				scheduledRetryCallback = callback;
				return { cancel: () => undefined };
			},
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		await expect(coordinator.requestRecovery(trigger)).rejects.toBe(gatewayRecoveryError);
		currentBinding = { gateway: GATEWAY_TWO, processEpoch: 'process-2' };
		scheduledRetryCallback?.();
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('joins concurrent triggers while whole-G escalation is still in flight', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecovery = createDeferred();
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {
			throw processRecoveryError;
		});
		const escalateGatewayRecovery = vi.fn(() => gatewayRecovery.promise);
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
		});
		const controlTrigger = {
			gateway: GATEWAY_ONE,
			kind: 'control-reconnect-exhausted' as const,
			processEpoch: 'process-1',
		};

		const controlRequest = coordinator.requestRecovery(controlTrigger);
		await vi.waitFor(() => expect(escalateGatewayRecovery).toHaveBeenCalledOnce());
		const observerRequest = coordinator.requestRecovery({
			...controlTrigger,
			kind: 'process-observation-failed',
		});
		let observerRequestSettled = false;
		void observerRequest.finally(() => {
			observerRequestSettled = true;
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(observerRequestSettled).toBe(false);
		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledExactlyOnceWith(
			processRecoveryError,
			controlTrigger,
		);

		gatewayRecovery.resolve();
		await expect(Promise.all([controlRequest, observerRequest])).resolves.toEqual([
			undefined,
			undefined,
		]);
	});

	it('retries failed whole-G escalation without re-entering unsafe process recovery', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecoveryError = new Error('whole-G recovery failed');
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {
			throw processRecoveryError;
		});
		let currentBinding: OpenClawProcessRecoveryBinding | undefined = {
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
		};
		const escalationRetryCallbacks: Array<() => void> = [];
		const escalateGatewayRecovery = vi.fn<(error: unknown) => Promise<void>>(async () => {
			if (escalateGatewayRecovery.mock.calls.length === 1) {
				currentBinding = undefined;
				throw gatewayRecoveryError;
			}
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			recoverCurrentProcess,
			scheduleGatewayEscalationRetry: (callback) => {
				escalationRetryCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		await expect(coordinator.requestRecovery(trigger)).rejects.toBe(gatewayRecoveryError);
		expect(escalationRetryCallbacks).toHaveLength(1);
		escalationRetryCallbacks[0]?.();
		await vi.waitFor(() => {
			expect(escalateGatewayRecovery).toHaveBeenCalledTimes(2);
		});

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenNthCalledWith(1, processRecoveryError, trigger);
		expect(escalateGatewayRecovery).toHaveBeenNthCalledWith(2, processRecoveryError, trigger);
	});

	it('cancels a scheduled whole-G retry before intentional runtime shutdown', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecoveryError = new Error('whole-G recovery failed');
		const escalationRetryCallbacks: Array<() => void> = [];
		let currentBinding: OpenClawProcessRecoveryBinding | undefined = {
			gateway: GATEWAY_ONE,
			processEpoch: 'process-1',
		};
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {
			currentBinding = undefined;
			throw gatewayRecoveryError;
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			recoverCurrentProcess: async (): Promise<void> => {
				throw processRecoveryError;
			},
			scheduleGatewayEscalationRetry: (callback) => {
				escalationRetryCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		await expect(coordinator.requestRecovery(trigger)).rejects.toBe(gatewayRecoveryError);
		expect(escalationRetryCallbacks).toHaveLength(1);

		coordinator.cancelPendingRecovery();
		escalationRetryCallbacks[0]?.();
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('suspends whole-G escalation after three consecutive failed replacements', async () => {
		const processRecoveryError = new Error('P1 containment was not proven');
		const gatewayRecoveryError = new Error('whole-G recovery failed');
		const escalationRetryCallbacks: Array<() => void> = [];
		const recoverCurrentProcess = vi.fn(async (): Promise<void> => {
			throw processRecoveryError;
		});
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {
			throw gatewayRecoveryError;
		});
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => ({ gateway: GATEWAY_ONE, processEpoch: 'process-1' }),
			recoverCurrentProcess,
			scheduleGatewayEscalationRetry: (callback) => {
				escalationRetryCallbacks.push(callback);
				return { cancel: () => undefined };
			},
		});
		const trigger = {
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed' as const,
			processEpoch: 'process-1',
		};

		await expect(coordinator.requestRecovery(trigger)).rejects.toBe(gatewayRecoveryError);
		expect(escalationRetryCallbacks).toHaveLength(1);
		escalationRetryCallbacks[0]?.();
		await vi.waitFor(() => {
			expect(escalationRetryCallbacks).toHaveLength(2);
		});
		escalationRetryCallbacks[1]?.();
		await vi.waitFor(() => {
			expect(escalateGatewayRecovery).toHaveBeenCalledTimes(3);
		});
		await new Promise<void>((resolve) => {
			queueMicrotask(() => queueMicrotask(resolve));
		});

		await expect(coordinator.requestRecovery(trigger)).resolves.toBeUndefined();
		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledTimes(3);
		expect(escalationRetryCallbacks).toHaveLength(2);
	});

	it('selects at most three successor attempts for one exact G in a rolling five-minute window', async () => {
		let nowMs = 0;
		let successorIndex = 1;
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				successorIndex += 1;
				currentBinding = {
					gateway: GATEWAY_ONE,
					processEpoch: `process-${successorIndex}`,
				};
			},
		);
		const escalateGatewayRecovery = vi.fn(
			async (_error: unknown, _binding: OpenClawProcessRecoveryBinding): Promise<void> => {},
		);
		const coordinatorOptions = {
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			nowMs: () => nowMs,
			recoverCurrentProcess,
		};
		const coordinator = createOpenClawProcessRecoveryCoordinator(coordinatorOptions);
		const requestSuccessor = async (): Promise<void> => {
			await coordinator.requestRecovery({
				...currentBinding,
				kind: 'process-observation-failed',
			});
			nowMs += 90_000;
		};

		await requestSuccessor();
		await requestSuccessor();
		await requestSuccessor();
		await requestSuccessor();

		expect(recoverCurrentProcess.mock.calls.length).toBeLessThanOrEqual(3);
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it.each([
		['only five control heartbeats', 5, 3, 60_000],
		['only two populated process observations', 6, 2, 60_000],
		['all counts before sixty seconds', 6, 3, 59_999],
	] as const)(
		'does not declare process recovery stable with %s',
		async (_label, heartbeatCount, processObservationCount, elapsedMs) => {
			let nowMs = 0;
			let successorIndex = 1;
			let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
			const recoverCurrentProcess = vi.fn(
				async (
					_trigger: unknown,
					attemptBudget: OpenClawProcessRecoveryAttemptBudget,
				): Promise<void> => {
					expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
					successorIndex += 1;
					currentBinding = { gateway: GATEWAY_ONE, processEpoch: `process-${successorIndex}` };
				},
			);
			const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {});
			const coordinatorOptions = {
				escalateGatewayRecovery,
				getCurrentBinding: () => currentBinding,
				nowMs: () => nowMs,
				recoverCurrentProcess,
			};
			const coordinator = createOpenClawProcessRecoveryCoordinator(coordinatorOptions);

			await coordinator.requestRecovery({
				gateway: GATEWAY_ONE,
				kind: 'process-observation-failed',
				processEpoch: 'process-1',
			});
			for (let heartbeatIndex = 0; heartbeatIndex < heartbeatCount; heartbeatIndex += 1) {
				invokeRequiredCoordinatorMethod(coordinator, 'recordControlHeartbeat', currentBinding);
			}
			for (
				let observationIndex = 0;
				observationIndex < processObservationCount;
				observationIndex += 1
			) {
				invokeRequiredCoordinatorMethod(
					coordinator,
					'recordPopulatedProcessObservation',
					currentBinding,
				);
			}
			nowMs = elapsedMs;

			await coordinator.requestRecovery({
				...currentBinding,
				kind: 'process-observation-failed',
			});

			expect(recoverCurrentProcess).toHaveBeenCalledTimes(2);
			expect(escalateGatewayRecovery).not.toHaveBeenCalled();
		},
	);

	it('starts a five-minute cooldown only after six heartbeats and three observations across sixty seconds', async () => {
		let nowMs = 0;
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-2' };
			},
		);
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {});
		const coordinatorOptions = {
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			nowMs: () => nowMs,
			recoverCurrentProcess,
		};
		const coordinator = createOpenClawProcessRecoveryCoordinator(coordinatorOptions);

		await coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed',
			processEpoch: 'process-1',
		});
		recordStableSuccess({
			advanceNowMs: (durationMs) => {
				nowMs += durationMs;
			},
			binding: currentBinding,
			coordinator,
		});
		nowMs += 299_999;

		await coordinator.requestRecovery({
			...currentBinding,
			kind: 'control-reconnect-exhausted',
		});

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('escalates outward when replacement control never stabilizes instead of replacing another process', async () => {
		let nowMs = 0;
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-2' };
			},
		);
		const escalateGatewayRecovery = vi.fn(
			async (_error: unknown, _binding: OpenClawProcessRecoveryBinding): Promise<void> => {},
		);
		const coordinator = createOpenClawProcessRecoveryCoordinator({
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			nowMs: () => nowMs,
			recoverCurrentProcess,
		});

		await coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'control-reconnect-exhausted',
			processEpoch: 'process-1',
		});
		nowMs = 60_000;
		await coordinator.requestRecovery({
			...currentBinding,
			kind: 'control-reconnect-exhausted',
		});

		expect(recoverCurrentProcess).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
		expect(escalateGatewayRecovery.mock.calls[0]?.[1]).toEqual(currentBinding);
	});

	it('escalates the next process failure after more than three stable same-G recoveries in one rolling hour', async () => {
		let nowMs = 0;
		let successorIndex = 1;
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				successorIndex += 1;
				currentBinding = {
					gateway: GATEWAY_ONE,
					processEpoch: `process-${successorIndex}`,
				};
			},
		);
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {});
		const coordinatorOptions = {
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			nowMs: () => nowMs,
			recoverCurrentProcess,
		};
		const coordinator = createOpenClawProcessRecoveryCoordinator(coordinatorOptions);
		const requestAndStabilizeSuccessor = async (): Promise<void> => {
			await coordinator.requestRecovery({
				...currentBinding,
				kind: 'process-observation-failed',
			});
			recordStableSuccess({
				advanceNowMs: (durationMs) => {
					nowMs += durationMs;
				},
				binding: currentBinding,
				coordinator,
			});
			nowMs += 300_001;
		};

		await requestAndStabilizeSuccessor();
		await requestAndStabilizeSuccessor();
		await requestAndStabilizeSuccessor();
		await requestAndStabilizeSuccessor();

		await coordinator.requestRecovery({
			...currentBinding,
			kind: 'process-observation-failed',
		});

		expect(recoverCurrentProcess).toHaveBeenCalledTimes(4);
		expect(escalateGatewayRecovery).toHaveBeenCalledOnce();
	});

	it('does not let healthy observations from another exact G/P clear current-process instability', async () => {
		let nowMs = 0;
		let successorIndex = 1;
		let currentBinding = { gateway: GATEWAY_ONE, processEpoch: 'process-1' };
		const recoverCurrentProcess = vi.fn(
			async (
				_trigger: unknown,
				attemptBudget: OpenClawProcessRecoveryAttemptBudget,
			): Promise<void> => {
				expect(attemptBudget.selectSuccessorAttempt()).toBe(true);
				successorIndex += 1;
				currentBinding = { gateway: GATEWAY_ONE, processEpoch: `process-${successorIndex}` };
			},
		);
		const escalateGatewayRecovery = vi.fn(async (): Promise<void> => {});
		const coordinatorOptions = {
			escalateGatewayRecovery,
			getCurrentBinding: () => currentBinding,
			nowMs: () => nowMs,
			recoverCurrentProcess,
		};
		const coordinator = createOpenClawProcessRecoveryCoordinator(coordinatorOptions);

		await coordinator.requestRecovery({
			gateway: GATEWAY_ONE,
			kind: 'process-observation-failed',
			processEpoch: 'process-1',
		});
		recordStableSuccess({
			advanceNowMs: (durationMs) => {
				nowMs += durationMs;
			},
			binding: { gateway: GATEWAY_TWO, processEpoch: 'unrelated-process' },
			coordinator,
		});

		await coordinator.requestRecovery({
			...currentBinding,
			kind: 'process-observation-failed',
		});

		expect(recoverCurrentProcess).toHaveBeenCalledTimes(2);
		expect(escalateGatewayRecovery).not.toHaveBeenCalled();
	});
});
