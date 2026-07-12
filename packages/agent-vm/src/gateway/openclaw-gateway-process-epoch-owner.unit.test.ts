import type { GatewayProcessSpec } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi, type Mock } from 'vitest';

import {
	createGatewayControlSessionMaterial,
	type GatewayControlSessionMaterial,
} from '../controller/control-session/gateway-control-session.js';
import type { GatewayDisposableControlSessionClient } from '../controller/control-session/gateway-disposable-control-session-client.js';
import { openClawProcessSupervisorReceiptSchema } from '../controller/process-supervisor/openclaw-process-supervisor-contracts.js';
import {
	createOpenClawProcessSupervisor,
	type OpenClawProcessSupervisor,
	OpenClawProcessSupervisorInvocationError,
} from '../controller/process-supervisor/openclaw-process-supervisor.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	createOpenClawGatewayProcessEpochOwner,
	type OpenClawGatewayProcessEpochBinding,
} from './openclaw-gateway-process-epoch-owner.js';

type ProcessEpochOwnerOptions = Parameters<typeof createOpenClawGatewayProcessEpochOwner>[0];

interface TestHarness {
	readonly beginProcessEpochLoss: Mock<ProcessEpochOwnerOptions['beginProcessEpochLoss']>;
	readonly callOrder: string[];
	readonly connectControlSession: Mock<ProcessEpochOwnerOptions['connectControlSession']>;
	readonly expireSuccessorDeadline: () => void;
	readonly initialBinding: OpenClawGatewayProcessEpochBinding;
	readonly owner: ReturnType<typeof createOpenClawGatewayProcessEpochOwner>;
	readonly persistBinding: Mock<ProcessEpochOwnerOptions['persistBinding']>;
	readonly rollbackPersistedBinding: Mock<
		NonNullable<ProcessEpochOwnerOptions['rollbackPersistedBinding']>
	>;
	readonly setNow: (nowMs: number) => void;
	readonly successorControlSession: GatewayDisposableControlSessionClient;
	readonly successorControlSessionClose: Mock<() => void>;
	readonly supervisorContain: Mock<OpenClawProcessSupervisor['contain']>;
	readonly supervisorObserve: Mock<OpenClawProcessSupervisor['observe']>;
	readonly supervisorStart: Mock<OpenClawProcessSupervisor['start']>;
	readonly waitForServiceHealth: Mock<ProcessEpochOwnerOptions['waitForServiceHealth']>;
}

function createDeferredPromise<TResult>(): {
	readonly promise: Promise<TResult>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TResult | PromiseLike<TResult>) => void;
} {
	let rejectPromise!: (reason?: unknown) => void;
	let resolvePromise!: (value: TResult | PromiseLike<TResult>) => void;
	const promise = new Promise<TResult>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

const GATEWAY = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const INITIAL_PROCESS_SPEC = {
	bootstrapCommand: 'bootstrap-process-1',
	guestListenPort: 18_789,
	healthCheck: { path: '/readyz', port: 18_789, type: 'http' },
	logPath: '/agent-vm/logs/gateway-boot-latest.log',
	serviceHealthCheck: { path: '/health', port: 18_789, type: 'http' },
	startCommand: 'start-process-1',
} satisfies GatewayProcessSpec;

const SUCCESSOR_PROCESS_SPEC = {
	...INITIAL_PROCESS_SPEC,
	bootstrapCommand: 'bootstrap-process-2',
	startCommand: 'start-process-2',
} satisfies GatewayProcessSpec;

function createControlSession(
	label: string,
	callOrder?: string[],
): GatewayDisposableControlSessionClient {
	return {
		close: vi.fn(() => {
			callOrder?.push(`close:${label}`);
		}),
		emitApplicationMessage: vi.fn(async () => ({ ok: true })),
		fenceCurrentSession: vi.fn(() => ({ status: 'not-current' as const })),
		getDiagnostics: vi.fn(() => ({
			accepted: true,
			attachmentGeneration: 1,
			connected: true,
			endpointPath: '/__agent-vm/gateway-control',
			helloCount: 1,
			ready: true,
			reconnectAttempts: 0,
			reconnectExhausted: false,
			transportName: 'websocket',
		})),
		ready: Promise.resolve({
			attachmentGeneration: 1,
			connectionId: `${label}-connection`,
			controllerEpoch: GATEWAY.controllerEpoch,
			outcome: 'accepted',
			sessionId: `${label}-session`,
		}),
	};
}

function createCompletedSupervisorReceipt(options: {
	readonly actionId: string;
	readonly expectedProcessEpoch: string | null;
	readonly kind: 'contain' | 'observe' | 'start';
	readonly processEpoch: string;
}): ReturnType<typeof openClawProcessSupervisorReceiptSchema.parse> {
	return openClawProcessSupervisorReceiptSchema.parse({
		actionId: options.actionId,
		cgroup:
			options.kind === 'contain'
				? {
						emptyObserved: true,
						name: `agent-vm-${options.processEpoch}`,
						populated: false,
					}
				: {
						name: `agent-vm-${options.processEpoch}`,
						populated: true,
					},
		contractVersion: 1,
		expectedProcessEpoch: options.expectedProcessEpoch,
		gateway: {
			controllerEpoch: GATEWAY.controllerEpoch,
			gatewayEpochId: GATEWAY.gatewayEpochId,
			gatewayVmId: GATEWAY.gatewayVmId,
		},
		kind: options.kind,
		observedProcessEpoch: options.processEpoch,
		status: 'completed',
	});
}

function selectSuccessorProcessEpochOnce(processEpoch: string): () => string | undefined {
	let selected = false;
	return () => {
		if (selected) {
			return undefined;
		}
		selected = true;
		return processEpoch;
	};
}

function expectBoundedSuccessorPhaseError(
	error: unknown,
	options: {
		readonly phase:
			| 'control-connect'
			| 'persist-binding'
			| 'positive-observe'
			| 'service-health'
			| 'supervisor-start';
		readonly processEpoch: string;
	},
): Error {
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({
		message: `OpenClaw successor process '${options.processEpoch}' failed during phase '${options.phase}'.`,
	});
	return error as Error;
}

async function createStartReceiptError(options: {
	readonly observedProcessEpoch: string;
	readonly reason: 'helper-failed' | 'process-overlap';
	readonly selectedProcessEpoch: string;
	readonly status: 'incomplete' | 'refused';
}): Promise<unknown> {
	const receipt = openClawProcessSupervisorReceiptSchema.parse({
		actionId: 'start-action',
		cgroup: {
			name: `agent-vm-${options.observedProcessEpoch}`,
			populated: true,
		},
		contractVersion: 1,
		expectedProcessEpoch: null,
		gateway: {
			controllerEpoch: GATEWAY.controllerEpoch,
			gatewayEpochId: GATEWAY.gatewayEpochId,
			gatewayVmId: GATEWAY.gatewayVmId,
		},
		kind: 'start',
		observedProcessEpoch: options.observedProcessEpoch,
		reason: options.reason,
		status: options.status,
	});
	const supervisor = createOpenClawProcessSupervisor({
		gateway: receipt.gateway,
		invokeHelper: async () => receipt,
	});
	return await supervisor
		.start({
			actionId: receipt.actionId,
			expectedProcessEpoch: null,
			selectedProcessEpoch: options.selectedProcessEpoch,
		})
		.catch((error: unknown) => error);
}

function createTestHarness(): TestHarness {
	const callOrder: string[] = [];
	let nowMs = 123_456;
	let successorDeadlineCallback: (() => void) | undefined;
	const initialMaterial = createGatewayControlSessionMaterial({
		agentIds: ['main'],
		bootId: GATEWAY.bootId,
		controllerEpoch: GATEWAY.controllerEpoch,
		generationId: GATEWAY.generationId,
		processEpoch: 'process-1',
		zoneId: GATEWAY.zoneId,
	});
	const initialBinding = {
		controlSession: createControlSession('process-1', callOrder),
		material: initialMaterial,
		processSpec: INITIAL_PROCESS_SPEC,
	} satisfies OpenClawGatewayProcessEpochBinding;
	const publicationOwnerRef: {
		owner?: ReturnType<typeof createOpenClawGatewayProcessEpochOwner>;
	} = {};
	const assertInitialBindingUnpublished = (): void => {
		expect(publicationOwnerRef.owner?.getCurrentBinding()).toBe(initialBinding);
	};
	const successorControlSessionClose = vi.fn(() => {
		callOrder.push('close:process-2');
	});
	const successorControlSession = {
		...createControlSession('process-2', callOrder),
		close: successorControlSessionClose,
	} satisfies GatewayDisposableControlSessionClient;
	const destroyAffectedLeases = vi.fn(async (): Promise<void> => {
		assertInitialBindingUnpublished();
		callOrder.push('destroy-affected-leases');
	});
	const beginProcessEpochLoss = vi.fn(() => {
		assertInitialBindingUnpublished();
		callOrder.push('begin-process-loss');
		return {
			affectedLeaseIds: ['lease-affected'],
			destroyAffectedLeases,
		};
	});
	const supervisorContain = vi.fn<OpenClawProcessSupervisor['contain']>(
		async (request: { readonly actionId: string; readonly expectedProcessEpoch: string }) => {
			assertInitialBindingUnpublished();
			callOrder.push(`contain:${request.expectedProcessEpoch}`);
			return createCompletedSupervisorReceipt({
				actionId: request.actionId,
				expectedProcessEpoch: request.expectedProcessEpoch,
				kind: 'contain',
				processEpoch: request.expectedProcessEpoch,
			});
		},
	);
	const supervisorStart = vi.fn<OpenClawProcessSupervisor['start']>(
		async (request: {
			readonly actionId: string;
			readonly expectedProcessEpoch: string | null;
			readonly selectedProcessEpoch: string;
		}) => {
			assertInitialBindingUnpublished();
			callOrder.push(`start:${request.selectedProcessEpoch}`);
			return createCompletedSupervisorReceipt({
				actionId: request.actionId,
				expectedProcessEpoch: request.expectedProcessEpoch,
				kind: 'start',
				processEpoch: request.selectedProcessEpoch,
			});
		},
	);
	const supervisorObserve = vi.fn<OpenClawProcessSupervisor['observe']>(
		async (request: {
			readonly actionId: string;
			readonly expectedProcessEpoch: string | null;
		}) => {
			assertInitialBindingUnpublished();
			if (request.expectedProcessEpoch === null) {
				throw new Error('test observe requires an exact process epoch');
			}
			callOrder.push(`observe:${request.expectedProcessEpoch}`);
			return createCompletedSupervisorReceipt({
				actionId: request.actionId,
				expectedProcessEpoch: request.expectedProcessEpoch,
				kind: 'observe',
				processEpoch: request.expectedProcessEpoch,
			});
		},
	);
	const supervisor = {
		contain: supervisorContain,
		observe: supervisorObserve,
		start: supervisorStart,
	} satisfies OpenClawProcessSupervisor;
	const prepareProcess = vi.fn(async (_material: GatewayControlSessionMaterial) => {
		assertInitialBindingUnpublished();
		callOrder.push('prepare-process');
		return SUCCESSOR_PROCESS_SPEC;
	});
	const waitForServiceHealth = vi.fn(async (): Promise<void> => {
		assertInitialBindingUnpublished();
		callOrder.push('wait-service-health');
	});
	const connectControlSession = vi.fn(async (_material: GatewayControlSessionMaterial) => {
		assertInitialBindingUnpublished();
		callOrder.push('connect-control-session');
		return successorControlSession;
	});
	const persistBinding = vi.fn(async (): Promise<void> => {
		assertInitialBindingUnpublished();
		callOrder.push('persist-binding');
	});
	const rollbackPersistedBinding = vi.fn(async (): Promise<void> => {
		assertInitialBindingUnpublished();
		callOrder.push('rollback-persisted-binding');
	});
	const owner = createOpenClawGatewayProcessEpochOwner({
		beginProcessEpochLoss,
		connectControlSession,
		createActionId: (kind) => `${kind}-action`,
		gateway: GATEWAY,
		initialBinding,
		now: () => nowMs,
		persistBinding,
		prepareProcess,
		rollbackPersistedBinding,
		scheduleSuccessorDeadline: (callback) => {
			successorDeadlineCallback = callback;
			return { cancel: () => undefined };
		},
		supervisor,
		waitForServiceHealth,
	});
	publicationOwnerRef.owner = owner;

	return {
		beginProcessEpochLoss,
		callOrder,
		connectControlSession,
		expireSuccessorDeadline: () => {
			nowMs = 168_457;
			successorDeadlineCallback?.();
		},
		initialBinding,
		owner,
		persistBinding,
		rollbackPersistedBinding,
		setNow: (nextNowMs) => {
			nowMs = nextNowMs;
		},
		successorControlSession,
		successorControlSessionClose,
		supervisorContain,
		supervisorObserve,
		supervisorStart,
		waitForServiceHealth,
	};
}

describe('createOpenClawGatewayProcessEpochOwner', () => {
	it('publishes P2 atomically after the exact containment, preparation, health, and control order', async () => {
		const harness = createTestHarness();

		const successor = await harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});

		expect(harness.callOrder).toEqual([
			'begin-process-loss',
			'close:process-1',
			'contain:process-1',
			'destroy-affected-leases',
			'prepare-process',
			'start:process-2',
			'observe:process-2',
			'wait-service-health',
			'connect-control-session',
			'persist-binding',
		]);
		expect(harness.owner.getCurrentBinding()).toBe(successor);
		expect(successor).toEqual({
			controlSession: harness.successorControlSession,
			material: expect.objectContaining({ processEpoch: 'process-2' }),
			processSpec: SUCCESSOR_PROCESS_SPEC,
		});
	});

	it('preserves exact G-scoped material while changing only processEpoch', async () => {
		const harness = createTestHarness();
		const previousMaterial = harness.initialBinding.material;

		const successor = await harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});

		expect(successor.material).toEqual({ ...previousMaterial, processEpoch: 'process-2' });
		expect(successor.material.privateKey).toBe(previousMaterial.privateKey);
		expect(successor.material.agentAuthorityKeys).toBe(previousMaterial.agentAuthorityKeys);
		expect(successor.material.callerContextProofKey).toBe(previousMaterial.callerContextProofKey);
		expect(successor.material.verifierPublicKeyPem).toBe(previousMaterial.verifierPublicKeyPem);
	});

	it('rejects a stale expected P before any side effect', async () => {
		const harness = createTestHarness();

		await expect(
			harness.owner.replaceCurrentProcess({
				expectedProcessEpoch: 'process-stale',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			}),
		).rejects.toThrow("expected 'process-stale' but current is 'process-1'");

		expect(harness.callOrder).toEqual([]);
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('joins concurrent replacements into one exact replacement flight', async () => {
		const harness = createTestHarness();
		let releaseContainment!: () => void;
		const containmentGate = new Promise<void>((resolve) => {
			releaseContainment = resolve;
		});
		harness.supervisorContain.mockImplementationOnce(async (request) => {
			harness.callOrder.push(`contain:${request.expectedProcessEpoch}`);
			await containmentGate;
			return createCompletedSupervisorReceipt({
				actionId: request.actionId,
				expectedProcessEpoch: request.expectedProcessEpoch,
				kind: 'contain',
				processEpoch: request.expectedProcessEpoch,
			});
		});
		const replacement = {
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		};

		const firstRequest = harness.owner.replaceCurrentProcess(replacement);
		const joinedRequest = harness.owner.replaceCurrentProcess(replacement);

		expect(joinedRequest).toBe(firstRequest);
		expect(harness.beginProcessEpochLoss).toHaveBeenCalledOnce();
		releaseContainment();
		await expect(firstRequest).resolves.toMatchObject({
			material: { processEpoch: 'process-2' },
		});
		expect(harness.supervisorStart).toHaveBeenCalledOnce();
	});

	it('contains exact P2 when start dispatch rejects after the successor may exist', async () => {
		const harness = createTestHarness();
		const startError = new Error('start dispatch timed out after launch');
		harness.supervisorStart.mockRejectedValueOnce(startError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'supervisor-start',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toBe(startError);

		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('does not contain P2 after a typed refused start proves a different process overlapped', async () => {
		const harness = createTestHarness();
		const startReceiptError = await createStartReceiptError({
			observedProcessEpoch: 'process-existing',
			reason: 'process-overlap',
			selectedProcessEpoch: 'process-2',
			status: 'refused',
		});
		harness.supervisorStart.mockRejectedValueOnce(startReceiptError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);

		expect(replacementError).toMatchObject({
			message:
				"OpenClaw successor process 'process-2' failed during phase 'supervisor-start:process-overlap'.",
		});
		expect((replacementError as Error).message).not.toContain('process-existing');
		expect(harness.supervisorContain).toHaveBeenCalledTimes(1);
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(1, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-1',
		});
		expect(harness.supervisorObserve).not.toHaveBeenCalled();
	});

	it('contains P2 after a typed incomplete start receipt leaves launch ambiguous', async () => {
		const harness = createTestHarness();
		const startReceiptError = await createStartReceiptError({
			observedProcessEpoch: 'process-2',
			reason: 'helper-failed',
			selectedProcessEpoch: 'process-2',
			status: 'incomplete',
		});
		harness.supervisorStart.mockRejectedValueOnce(startReceiptError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);

		expect(replacementError).toMatchObject({
			message:
				"OpenClaw successor process 'process-2' failed during phase 'supervisor-start:helper-failed'.",
		});
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.supervisorObserve).not.toHaveBeenCalled();
	});

	it.each([
		'helper-timeout',
		'helper-exit',
		'helper-lock-contended',
		'helper-execution',
		'receipt-invalid',
	] as const)(
		'contains P2 and reports only the bounded %s invocation code for an ambiguous start',
		async (invocationCode) => {
			const harness = createTestHarness();
			const rawInvocationPayload = `private helper payload at /raw/${invocationCode}`;
			const invocationError = new OpenClawProcessSupervisorInvocationError(invocationCode, {
				cause: new Error(rawInvocationPayload),
			});
			harness.supervisorStart.mockRejectedValueOnce(invocationError);

			const replacementError = await harness.owner
				.replaceCurrentProcess({
					expectedProcessEpoch: 'process-1',
					selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
				})
				.catch((error: unknown) => error);

			expect(replacementError).toMatchObject({
				message: `OpenClaw successor process 'process-2' failed during phase 'supervisor-start:${invocationCode}'.`,
			});
			expect((replacementError as Error).message).not.toContain(rawInvocationPayload);
			expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
				actionId: 'contain-action',
				expectedProcessEpoch: 'process-2',
			});
			expect(harness.supervisorObserve).not.toHaveBeenCalled();
		},
	);

	it('expires during successor observation without starting later readiness work', async () => {
		const harness = createTestHarness();
		const observation =
			createDeferredPromise<Awaited<ReturnType<OpenClawProcessSupervisor['observe']>>>();
		const observationStarted = createDeferredPromise<void>();
		harness.supervisorObserve.mockImplementationOnce(async (_request) => {
			observationStarted.resolve();
			return await observation.promise;
		});

		const replacement = harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});
		await observationStarted.promise;
		harness.expireSuccessorDeadline();
		observation.resolve(
			createCompletedSupervisorReceipt({
				actionId: 'observe-action',
				expectedProcessEpoch: 'process-2',
				kind: 'observe',
				processEpoch: 'process-2',
			}),
		);

		const replacementError = await replacement.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'positive-observe',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message: "OpenClaw successor process 'process-2' exceeded its 45000ms phase deadline.",
		});
		expect(harness.waitForServiceHealth).not.toHaveBeenCalled();
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
	});

	it('expires during successor health without connecting S2', async () => {
		const harness = createTestHarness();
		const health = createDeferredPromise<void>();
		const healthStarted = createDeferredPromise<void>();
		harness.waitForServiceHealth.mockImplementationOnce(async () => {
			healthStarted.resolve();
			await health.promise;
		});

		const replacement = harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});
		await healthStarted.promise;
		harness.expireSuccessorDeadline();
		health.resolve();

		const replacementError = await replacement.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'service-health',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message: expect.stringContaining('exceeded its 45000ms phase deadline'),
		});
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
	});

	it('aborts a never-settling service-health phase at the successor deadline and begins containment', async () => {
		const harness = createTestHarness();
		const healthStarted = createDeferredPromise<void>();
		let serviceHealthAbortSignal: AbortSignal | undefined;
		harness.waitForServiceHealth.mockImplementationOnce(
			(...healthArguments: Parameters<ProcessEpochOwnerOptions['waitForServiceHealth']>) => {
				healthStarted.resolve();
				serviceHealthAbortSignal = (
					healthArguments as unknown as readonly [
						GatewayProcessSpec,
						{ readonly signal?: AbortSignal }?,
					]
				)[1]?.signal;
				if (serviceHealthAbortSignal === undefined) {
					return Promise.reject(new Error('missing service-health abort signal'));
				}
				return new Promise<void>((_resolve, reject) => {
					serviceHealthAbortSignal?.addEventListener(
						'abort',
						() => reject(serviceHealthAbortSignal?.reason),
						{ once: true },
					);
				});
			},
		);

		const replacement = harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});
		await healthStarted.promise;
		expect(harness.supervisorContain).toHaveBeenCalledTimes(1);

		harness.expireSuccessorDeadline();
		const replacementError = await replacement.catch((error: unknown) => error);

		expect(serviceHealthAbortSignal).toBeInstanceOf(AbortSignal);
		expect(serviceHealthAbortSignal?.aborted).toBe(true);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'service-health',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message: "OpenClaw successor process 'process-2' exceeded its 45000ms phase deadline.",
		});
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('closes a late S2 before containment when connect resolves after expiry', async () => {
		const harness = createTestHarness();
		const connection = createDeferredPromise<GatewayDisposableControlSessionClient>();
		const connectionStarted = createDeferredPromise<void>();
		harness.connectControlSession.mockImplementationOnce(async () => {
			connectionStarted.resolve();
			return await connection.promise;
		});

		const replacement = harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});
		await connectionStarted.promise;
		harness.expireSuccessorDeadline();
		connection.resolve(harness.successorControlSession);

		const replacementError = await replacement.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'control-connect',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message: expect.stringContaining('exceeded its 45000ms phase deadline'),
		});
		expect(harness.callOrder.indexOf('close:process-2')).toBeLessThan(
			harness.callOrder.lastIndexOf('contain:process-2'),
		);
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('rolls back late successful persistence before containment on expiry', async () => {
		const harness = createTestHarness();
		const persistence = createDeferredPromise<void>();
		const persistenceStarted = createDeferredPromise<void>();
		harness.persistBinding.mockImplementationOnce(async () => {
			persistenceStarted.resolve();
			await persistence.promise;
		});

		const replacement = harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});
		await persistenceStarted.promise;
		harness.expireSuccessorDeadline();
		persistence.resolve();

		const replacementError = await replacement.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'persist-binding',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message: expect.stringContaining('exceeded its 45000ms phase deadline'),
		});
		expect(harness.callOrder).toContain('rollback-persisted-binding');
		expect(harness.callOrder.indexOf('rollback-persisted-binding')).toBeLessThan(
			harness.callOrder.indexOf('close:process-2'),
		);
		expect(harness.callOrder.indexOf('close:process-2')).toBeLessThan(
			harness.callOrder.lastIndexOf('contain:process-2'),
		);
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('publishes exactly once when the successor completes at the deadline boundary', async () => {
		const harness = createTestHarness();
		harness.persistBinding.mockImplementationOnce(async () => {
			harness.setNow(168_456);
		});

		const successor = await harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
		});

		expect(successor.material.processEpoch).toBe('process-2');
		expect(harness.owner.getCurrentBinding()).toBe(successor);
		expect(harness.persistBinding).toHaveBeenCalledOnce();
		expect(harness.rollbackPersistedBinding).not.toHaveBeenCalled();
		expect(harness.supervisorContain).toHaveBeenCalledOnce();
	});

	it('positively contains a started successor when successor readiness fails', async () => {
		const harness = createTestHarness();
		const readinessError = new Error('successor service health failed');
		harness.waitForServiceHealth.mockRejectedValueOnce(readinessError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'service-health',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toBe(readinessError);

		expect(harness.supervisorContain).toHaveBeenNthCalledWith(1, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-1',
		});
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('positively contains a successor when start dispatch rejects after the process may exist', async () => {
		const harness = createTestHarness();
		const startError = new Error('successor start receipt timed out after launch');
		harness.supervisorStart.mockRejectedValueOnce(startError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'supervisor-start',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toBe(startError);

		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.supervisorObserve).not.toHaveBeenCalled();
		expect(harness.waitForServiceHealth).not.toHaveBeenCalled();
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('rejects an unpopulated exact successor observation before health or control connection', async () => {
		const harness = createTestHarness();
		harness.supervisorObserve.mockImplementationOnce(async (request) => {
			if (request.expectedProcessEpoch === null) {
				throw new Error('test observe requires an exact process epoch');
			}
			harness.callOrder.push(`observe:${request.expectedProcessEpoch}`);
			return openClawProcessSupervisorReceiptSchema.parse({
				...createCompletedSupervisorReceipt({
					actionId: request.actionId,
					expectedProcessEpoch: request.expectedProcessEpoch,
					kind: 'observe',
					processEpoch: request.expectedProcessEpoch,
				}),
				cgroup: {
					name: `agent-vm-${request.expectedProcessEpoch}`,
					populated: false,
				},
			});
		});

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'positive-observe',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toMatchObject({
			message:
				"OpenClaw successor process 'process-2' was not positively observed in its exact cgroup.",
		});

		expect(harness.waitForServiceHealth).not.toHaveBeenCalled();
		expect(harness.connectControlSession).not.toHaveBeenCalled();
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('closes provisional S2 before containing P2 when persistence fails', async () => {
		const harness = createTestHarness();
		const persistenceError = new Error('successor binding persistence failed');
		harness.persistBinding.mockRejectedValueOnce(persistenceError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'persist-binding',
			processEpoch: 'process-2',
		});
		expect((replacementError as Error).cause).toBe(persistenceError);

		expect(harness.callOrder).toContain('close:process-2');
		expect(harness.callOrder.indexOf('close:process-2')).toBeLessThan(
			harness.callOrder.lastIndexOf('contain:process-2'),
		);
		expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
			actionId: 'contain-action',
			expectedProcessEpoch: 'process-2',
		});
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it.each([
		'supervisor-start',
		'positive-observe',
		'service-health',
		'control-connect',
		'persist-binding',
	] as const)(
		'reports the bounded %s phase without exposing the underlying failure payload',
		async (failurePhase) => {
			const harness = createTestHarness();
			const arbitraryFailurePayload = `private upstream payload for ${failurePhase}`;
			if (failurePhase === 'supervisor-start') {
				harness.supervisorStart.mockRejectedValueOnce(new Error(arbitraryFailurePayload));
			} else if (failurePhase === 'positive-observe') {
				harness.supervisorObserve.mockImplementationOnce(async (request) => {
					if (request.expectedProcessEpoch === null) {
						throw new Error('test observe requires an exact process epoch');
					}
					return openClawProcessSupervisorReceiptSchema.parse({
						...createCompletedSupervisorReceipt({
							actionId: request.actionId,
							expectedProcessEpoch: request.expectedProcessEpoch,
							kind: 'observe',
							processEpoch: request.expectedProcessEpoch,
						}),
						cgroup: {
							name: `agent-vm-${request.expectedProcessEpoch}`,
							populated: false,
						},
					});
				});
			} else if (failurePhase === 'service-health') {
				harness.waitForServiceHealth.mockRejectedValueOnce(new Error(arbitraryFailurePayload));
			} else if (failurePhase === 'control-connect') {
				harness.connectControlSession.mockRejectedValueOnce(new Error(arbitraryFailurePayload));
			} else {
				harness.persistBinding.mockRejectedValueOnce(new Error(arbitraryFailurePayload));
			}

			const replacementError = await harness.owner
				.replaceCurrentProcess({
					expectedProcessEpoch: 'process-1',
					selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
				})
				.catch((error: unknown) => error);

			expect(replacementError).toBeInstanceOf(Error);
			expect(replacementError).toMatchObject({
				message: `OpenClaw successor process 'process-2' failed during phase '${failurePhase}'.`,
			});
			expect((replacementError as Error).message).not.toContain(arbitraryFailurePayload);
		},
	);

	it('aggregates successor failure with unproven successor containment', async () => {
		const harness = createTestHarness();
		const readinessError = new Error('private service-health failure payload');
		const containmentError = new Error('private containment failure payload');
		harness.waitForServiceHealth.mockRejectedValueOnce(readinessError);
		harness.supervisorContain.mockResolvedValueOnce(
			createCompletedSupervisorReceipt({
				actionId: 'contain-action',
				expectedProcessEpoch: 'process-1',
				kind: 'contain',
				processEpoch: 'process-1',
			}),
		);
		harness.supervisorContain.mockRejectedValueOnce(containmentError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch: selectSuccessorProcessEpochOnce('process-2'),
			})
			.catch((error: unknown) => error);

		expect(replacementError).toBeInstanceOf(AggregateError);
		expect(replacementError).toMatchObject({
			errors: [readinessError, containmentError],
			message:
				"OpenClaw successor process 'process-2' failed during phase 'service-health' and containment was not proven.",
		});
		expect((replacementError as AggregateError).message).not.toContain(readinessError.message);
		expect((replacementError as AggregateError).message).not.toContain(containmentError.message);
		expect(harness.persistBinding).not.toHaveBeenCalled();
		expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
	});

	it('tries P3 after P2 fails and is positively contained without repeating P1 loss', async () => {
		const harness = createTestHarness();
		const p2ReadinessError = new Error('P2 service health failed');
		const selectSuccessorProcessEpoch = vi
			.fn<() => string | undefined>()
			.mockReturnValueOnce('process-2')
			.mockReturnValueOnce('process-3');
		harness.waitForServiceHealth.mockRejectedValueOnce(p2ReadinessError);

		const successor = await harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch,
		});

		expect(successor.material.processEpoch).toBe('process-3');
		expect(selectSuccessorProcessEpoch).toHaveBeenCalledTimes(2);
		expect(harness.beginProcessEpochLoss).toHaveBeenCalledOnce();
		expect(harness.callOrder.filter((call) => call === 'destroy-affected-leases')).toHaveLength(1);
		expect(
			harness.supervisorContain.mock.calls.map(([request]) => request.expectedProcessEpoch),
		).toEqual(['process-1', 'process-2']);
		expect(
			harness.supervisorStart.mock.calls.map(([request]) => request.selectedProcessEpoch),
		).toEqual(['process-2', 'process-3']);
	});

	it('tries P4 after P2 and P3 each fail and are positively contained', async () => {
		const harness = createTestHarness();
		const selectSuccessorProcessEpoch = vi
			.fn<() => string | undefined>()
			.mockReturnValueOnce('process-2')
			.mockReturnValueOnce('process-3')
			.mockReturnValueOnce('process-4');
		harness.waitForServiceHealth
			.mockRejectedValueOnce(new Error('P2 service health failed'))
			.mockRejectedValueOnce(new Error('P3 service health failed'));

		const successor = await harness.owner.replaceCurrentProcess({
			expectedProcessEpoch: 'process-1',
			selectSuccessorProcessEpoch,
		});

		expect(successor.material.processEpoch).toBe('process-4');
		expect(selectSuccessorProcessEpoch).toHaveBeenCalledTimes(3);
		expect(harness.beginProcessEpochLoss).toHaveBeenCalledOnce();
		expect(
			harness.supervisorContain.mock.calls.map(([request]) => request.expectedProcessEpoch),
		).toEqual(['process-1', 'process-2', 'process-3']);
		expect(
			harness.supervisorStart.mock.calls.map(([request]) => request.selectedProcessEpoch),
		).toEqual(['process-2', 'process-3', 'process-4']);
	});

	it('returns outward after three positively contained successor failures exhaust selection', async () => {
		const harness = createTestHarness();
		const p4ReadinessError = new Error('P4 service health failed');
		const selectSuccessorProcessEpoch = vi
			.fn<() => string | undefined>()
			.mockReturnValueOnce('process-2')
			.mockReturnValueOnce('process-3')
			.mockReturnValueOnce('process-4');
		harness.waitForServiceHealth
			.mockRejectedValueOnce(new Error('P2 service health failed'))
			.mockRejectedValueOnce(new Error('P3 service health failed'))
			.mockRejectedValueOnce(p4ReadinessError);

		const replacementError = await harness.owner
			.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch,
			})
			.catch((error: unknown) => error);
		expectBoundedSuccessorPhaseError(replacementError, {
			phase: 'service-health',
			processEpoch: 'process-4',
		});
		expect((replacementError as Error).cause).toBe(p4ReadinessError);

		expect(selectSuccessorProcessEpoch).toHaveBeenCalledTimes(3);
		expect(harness.beginProcessEpochLoss).toHaveBeenCalledOnce();
		expect(
			harness.supervisorContain.mock.calls.map(([request]) => request.expectedProcessEpoch),
		).toEqual(['process-1', 'process-2', 'process-3', 'process-4']);
		expect(
			harness.supervisorStart.mock.calls.map(([request]) => request.selectedProcessEpoch),
		).toEqual(['process-2', 'process-3', 'process-4']);
		expect(harness.persistBinding).not.toHaveBeenCalled();
	});

	it('stops successor selection immediately when failed P2 containment is not proven', async () => {
		const harness = createTestHarness();
		const containmentError = new Error('P2 cgroup empty was not proven');
		const selectSuccessorProcessEpoch = vi
			.fn<() => string | undefined>()
			.mockReturnValueOnce('process-2')
			.mockReturnValueOnce('process-3');
		harness.waitForServiceHealth.mockRejectedValueOnce(new Error('P2 service health failed'));
		harness.supervisorContain.mockResolvedValueOnce(
			createCompletedSupervisorReceipt({
				actionId: 'contain-action',
				expectedProcessEpoch: 'process-1',
				kind: 'contain',
				processEpoch: 'process-1',
			}),
		);
		harness.supervisorContain.mockRejectedValueOnce(containmentError);

		await expect(
			harness.owner.replaceCurrentProcess({
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch,
			}),
		).rejects.toThrow('containment was not proven');

		expect(selectSuccessorProcessEpoch).toHaveBeenCalledOnce();
		expect(harness.supervisorStart).toHaveBeenCalledOnce();
		expect(harness.supervisorStart).toHaveBeenCalledWith({
			actionId: 'start-action',
			expectedProcessEpoch: null,
			selectedProcessEpoch: 'process-2',
		});
	});

	it('stops successor selection immediately when a late persisted P2 binding cannot roll back', async () => {
		const harness = createTestHarness();
		const recoveryActionAbortController = new AbortController();
		const rollbackError = new Error('P2 durable binding rollback failed');
		const selectSuccessorProcessEpoch = vi
			.fn<() => string | undefined>()
			.mockReturnValueOnce('process-2')
			.mockReturnValueOnce('process-3');
		harness.persistBinding.mockImplementationOnce(async () => {
			recoveryActionAbortController.abort(new Error('process recovery action expired'));
		});
		harness.rollbackPersistedBinding.mockRejectedValueOnce(rollbackError);

		await expect(
			harness.owner.replaceCurrentProcess({
				action: { signal: recoveryActionAbortController.signal },
				expectedProcessEpoch: 'process-1',
				selectSuccessorProcessEpoch,
			}),
		).rejects.toThrow('previous durable binding was not restored');

		expect(selectSuccessorProcessEpoch).toHaveBeenCalledOnce();
		expect(harness.rollbackPersistedBinding).toHaveBeenCalledOnce();
		expect(harness.supervisorStart).toHaveBeenCalledOnce();
	});

	it.each([
		['with proven containment', false],
		['with unproven containment', true],
	] as const)(
		'contains exact P2 and stops before P3 when provisional S2 close throws %s',
		async (_label, containmentFails) => {
			const harness = createTestHarness();
			const readinessError = new Error('successor readiness expired after S2 connected');
			const closeError = new Error('provisional S2 close failed');
			const containmentError = new Error('P2 cgroup empty was not proven');
			const recoveryActionAbortController = new AbortController();
			const selectSuccessorProcessEpoch = vi
				.fn<() => string | undefined>()
				.mockReturnValueOnce('process-2')
				.mockReturnValueOnce('process-3');
			harness.persistBinding.mockImplementationOnce(async () => {
				recoveryActionAbortController.abort(readinessError);
			});
			harness.successorControlSessionClose.mockImplementationOnce(() => {
				throw closeError;
			});
			if (containmentFails) {
				harness.supervisorContain.mockResolvedValueOnce(
					createCompletedSupervisorReceipt({
						actionId: 'contain-action',
						expectedProcessEpoch: 'process-1',
						kind: 'contain',
						processEpoch: 'process-1',
					}),
				);
				harness.supervisorContain.mockRejectedValueOnce(containmentError);
			}

			const replacementError = await harness.owner
				.replaceCurrentProcess({
					action: { signal: recoveryActionAbortController.signal },
					expectedProcessEpoch: 'process-1',
					selectSuccessorProcessEpoch,
				})
				.catch((error: unknown) => error);

			expect(replacementError).toBeInstanceOf(AggregateError);
			expect(replacementError).toMatchObject({
				errors: containmentFails
					? [readinessError, closeError, containmentError]
					: [readinessError, closeError],
			});
			expect(selectSuccessorProcessEpoch).toHaveBeenCalledOnce();
			expect(harness.supervisorContain).toHaveBeenNthCalledWith(2, {
				actionId: 'contain-action',
				expectedProcessEpoch: 'process-2',
			});
			expect(harness.supervisorStart).toHaveBeenCalledOnce();
			expect(harness.owner.getCurrentBinding()).toBe(harness.initialBinding);
		},
	);
});
