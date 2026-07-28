import { describe, expect, it, vi } from 'vitest';

import { createGatewayZoneDestructionTransaction } from './gateway-zone-destruction-transaction.js';

function createDeferredPromise<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TValue | PromiseLike<TValue>) => void;
} {
	return Promise.withResolvers<TValue>();
}

describe('Gateway zone destruction transaction', () => {
	it('withdraws admission before exact destruction and cleans artifacts afterward', async () => {
		const events: string[] = [];
		const transaction = createGatewayZoneDestructionTransaction({
			destroyExactGateway: async () => {
				events.push('destroy-exact');
			},
			gatewayLabel: 'Gateway VM test',
			postDestructionCleanup: [
				{
					cleanup: async () => {
						events.push('delete-record');
					},
					stage: 'runtime-record-deletion',
				},
			],
			withdrawAdmission: [
				{
					cleanup: async () => {
						events.push('withdraw-ingress');
					},
					stage: 'ingress-withdrawal',
				},
			],
		});

		await expect(transaction.destroyGateway()).resolves.toEqual({ kind: 'destroyed-clean' });
		expect(events).toEqual(['withdraw-ingress', 'destroy-exact', 'delete-record']);
	});

	it('continues exact destruction after withdrawal failure and retries only failed cleanup', async () => {
		const withdrawIngress = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('ingress close failed'))
			.mockResolvedValue(undefined);
		const destroyExactGateway = vi.fn(async () => {});
		const deleteRuntimeRecord = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('record delete failed'))
			.mockResolvedValue(undefined);
		const releaseBootInputs = vi.fn(async () => {});
		const transaction = createGatewayZoneDestructionTransaction({
			destroyExactGateway,
			gatewayLabel: 'Gateway VM test',
			postDestructionCleanup: [
				{ cleanup: deleteRuntimeRecord, stage: 'runtime-record-deletion' },
				{ cleanup: releaseBootInputs, stage: 'managed-boot-input-release' },
			],
			withdrawAdmission: [{ cleanup: withdrawIngress, stage: 'ingress-withdrawal' }],
		});

		await expect(transaction.destroyGateway()).resolves.toMatchObject({
			cleanupFailures: [{ stage: 'ingress-withdrawal' }, { stage: 'runtime-record-deletion' }],
			kind: 'destroyed-cleanup-incomplete',
		});
		await expect(transaction.destroyGateway()).resolves.toEqual({ kind: 'destroyed-clean' });

		expect(destroyExactGateway).toHaveBeenCalledOnce();
		expect(withdrawIngress).toHaveBeenCalledTimes(2);
		expect(deleteRuntimeRecord).toHaveBeenCalledTimes(2);
		expect(releaseBootInputs).toHaveBeenCalledOnce();
	});

	it('coalesces concurrent calls and never repeats successful exact destruction', async () => {
		const destructionCompletion = createDeferredPromise<void>();
		const destroyExactGateway = vi.fn(async () => await destructionCompletion.promise);
		const transaction = createGatewayZoneDestructionTransaction({
			destroyExactGateway,
			gatewayLabel: 'Gateway VM test',
			postDestructionCleanup: [],
			withdrawAdmission: [],
		});

		const first = transaction.destroyGateway();
		const concurrent = transaction.destroyGateway();
		expect(concurrent).toBe(first);
		await Promise.resolve();
		expect(destroyExactGateway).toHaveBeenCalledOnce();

		destructionCompletion.resolve();
		await Promise.all([first, concurrent]);
		await transaction.destroyGateway();
		expect(destroyExactGateway).toHaveBeenCalledOnce();
	});

	it('memoizes an exact destruction failure as owner-unsafe and skips post cleanup', async () => {
		const exactFailure = new Error('exact VM close unproven');
		const destroyExactGateway = vi.fn(async () => {
			throw exactFailure;
		});
		const deleteRuntimeRecord = vi.fn(async () => {});
		const transaction = createGatewayZoneDestructionTransaction({
			destroyExactGateway,
			gatewayLabel: 'Gateway VM test',
			postDestructionCleanup: [{ cleanup: deleteRuntimeRecord, stage: 'runtime-record-deletion' }],
			withdrawAdmission: [],
		});

		await expect(transaction.destroyGateway()).rejects.toBe(exactFailure);
		await expect(transaction.destroyGateway()).rejects.toBe(exactFailure);
		expect(destroyExactGateway).toHaveBeenCalledOnce();
		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
	});

	it('rejects duplicate cleanup stages before exposing a transaction', () => {
		expect(() =>
			createGatewayZoneDestructionTransaction({
				destroyExactGateway: async () => {},
				gatewayLabel: 'Gateway VM test',
				postDestructionCleanup: [{ cleanup: async () => {}, stage: 'runtime-record-deletion' }],
				withdrawAdmission: [{ cleanup: async () => {}, stage: 'runtime-record-deletion' }],
			}),
		).toThrow("Gateway cleanup stage 'runtime-record-deletion' must be unique.");
	});
});
