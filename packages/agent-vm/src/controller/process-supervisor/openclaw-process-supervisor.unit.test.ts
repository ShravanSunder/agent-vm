import { describe, expect, it, vi } from 'vitest';

import {
	openClawProcessSupervisorRequestSchema,
	openClawProcessSupervisorReceiptSchema,
	type OpenClawProcessSupervisorReceipt,
} from './openclaw-process-supervisor-contracts.js';
import { createOpenClawProcessSupervisor } from './openclaw-process-supervisor.js';

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
