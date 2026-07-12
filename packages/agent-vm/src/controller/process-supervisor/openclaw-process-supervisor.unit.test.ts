import { describe, expect, it, vi } from 'vitest';

import {
	openClawProcessSupervisorRequestSchema,
	openClawProcessSupervisorReceiptSchema,
	type OpenClawProcessSupervisorReceipt,
} from './openclaw-process-supervisor-contracts.js';
import {
	createOpenClawProcessSupervisor,
	createOpenClawProcessSupervisorPorts,
} from './openclaw-process-supervisor.js';

const gateway = {
	controllerEpoch: 'controller-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
} as const;

function completedReceipt(options: {
	readonly actionId: string;
	readonly expectedProcessEpoch: string | null;
	readonly kind: 'contain' | 'observe' | 'start';
	readonly processEpoch: string | null;
}): OpenClawProcessSupervisorReceipt {
	return openClawProcessSupervisorReceiptSchema.parse({
		actionId: options.actionId,
		cgroup:
			options.kind === 'contain'
				? {
						emptyObserved: true,
						name: `agent-vm-${options.expectedProcessEpoch}`,
						populated: false,
					}
				: {
						name: options.processEpoch === null ? null : `agent-vm-${options.processEpoch}`,
						populated: options.processEpoch !== null,
					},
		contractVersion: 1,
		expectedProcessEpoch: options.expectedProcessEpoch,
		gateway,
		kind: options.kind,
		observedProcessEpoch:
			options.kind === 'contain' ? options.expectedProcessEpoch : options.processEpoch,
		status: 'completed',
	});
}

describe('OpenClaw process supervisor contracts', () => {
	it('accepts only the exact typed reliability-test termination request and completed receipt', () => {
		const request = openClawProcessSupervisorRequestSchema.parse({
			actionId: 'action-reliability-terminate-1',
			contractVersion: 1,
			expectedProcessEpoch: 'process-1',
			gateway,
			kind: 'terminate-for-reliability-test',
		});

		expect(request).toEqual({
			actionId: 'action-reliability-terminate-1',
			contractVersion: 1,
			expectedProcessEpoch: 'process-1',
			gateway,
			kind: 'terminate-for-reliability-test',
		});
		expect(
			openClawProcessSupervisorReceiptSchema.parse({
				actionId: request.actionId,
				cgroup: {
					emptyObserved: true,
					name: 'agent-vm-process-1',
					populated: false,
				},
				contractVersion: 1,
				expectedProcessEpoch: 'process-1',
				gateway,
				kind: 'terminate-for-reliability-test',
				observedProcessEpoch: 'process-1',
				status: 'completed',
			}),
		).toMatchObject({
			expectedProcessEpoch: 'process-1',
			kind: 'terminate-for-reliability-test',
			observedProcessEpoch: 'process-1',
		});

		for (const unsafeField of [
			{ pid: 1234 },
			{ signal: 'SIGKILL' },
			{ command: 'kill -9 1234' },
			{ cgroupPath: '/sys/fs/cgroup/untrusted' },
		]) {
			expect(() =>
				openClawProcessSupervisorRequestSchema.parse({
					actionId: 'action-reliability-terminate-unsafe',
					contractVersion: 1,
					expectedProcessEpoch: 'process-1',
					gateway,
					kind: 'terminate-for-reliability-test',
					...unsafeField,
				}),
			).toThrow();
		}
	});

	it.each([
		['mismatched process epoch', 'process-2', true, false],
		['missing positive empty observation', 'process-1', false, false],
		['still-populated cgroup', 'process-1', true, true],
	] as const)(
		'rejects a completed reliability-test termination receipt with %s',
		(_label, observedProcessEpoch, emptyObserved, populated) => {
			expect(() =>
				openClawProcessSupervisorReceiptSchema.parse({
					actionId: 'action-reliability-terminate-invalid',
					cgroup: {
						...(emptyObserved ? { emptyObserved: true } : {}),
						name: 'agent-vm-process-1',
						populated,
					},
					contractVersion: 1,
					expectedProcessEpoch: 'process-1',
					gateway,
					kind: 'terminate-for-reliability-test',
					observedProcessEpoch,
					status: 'completed',
				}),
			).toThrow();
		},
	);

	it('rejects raw commands and requests without exact Gateway and process fences', () => {
		expect(() =>
			openClawProcessSupervisorRequestSchema.parse({
				actionId: 'action-1',
				command: 'kill -9 -1',
				contractVersion: 1,
				expectedProcessEpoch: null,
				gateway,
				kind: 'observe',
			}),
		).toThrow();
		expect(() =>
			openClawProcessSupervisorRequestSchema.parse({
				actionId: 'action-1',
				contractVersion: 1,
				expectedProcessEpoch: null,
				kind: 'observe',
			}),
		).toThrow();
	});

	it('requires positive cgroup-empty evidence for completed containment', () => {
		expect(() =>
			openClawProcessSupervisorReceiptSchema.parse({
				actionId: 'action-contain',
				cgroup: { name: 'agent-vm-process-1', populated: false },
				contractVersion: 1,
				expectedProcessEpoch: 'process-1',
				gateway,
				kind: 'contain',
				observedProcessEpoch: null,
				status: 'completed',
			}),
		).toThrow();
	});

	it('rejects completed start and observe receipts without coherent exact process evidence', () => {
		expect(() =>
			openClawProcessSupervisorReceiptSchema.parse({
				actionId: 'action-start',
				cgroup: { name: null, populated: true },
				contractVersion: 1,
				expectedProcessEpoch: null,
				gateway,
				kind: 'start',
				observedProcessEpoch: 'process-1',
				status: 'completed',
			}),
		).toThrow();
		expect(() =>
			openClawProcessSupervisorReceiptSchema.parse({
				actionId: 'action-observe',
				cgroup: { name: 'agent-vm-process-1', populated: false },
				contractVersion: 1,
				expectedProcessEpoch: 'process-1',
				gateway,
				kind: 'observe',
				observedProcessEpoch: 'process-2',
				status: 'completed',
			}),
		).toThrow();
	});
});

describe('createOpenClawProcessSupervisor', () => {
	it('throws a typed error that retains the validated non-completed receipt', async () => {
		const refusedReceipt = openClawProcessSupervisorReceiptSchema.parse({
			actionId: 'action-start-refused',
			cgroup: {
				name: 'agent-vm-process-existing',
				populated: true,
			},
			contractVersion: 1,
			expectedProcessEpoch: null,
			gateway,
			kind: 'start',
			observedProcessEpoch: 'process-existing',
			reason: 'process-overlap',
			status: 'refused',
		});
		const supervisor = createOpenClawProcessSupervisor({
			gateway,
			invokeHelper: async () => refusedReceipt,
		});

		const receiptError = await supervisor
			.start({
				actionId: refusedReceipt.actionId,
				expectedProcessEpoch: null,
				selectedProcessEpoch: 'process-selected',
			})
			.catch((error: unknown) => error);

		expect(receiptError).toBeInstanceOf(Error);
		expect(receiptError).toMatchObject({
			message: 'OpenClaw process supervisor start was refused: process-overlap.',
			name: 'OpenClawProcessSupervisorReceiptError',
			receipt: refusedReceipt,
		});
		expect((receiptError as { readonly receipt: unknown }).receipt).toStrictEqual(refusedReceipt);
	});

	it('serializes reliability-test termination with normal supervisor operations', async () => {
		let releaseObservation: (() => void) | undefined;
		const observationMayFinish = new Promise<void>((resolve) => {
			releaseObservation = resolve;
		});
		const invokeHelper = vi.fn(async (request) => {
			if (request.kind === 'observe') {
				await observationMayFinish;
				return completedReceipt({
					actionId: request.actionId,
					expectedProcessEpoch: request.expectedProcessEpoch,
					kind: 'observe',
					processEpoch: request.expectedProcessEpoch,
				});
			}
			return openClawProcessSupervisorReceiptSchema.parse({
				actionId: request.actionId,
				cgroup: {
					emptyObserved: true,
					name: `agent-vm-${request.expectedProcessEpoch}`,
					populated: false,
				},
				contractVersion: 1,
				expectedProcessEpoch: request.expectedProcessEpoch,
				gateway,
				kind: 'terminate-for-reliability-test',
				observedProcessEpoch: request.expectedProcessEpoch,
				status: 'completed',
			});
		});
		const { reliabilityFaultActuator, supervisor } = createOpenClawProcessSupervisorPorts({
			gateway,
			invokeHelper,
		});

		const observation = supervisor.observe({
			actionId: 'action-observe-before-terminate',
			expectedProcessEpoch: 'process-1',
		});
		const termination = reliabilityFaultActuator.terminateOwnedProcess({
			actionId: 'action-reliability-terminate-1',
			expectedProcessEpoch: 'process-1',
		});
		await vi.waitFor(() => expect(invokeHelper).toHaveBeenCalledOnce());
		expect(invokeHelper).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'observe' }));

		releaseObservation?.();
		await expect(observation).resolves.toMatchObject({ kind: 'observe' });
		await expect(termination).resolves.toMatchObject({
			expectedProcessEpoch: 'process-1',
			kind: 'terminate-for-reliability-test',
			observedProcessEpoch: 'process-1',
		});
		expect(invokeHelper).toHaveBeenNthCalledWith(2, {
			actionId: 'action-reliability-terminate-1',
			contractVersion: 1,
			expectedProcessEpoch: 'process-1',
			gateway,
			kind: 'terminate-for-reliability-test',
		});
	});

	it('rejects a completed start receipt for a different controller-selected process epoch', async () => {
		const supervisor = createOpenClawProcessSupervisor({
			gateway,
			invokeHelper: async (request) =>
				completedReceipt({
					actionId: request.actionId,
					expectedProcessEpoch: request.expectedProcessEpoch,
					kind: 'start',
					processEpoch: 'process-wrong',
				}),
		});

		await expect(
			supervisor.start({
				actionId: 'action-start',
				expectedProcessEpoch: null,
				selectedProcessEpoch: 'process-selected',
			}),
		).rejects.toThrow(/selected process epoch/iu);
	});

	it('serializes operations and rejects a receipt that changes the exact action fence', async () => {
		let markFirstInvoked: (() => void) | undefined;
		const firstInvoked = new Promise<void>((resolve) => {
			markFirstInvoked = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const invokeHelper = vi.fn(async (request) => {
			calls += 1;
			if (calls === 1) {
				markFirstInvoked?.();
				await firstMayFinish;
			}
			return completedReceipt({
				actionId: calls === 2 ? 'wrong-action' : request.actionId,
				expectedProcessEpoch: request.expectedProcessEpoch,
				kind: request.kind,
				processEpoch: request.kind === 'start' ? request.selectedProcessEpoch : null,
			});
		});
		const supervisor = createOpenClawProcessSupervisor({ gateway, invokeHelper });

		const first = supervisor.start({
			actionId: 'action-start',
			expectedProcessEpoch: null,
			selectedProcessEpoch: 'process-1',
		});
		const second = supervisor.contain({
			actionId: 'action-contain',
			expectedProcessEpoch: 'process-1',
		});
		const secondExpectation = expect(second).rejects.toThrow(/receipt.*action fence/iu);
		await firstInvoked;
		expect(invokeHelper).toHaveBeenCalledOnce();
		releaseFirst?.();
		await expect(first).resolves.toMatchObject({ actionId: 'action-start' });
		await secondExpectation;
		expect(invokeHelper).toHaveBeenCalledTimes(2);
	});
});
