import { describe, expect, it, vi } from 'vitest';

import {
	runToolVmSshOperationWithGuard,
	ToolVmSshOperationStaleError,
} from './tool-vm-ssh-operation-guard.js';

describe('runToolVmSshOperationWithGuard', () => {
	it('reports probe success and returns operation result', async () => {
		const report = vi.fn();
		const publishHealthEvent = vi.fn(async () => {});

		await expect(
			runToolVmSshOperationWithGuard({
				healthEvent: {
					agentId: 'beta',
					leaseId: 'lease-1',
					operation: 'probe',
					publish: publishHealthEvent,
					zoneId: 'sunfam',
				},
				now: () => 1_000,
				operation: async () => 'ok',
				operationName: 'probe',
				report,
				timeoutMs: 30_000,
			}),
		).resolves.toBe('ok');

		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'running',
		});
		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'completed',
			ssh: { probeSucceeded: true },
		});
		expect(publishHealthEvent).toHaveBeenCalledWith({
			agentId: 'beta',
			elapsedMs: 0,
			kind: 'tool-vm-ssh',
			leaseId: 'lease-1',
			observedAtMs: 1_000,
			operation: 'probe',
			result: 'ok',
			zoneId: 'sunfam',
		});
	});

	it('does not wait for successful health publishing before returning operation result', async () => {
		const publishHealthEvent = vi.fn(async () => new Promise<void>(() => {}));

		await expect(
			runToolVmSshOperationWithGuard({
				healthEvent: {
					agentId: 'beta',
					leaseId: 'lease-1',
					operation: 'probe',
					publish: publishHealthEvent,
					zoneId: 'sunfam',
				},
				now: () => 1_000,
				operation: async () => 'ok',
				operationName: 'probe',
				report: vi.fn(),
				timeoutMs: 30_000,
			}),
		).resolves.toBe('ok');
		expect(publishHealthEvent).toHaveBeenCalled();
	});

	it('does not wait for failed health publishing before throwing stale-handle errors', async () => {
		const publishHealthEvent = vi.fn(async () => new Promise<void>(() => {}));

		await expect(
			runToolVmSshOperationWithGuard({
				healthEvent: {
					agentId: 'beta',
					leaseId: 'lease-1',
					operation: 'command',
					publish: publishHealthEvent,
					zoneId: 'sunfam',
				},
				now: () => 1_000,
				operation: async () => {
					throw new Error('kex reset');
				},
				operationName: 'runShellCommand',
				report: vi.fn(),
				timeoutMs: 30_000,
			}),
		).rejects.toMatchObject({
			reason: 'ssh-command-failed',
		});
		expect(publishHealthEvent).toHaveBeenCalled();
	});

	it('converts timeout into a stale-handle error and reports failure', async () => {
		const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
		const setTimeoutImpl = ((callback: () => void) => {
			callback();
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		const report = vi.fn();
		const publishHealthEvent = vi.fn(async () => {});

		await expect(
			runToolVmSshOperationWithGuard({
				clearTimeoutImpl,
				healthEvent: {
					agentId: 'beta',
					leaseId: 'lease-1',
					operation: 'command',
					publish: publishHealthEvent,
					zoneId: 'sunfam',
				},
				now: () => 1_000,
				operation: async () => new Promise<string>(() => {}),
				operationName: 'runShellCommand',
				report,
				setTimeoutImpl,
				timeoutMs: 30_000,
			}),
		).rejects.toMatchObject({
			reason: 'ssh-command-timed-out',
		});

		expect(report).toHaveBeenCalledWith({
			observedAtMs: 1_000,
			phase: 'failed',
			ssh: {
				failure: {
					kind: 'ssh-command-timed-out',
					message: 'runShellCommand exceeded 30000ms.',
				},
			},
		});
		expect(publishHealthEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'beta',
				errorCode: 'ssh-command-timed-out',
				kind: 'tool-vm-ssh',
				leaseId: 'lease-1',
				operation: 'command',
				result: 'failed',
				zoneId: 'sunfam',
			}),
		);
		expect(clearTimeoutImpl).toHaveBeenCalled();
	});

	it('classifies rejected SSH operations as stale-handle failures', async () => {
		await expect(
			runToolVmSshOperationWithGuard({
				now: () => 1_000,
				operation: async () => {
					throw new Error('kex reset');
				},
				operationName: 'fs-bridge',
				report: vi.fn(),
				timeoutMs: 30_000,
			}),
		).rejects.toBeInstanceOf(ToolVmSshOperationStaleError);
	});
});
