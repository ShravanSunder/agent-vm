import { describe, expect, it, vi } from 'vitest';

import {
	runToolVmSshOperationWithGuard,
	ToolVmSshOperationStaleError,
} from './tool-vm-ssh-operation-guard.js';

describe('runToolVmSshOperationWithGuard', () => {
	it('reports probe success and returns operation result', async () => {
		const report = vi.fn();

		await expect(
			runToolVmSshOperationWithGuard({
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
	});

	it('converts timeout into a stale-handle error and reports failure', async () => {
		const clearTimeoutImpl = vi.fn() as unknown as typeof clearTimeout;
		const setTimeoutImpl = ((callback: () => void) => {
			callback();
			return 1 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		const report = vi.fn();

		await expect(
			runToolVmSshOperationWithGuard({
				clearTimeoutImpl,
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
