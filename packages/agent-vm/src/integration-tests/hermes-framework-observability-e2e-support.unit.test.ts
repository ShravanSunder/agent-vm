import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	rejectedCleanupReasons,
	settleCleanupPhases,
	stopObservabilityStack,
	type HermesObservabilityStackProject,
} from './hermes-framework-observability-e2e-support.js';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

const managedObservabilityProject = {
	systemConfig: {
		controllerRuntimeDir: '/tmp/controller-runtime',
		host: {
			observability: {
				enabled: true,
				stack: { mode: 'managed' },
			},
			projectNamespace: 'hermes-observability-test',
		},
	},
} satisfies HermesObservabilityStackProject;

describe('stopObservabilityStack', () => {
	beforeEach(() => {
		execaMock.mockReset();
	});

	it('rejects when Docker reports a failed managed-stack teardown', async () => {
		execaMock.mockResolvedValue({
			failed: true,
			shortMessage: 'Command timed out after 30000 milliseconds',
		});

		await expect(stopObservabilityStack(managedObservabilityProject)).rejects.toThrow(
			'Failed to stop the managed observability stack',
		);
	});
});

describe('rejectedCleanupReasons', () => {
	it('preserves every rejected cleanup reason', () => {
		const firstFailure = new Error('first cleanup failed');
		const secondFailure = new Error('second cleanup failed');

		expect(
			rejectedCleanupReasons([
				{ status: 'fulfilled', value: undefined },
				{ reason: firstFailure, status: 'rejected' },
				{ reason: secondFailure, status: 'rejected' },
			]),
		).toEqual([firstFailure, secondFailure]);
	});
});

describe('settleCleanupPhases', () => {
	it('continues after a phase factory throws synchronously', async () => {
		const phaseFactoryFailure = new Error('phase factory failed');
		const startedPhases: string[] = [];

		const cleanupErrors = await settleCleanupPhases([
			() => {
				startedPhases.push('throwing-phase');
				throw phaseFactoryFailure;
			},
			() => {
				startedPhases.push('following-phase');
				return [Promise.resolve()];
			},
		]);

		expect(startedPhases).toEqual(['throwing-phase', 'following-phase']);
		expect(cleanupErrors).toEqual([phaseFactoryFailure]);
	});

	it('runs phases in order and retains failures from every phase', async () => {
		const startedPhases: string[] = [];
		const harnessFailure = new Error('harness cleanup failed');
		const stackFailure = new Error('stack cleanup failed');
		let rejectHarnessCleanup: ((reason: Error) => void) | undefined;
		const harnessCleanup = new Promise<void>((_resolve, reject) => {
			rejectHarnessCleanup = reject;
		});

		const cleanupResult = settleCleanupPhases([
			() => {
				startedPhases.push('harness');
				return [harnessCleanup];
			},
			() => [
				Promise.resolve().then(() => {
					startedPhases.push('provider');
				}),
				Promise.reject(stackFailure).finally(() => {
					startedPhases.push('stack');
				}),
			],
			() => [
				Promise.resolve().then(() => {
					startedPhases.push('temp-root');
				}),
			],
		]);
		await Promise.resolve();
		expect(startedPhases).toEqual(['harness']);
		if (rejectHarnessCleanup === undefined) {
			throw new Error('Expected the harness cleanup phase to start.');
		}
		rejectHarnessCleanup(harnessFailure);
		const cleanupErrors = await cleanupResult;

		expect(startedPhases).toEqual(['harness', 'provider', 'stack', 'temp-root']);
		expect(cleanupErrors).toEqual([harnessFailure, stackFailure]);
	});
});
