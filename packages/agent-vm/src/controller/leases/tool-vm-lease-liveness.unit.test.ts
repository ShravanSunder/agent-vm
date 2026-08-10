import type { ManagedVm } from '@agent-vm/managed-vm';
import { configure, dispose, reset, type LogRecord } from '@logtape/logtape';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagedExecProcessStub } from '../../testing/managed-vm-test-helpers.js';
import { isToolVmLeaseVmLive } from './tool-vm-lease-liveness.js';

const TEST_LEASE_IDENTITY = {
	id: 'lease-1',
	zoneId: 'shravan',
} as const;

const capturedRecords: LogRecord[] = [];

beforeEach(async () => {
	capturedRecords.length = 0;
	vi.useFakeTimers();
	await configure({
		loggers: [
			{
				category: ['agent-vm', 'controller'],
				lowestLevel: 'trace',
				sinks: ['capture'],
			},
		],
		reset: true,
		sinks: {
			capture: (record): void => {
				capturedRecords.push(record);
			},
		},
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await dispose().catch(() => {});
	await reset();
});

describe('isToolVmLeaseVmLive', () => {
	it('returns true when the VM probe exits successfully', async () => {
		// Arrange
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub({ exitCode: 0 }));

		// Act
		const result = await isToolVmLeaseVmLive({ ...TEST_LEASE_IDENTITY, vm: { exec } });

		// Assert
		expect(result).toBe(true);
		expect(exec).toHaveBeenCalledOnce();
		expect(exec).toHaveBeenCalledWith('true', { signal: expect.any(AbortSignal) });
	});

	it('returns false when the VM probe exits unsuccessfully', async () => {
		// Arrange
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub({ exitCode: 23 }));

		// Act
		const result = await isToolVmLeaseVmLive({ ...TEST_LEASE_IDENTITY, vm: { exec } });

		// Assert
		expect(result).toBe(false);
		expect(exec).toHaveBeenCalledOnce();
	});

	it('returns false and emits a scoped warning when the VM probe throws', async () => {
		// Arrange
		const failure = new Error('QEMU monitor disconnected');
		const exec = vi.fn<ManagedVm['exec']>(() => {
			throw failure;
		});

		// Act
		const result = await isToolVmLeaseVmLive({ ...TEST_LEASE_IDENTITY, vm: { exec } });

		// Assert
		expect(result).toBe(false);
		expect(capturedRecords).toHaveLength(1);
		expect(capturedRecords[0]).toMatchObject({
			category: ['agent-vm', 'controller', 'lease'],
			level: 'warning',
			message: ['Controller diagnostic'],
			properties: { event: 'failure', failureClass: 'failure' },
		});
	});

	it('aborts the VM probe and returns false at exactly five seconds', async () => {
		// Arrange
		const neverCompletes = new Promise<void>(() => {});
		let probeSignal: AbortSignal | undefined;
		const exec = vi.fn<ManagedVm['exec']>((_command, options) => {
			probeSignal = options?.signal;
			return createManagedExecProcessStub({ waitFor: neverCompletes });
		});
		let result: boolean | undefined;

		// Act
		const liveness = isToolVmLeaseVmLive({ ...TEST_LEASE_IDENTITY, vm: { exec } }).then((value) => {
			result = value;
			return value;
		});
		await vi.advanceTimersByTimeAsync(4_999);

		// Assert
		expect(result).toBeUndefined();
		expect(probeSignal?.aborted).toBe(false);

		// Act
		await vi.advanceTimersByTimeAsync(1);

		// Assert
		await expect(liveness).resolves.toBe(false);
		expect(result).toBe(false);
		expect(probeSignal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears the timeout when the VM probe completes early', async () => {
		// Arrange
		const exec = vi.fn<ManagedVm['exec']>(() => createManagedExecProcessStub({ exitCode: 0 }));

		// Act
		const liveness = isToolVmLeaseVmLive({ ...TEST_LEASE_IDENTITY, vm: { exec } });

		// Assert
		expect(vi.getTimerCount()).toBe(1);
		await expect(liveness).resolves.toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
